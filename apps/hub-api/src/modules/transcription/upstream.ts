/**
 * Conexão com o serviço de transcrição (a API do Applio).
 *
 * Todo o tráfego de voz passa por aqui, e é de propósito que o navegador nunca
 * fale direto com o Applio: ele não sabe quem é o usuário, a que organização
 * pertence nem que plano contratou, e a chave dele não pode sair do servidor.
 * O Hub é quem autoriza; este módulo é só o transporte.
 */

import { WebSocket } from 'ws';

import { TRANSCRIPTION_SETTINGS } from './settings.js';

/** Estado do serviço, como o `/health` do Applio o descreve. */
export interface UpstreamHealth {
  readonly reachable: boolean;
  /** O serviço tem o fluxo ao vivo habilitado. */
  readonly enabled: boolean;
  /** Os pesos do modelo já estão na memória. */
  readonly ready: boolean;
  readonly model: string | undefined;
  readonly device: string | undefined;
}

const UNREACHABLE: UpstreamHealth = {
  reachable: false,
  enabled: false,
  ready: false,
  model: undefined,
  device: undefined,
};

/** `http(s)://…` vira `ws(s)://…/ws/transcribe`. */
export function upstreamSocketUrl(baseUrl: string): string {
  const url = new URL('/ws/transcribe', baseUrl);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.toString();
}

/**
 * Consulta a saúde do serviço.
 *
 * `ready` é conferido separado de `reachable` porque o Applio responde ao HTTP
 * muito antes de os pesos estarem carregados — pode levar dezenas de segundos.
 * Anunciar o ditado como disponível nessa janela poria o microfone na tela
 * antes de ele funcionar.
 */
export async function checkUpstreamHealth(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<UpstreamHealth> {
  const headers: Record<string, string> = {};

  if (apiKey !== undefined) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(new URL('/health', baseUrl), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return UNREACHABLE;
    }

    const body = (await response.json()) as {
      streaming?: { enabled?: boolean; ready?: boolean; model?: string; device?: string };
    };

    // Um Applio anterior a este trabalho responde `healthy` sem a seção
    // `streaming`. Tratá-lo como indisponível é o correto: ele não tem o
    // endpoint de fluxo ao vivo, e prometer o contrário só adia a falha.
    const streaming = body.streaming;

    if (streaming === undefined) {
      return { ...UNREACHABLE, reachable: true };
    }

    return {
      reachable: true,
      enabled: streaming.enabled === true,
      ready: streaming.ready === true,
      model: streaming.model,
      device: streaming.device,
    };
  } catch {
    return UNREACHABLE;
  }
}

/**
 * Abre a conexão com o serviço e espera até ela estar pronta para receber áudio.
 *
 * Diferente do navegador, aqui a chave viaja em cabeçalho — é uma chamada de
 * servidor para servidor, e não há motivo para pô-la na URL, onde acabaria em
 * log de proxy.
 */
export async function connectUpstream(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<WebSocket> {
  const headers: Record<string, string> = {};

  if (apiKey !== undefined) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  const socket = new WebSocket(upstreamSocketUrl(baseUrl), { headers });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // `terminate` e não `close`: o handshake não completou, e um fechamento
      // limpo espera por uma resposta que, por definição, não veio.
      socket.terminate();
      reject(new Error('upstream connect timeout'));
    }, TRANSCRIPTION_SETTINGS.upstreamConnectTimeoutMs);

    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return socket;
}
