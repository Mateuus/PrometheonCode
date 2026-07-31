'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Ditado por voz: microfone de um lado, texto crescendo do outro.
 *
 * O ciclo tem quatro passos, e a ordem importa. O bilhete é pedido primeiro
 * porque é o que pode falhar por motivo administrativo — sessão expirada, teto
 * de uso — e falhar antes de abrir o microfone evita pedir permissão para
 * depois não ter o que fazer com ela. O microfone vem em seguida, o socket
 * depois, e só então o áudio começa a fluir.
 *
 * ## Por que o texto é reescrito, e não acrescentado
 *
 * O serviço manda `partial` a cada revisão e `final` quando a pausa fecha o
 * enunciado. Um `partial` **substitui** o anterior em vez de continuá-lo,
 * porque o modelo reconsidera o que já tinha ouvido à luz do que veio depois:
 * "ele" vira "eles" quando o plural chega três palavras adiante. Tratar as
 * revisões como acréscimo congelaria cada engano no lugar.
 *
 * Os enunciados finalizados são guardados por índice e nunca mais mudam. O que
 * varia é só a cauda.
 */

export type DictationStatus = 'idle' | 'starting' | 'listening' | 'stopping';

export type DictationError =
  | 'permission-denied'
  | 'no-microphone'
  | 'unsupported'
  | 'ticket-failed'
  | 'connection-failed'
  | 'service-unavailable';

interface Ticket {
  readonly token: string;
  readonly url: string;
  readonly sampleRate: number;
  readonly language: string;
  readonly maxSessionMs: number;
}

interface UpstreamEvent {
  readonly type: string;
  readonly utterance?: number;
  readonly text?: string;
  readonly active?: boolean;
  readonly code?: string;
}

export interface LiveTranscription {
  readonly status: DictationStatus;
  readonly error: DictationError | undefined;
  /** Texto da sessão corrente: enunciados fechados mais a revisão em curso. */
  readonly transcript: string;
  /** Se há voz sendo detectada agora — alimenta o indicador visual. */
  readonly speaking: boolean;
  readonly supported: boolean;
  start(): void;
  stop(): void;
}

/**
 * Se este navegador consegue capturar áudio.
 *
 * Vai por `useSyncExternalStore` porque a resposta difere entre servidor e
 * cliente: no servidor não existe `navigator`, e o React precisa saber disso ao
 * hidratar em vez de descobrir num efeito depois. A "assinatura" não assina
 * nada — a capacidade do navegador não muda durante a vida da página.
 */
const subscribeToNothing = (): (() => void) => () => undefined;

function isDictationSupported(): boolean {
  return typeof window.AudioContext === 'function' && navigator.mediaDevices !== undefined;
}

/** Junta enunciados fechados e a revisão corrente num texto só. */
function composeTranscript(finals: Map<number, string>, partial: string): string {
  const ordered = [...finals.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);

  if (partial !== '') {
    ordered.push(partial);
  }

  return ordered.join(' ');
}

function classifyMediaError(error: unknown): DictationError {
  if (error instanceof DOMException) {
    // `NotAllowedError` é a recusa explícita; `SecurityError` aparece quando a
    // página não está em contexto seguro, e para quem usa dá no mesmo: o
    // microfone não abre.
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'permission-denied';
    }

    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'no-microphone';
    }
  }

  return 'unsupported';
}

export function useLiveTranscription(): LiveTranscription {
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [error, setError] = useState<DictationError | undefined>(undefined);
  const [transcript, setTranscript] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const supported = useSyncExternalStore(subscribeToNothing, isDictationSupported, () => false);

  const socketRef = useRef<WebSocket | undefined>(undefined);
  const contextRef = useRef<AudioContext | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const finalsRef = useRef<Map<number, string>>(new Map());
  const partialRef = useRef('');
  // Marca a sessão. Um `stop()` seguido de `start()` rápido deixa retornos de
  // rede da sessão anterior a caminho; sem esta comparação eles escreveriam
  // texto velho no meio do ditado novo.
  const runRef = useRef(0);

  /** Desmonta tudo o que a sessão abriu, em ordem inversa à abertura. */
  const teardown = useCallback((): void => {
    // As faixas primeiro: é o que mantém o indicador de microfone aceso na aba,
    // e deixá-lo ligado depois do fim do ditado é o tipo de coisa que faz uma
    // pessoa desconfiar do produto inteiro.
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = undefined;

    void contextRef.current?.close().catch(() => {
      // Fechar um contexto já encerrado rejeita. Não há o que fazer, e não há
      // o que dizer a quem usa.
    });
    contextRef.current = undefined;

    const socket = socketRef.current;
    socketRef.current = undefined;

    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }, []);

  const stop = useCallback((): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      teardown();
      setStatus('idle');
      setSpeaking(false);

      return;
    }

    // Para o microfone já, mas mantém o socket: o `stop` faz o serviço fechar o
    // enunciado em aberto e mandar o `final`. Derrubar a conexão aqui perderia
    // exatamente a última frase — a que a pessoa acabou de dizer.
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = undefined;

    setStatus('stopping');
    setSpeaking(false);
    socket.send(JSON.stringify({ type: 'stop' }));
  }, [teardown]);

  const start = useCallback((): void => {
    if (status !== 'idle') {
      return;
    }

    const run = runRef.current + 1;
    runRef.current = run;

    finalsRef.current = new Map();
    partialRef.current = '';
    setTranscript('');
    setError(undefined);
    setStatus('starting');

    const fail = (reason: DictationError): void => {
      if (runRef.current !== run) {
        return;
      }

      teardown();
      setError(reason);
      setStatus('idle');
      setSpeaking(false);
    };

    void (async () => {
      let ticket: Ticket;

      try {
        const response = await fetch('/api/transcription/ticket', { cache: 'no-store' });

        if (!response.ok) {
          fail(response.status === 503 ? 'service-unavailable' : 'ticket-failed');

          return;
        }

        ticket = (await response.json()) as Ticket;
      } catch {
        fail('ticket-failed');

        return;
      }

      if (runRef.current !== run) {
        return;
      }

      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // O navegador faz esses três muito melhor do que daria para fazer
            // depois: ele tem acesso ao sinal de referência do alto-falante,
            // que é o que permite cancelar o eco de verdade.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (mediaError) {
        fail(classifyMediaError(mediaError));

        return;
      }

      if (runRef.current !== run) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });

        return;
      }

      streamRef.current = stream;

      let context: AudioContext;

      try {
        // Pedir 16 kHz aqui poupa a reamostragem: quando o navegador atende, o
        // worklet só converte o formato. Quando ignora — e alguns ignoram —, o
        // worklet reamostra por conta própria.
        context = new AudioContext({ sampleRate: ticket.sampleRate });
        await context.audioWorklet.addModule('/audio/pcm-recorder.worklet.js');
      } catch {
        fail('unsupported');

        return;
      }

      if (runRef.current !== run) {
        void context.close().catch(() => undefined);

        return;
      }

      contextRef.current = context;

      const socket = new WebSocket(
        `${ticket.url}?ticket=${encodeURIComponent(ticket.token)}&language=${encodeURIComponent(ticket.language)}`,
      );
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        if (runRef.current !== run) {
          return;
        }

        let payload: UpstreamEvent;

        try {
          payload = JSON.parse(event.data) as UpstreamEvent;
        } catch {
          return;
        }

        if (payload.type === 'speech') {
          setSpeaking(payload.active === true);

          return;
        }

        if (payload.type === 'partial' && typeof payload.text === 'string') {
          partialRef.current = payload.text;
          setTranscript(composeTranscript(finalsRef.current, partialRef.current));

          return;
        }

        if (
          payload.type === 'final' &&
          typeof payload.text === 'string' &&
          typeof payload.utterance === 'number'
        ) {
          finalsRef.current.set(payload.utterance, payload.text);
          // A revisão pendente descreve o enunciado que acabou de fechar; o
          // texto dela já está no `final`, mais completo.
          partialRef.current = '';
          setTranscript(composeTranscript(finalsRef.current, ''));

          return;
        }

        if (payload.type === 'error') {
          fail(payload.code === 'TOO_MANY_SESSIONS' ? 'service-unavailable' : 'connection-failed');
        }
      });

      socket.addEventListener('error', () => {
        fail('connection-failed');
      });

      socket.addEventListener('close', () => {
        if (runRef.current !== run) {
          return;
        }

        teardown();
        setStatus('idle');
        setSpeaking(false);
      });

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          resolve();
        });
        socket.addEventListener('close', () => {
          reject(new Error('closed before open'));
        });
      }).catch(() => undefined);

      if (runRef.current !== run || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const source = context.createMediaStreamSource(stream);
      const recorder = new AudioWorkletNode(context, 'pcm-recorder');

      recorder.port.onmessage = (event: MessageEvent<Int16Array<ArrayBuffer>>) => {
        if (socket.readyState === WebSocket.OPEN) {
          // O `buffer`, não a visão tipada: `send` aceita `BufferSource`, e o
          // worklet já manda uma cópia com memória própria — não há risco de
          // ela ser reescrita antes de sair pela rede.
          socket.send(event.data.buffer);
        }
      };

      source.connect(recorder);
      // O worklet não produz saída, mas sem um destino o grafo não é agendado
      // em parte dos navegadores e `process` nunca é chamado. Ligar ao destino
      // real não devolve áudio nenhum ao alto-falante — não há o que tocar.
      recorder.connect(context.destination);

      setStatus('listening');

      // Encerra sozinho no teto que a API anunciou, em vez de esperar o
      // servidor cortar: assim o microfone fecha junto e a pessoa vê o botão
      // voltar ao normal, em vez de um socket que morre em silêncio.
      window.setTimeout(() => {
        if (runRef.current === run) {
          stop();
        }
      }, ticket.maxSessionMs);
    })();
  }, [status, stop, teardown]);

  // Sair da página no meio do ditado não pode deixar o microfone aberto.
  useEffect(() => {
    return () => {
      runRef.current += 1;
      teardown();
    };
  }, [teardown]);

  return { status, error, transcript, speaking, supported, start, stop };
}
