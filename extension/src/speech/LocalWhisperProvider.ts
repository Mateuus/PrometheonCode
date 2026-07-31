import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import * as vscode from 'vscode';

import { t } from '../i18n';
import type { Logger } from '../logger';
import { SpeechNotConfiguredError } from '../utils/errors';
import type { SpeechProvider } from './types';

/**
 * Ditado local: o áudio nunca sai da máquina.
 *
 * O motor é um processo Python filho, falando JSON por linha em stdin/stdout —
 * o mesmo transporte que os adaptadores de agente já usam. Não há porta de
 * rede, e por isso não há a pergunta "quem mais nesta rede alcança o meu
 * microfone?": não há com o que falar.
 *
 * ## Por que local, e não um serviço
 *
 * A primeira versão disto vivia no Hub, com o áudio subindo por WebSocket até
 * um servidor que transcrevia. Funcionava — e era inutilizável. Medido com o
 * mesmo áudio de 42 s:
 *
 *     Servidor (Xeon E5-2699 v3, 16 núcleos, sem GPU) : 20 s de atraso, 0 revisões
 *     Estação de trabalho (RTX 2060 SUPER, float16)   : 0,7 s de atraso, 76 revisões
 *
 * A diferença não é de grau. Sem GPU a fila de inferência nunca esvazia,
 * nenhuma revisão chega a ser publicada, e o texto simplesmente não aparece
 * durante a fala — que era o ponto. Máquina de quem programa tem placa de
 * vídeo; servidor compartilhado, quase nunca.
 *
 * O ganho de privacidade veio junto e vale por si: ditar uma mensagem de
 * trabalho é falar sobre código, clientes e decisões internas.
 *
 * ## O ambiente Python
 *
 * O motor precisa de `faster-whisper`, `sounddevice` e `webrtcvad`. Instalá-los
 * no Python do sistema seria invadir um ambiente que não é nosso, então a
 * extensão mantém um ambiente virtual próprio no armazenamento global dela e
 * instala ali. Não usa `torch`: o CTranslate2 por baixo do `faster-whisper`
 * dispensa, e isso é a diferença entre algumas centenas de megabytes e vários
 * gigabytes.
 */

/** Eventos que o processo Python publica. */
interface EngineEvent {
  readonly type: string;
  readonly text?: string;
  readonly active?: boolean;
  readonly model?: string;
  readonly device?: string;
  readonly compute?: string;
  readonly vramGb?: number;
  readonly code?: string;
  readonly message?: string;
}

/**
 * Espera máxima pelo texto final depois do `stop`.
 *
 * Generoso de propósito: numa máquina sem GPU o motor ainda está transcrevendo
 * quando a pessoa para de falar, e desistir cedo jogaria fora justamente a
 * última frase — a que ela acabou de dizer.
 */
const STOP_TIMEOUT_MS = 120_000;

/** Espera pelo `ready` na subida, que inclui carregar os pesos do modelo. */
const READY_TIMEOUT_MS = 180_000;

/**
 * Vocabulário do projeto, entregue ao modelo como contexto.
 *
 * Ditado de trabalho é cheio de palavra que não existe em português corrente:
 * nomes de biblioteca, de arquivo, de função. Sem contexto o modelo escolhe a
 * palavra comum mais parecida — "Fastify" vira "faz tipo", "webview" vira "web
 * viu" — e a correção manual custa mais que ter digitado.
 *
 * A fonte é o que está aberto no editor. É barato, não depende de indexar nada,
 * e acerta o alvo: quem dita está falando sobre o que está vendo.
 */
function buildVocabulary(): string {
  const names = new Set<string>();

  for (const editor of vscode.window.visibleTextEditors) {
    const file = editor.document.uri.path.split('/').pop();

    if (file !== undefined && file !== '') {
      names.add(file);
    }
  }

  const folder = vscode.workspace.workspaceFolders?.[0]?.name;
  if (folder !== undefined) {
    names.add(folder);
  }

  if (names.size === 0) {
    return '';
  }

  // O `initial_prompt` compete com o áudio pela janela de contexto do modelo:
  // um prompt longo demais degrada a transcrição em vez de melhorá-la.
  return [...names].slice(0, 40).join(', ');
}

export interface LocalWhisperOptions {
  /**
   * Resolve o Python do ambiente, preparando-o na primeira vez.
   *
   * É função e não caminho pronto porque a preparação baixa centenas de
   * megabytes: fazê-la ao ativar a extensão custaria isso a quem nunca vai
   * ditar. Assim ela acontece no primeiro clique no microfone, com barra de
   * progresso, e devolve `null` se não der.
   */
  resolvePython(): Promise<string | null>;
  /**
   * Se o ditado é utilizável nesta máquina — sem preparar nada.
   *
   * Existe separado de `resolvePython` porque a interface pergunta pela
   * disponibilidade sempre que o painel muda de estado, e responder a isso
   * baixando centenas de megabytes seria transformar a abertura do painel num
   * download que ninguém pediu. Aqui só se olha: o ambiente já existe, ou há
   * um Python capaz de criá-lo?
   */
  canUse(): Promise<boolean>;
  /** Caminho do `prometheon_speech.py` empacotado com a extensão. */
  readonly scriptPath: string;
  /** Idioma do ditado; `auto` deixa o modelo detectar. */
  readonly language: () => string;
}

export class LocalWhisperProvider implements SpeechProvider, vscode.Disposable {
  readonly id = 'local-whisper';
  readonly displayName = 'Whisper local';

  private process: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private readonly partial = new vscode.EventEmitter<string>();

  /** Enunciados já fechados nesta sessão. A revisão corrente é a cauda. */
  private finals: string[] = [];
  private currentPartial = '';

  private ready = false;
  private readyWaiters: Array<(ok: boolean) => void> = [];
  private stopWaiter: ((text: string | null) => void) | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private description = '';
  /** Último motivo de indisponibilidade, para a interface mostrar em vez de um genérico. */
  private issue: string | undefined;

  constructor(
    private readonly options: LocalWhisperOptions,
    private readonly logger: Logger,
  ) {}

  onPartial(listener: (text: string) => void): vscode.Disposable {
    return this.partial.event(listener);
  }

  /** O que o motor escolheu ao subir, para a interface e o diagnóstico. */
  get engineDescription(): string {
    return this.description;
  }

  /**
   * Responde se dá para ditar, **sem** preparar o ambiente nem subir o motor.
   *
   * A interface chama isto a cada mudança de estado do painel. Se aqui
   * acontecesse a preparação, abrir o painel dispararia um download de
   * centenas de megabytes — e a resposta demoraria o tempo dele.
   */
  async isAvailable(): Promise<boolean> {
    if (this.process !== null && this.ready) {
      this.issue = undefined;

      return true;
    }

    try {
      const usable = await this.options.canUse();

      this.issue = usable ? undefined : t('Dictation needs Python 3.9 or newer on this machine.');

      return usable;
    } catch (error) {
      this.issue = `${t('The dictation engine could not be checked.')} ${String(error)}`;
      this.logger.warn(`Motor de ditado local indisponível: ${String(error)}`);

      return false;
    }
  }

  unavailableReason(): string | undefined {
    return this.issue;
  }

  async start(): Promise<void> {
    await this.ensureProcess();

    if (!this.ready) {
      throw new SpeechNotConfiguredError('O motor de ditado local não subiu.');
    }

    this.finals = [];
    this.currentPartial = '';
    this.send({
      type: 'start',
      language: this.options.language(),
      vocabulary: buildVocabulary(),
    });
  }

  async stop(): Promise<string | null> {
    if (this.process === null) {
      return null;
    }

    // O motor ainda tem áudio para transcrever quando o `stop` chega — a última
    // frase inteira, no caso comum. Esperar por ela é o que diferencia entregar
    // o texto de perdê-lo.
    const settled = new Promise<string | null>((resolve) => {
      this.stopWaiter = resolve;
      this.stopTimer = setTimeout(() => {
        this.logger.warn('Ditado: o motor não respondeu ao encerrar; devolvendo o que já havia.');
        this.settleStop(this.compose());
      }, STOP_TIMEOUT_MS);
    });

    this.send({ type: 'stop' });

    return settled;
  }

  async cancel(): Promise<void> {
    if (this.process === null) {
      return;
    }

    this.send({ type: 'cancel' });
    // Quem estava esperando pelo texto recebe o fim aqui: sem isto, um `cancel`
    // no meio de um `stop` deixaria a promessa pendurada até o tempo limite.
    this.settleStop(null);
    this.finals = [];
    this.currentPartial = '';
  }

  dispose(): void {
    this.settleStop(null);
    this.partial.dispose();

    if (this.process !== null) {
      this.send({ type: 'shutdown' });
      // O processo sai sozinho ao ler `shutdown`. O `kill` é a rede de
      // segurança para quando ele já não está lendo stdin.
      const child = this.process;
      setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
      }, 2_000);
    }

    this.reader?.close();
    this.reader = null;
    this.process = null;
    this.ready = false;
  }

  // -- processo ------------------------------------------------------------

  private async ensureProcess(): Promise<void> {
    if (this.process !== null && this.ready) {
      return;
    }

    if (this.process !== null) {
      // Subindo: espera o mesmo `ready` em vez de abrir um segundo processo e
      // carregar os pesos do modelo duas vezes na memória.
      await new Promise<boolean>((resolve) => this.readyWaiters.push(resolve));

      return;
    }

    const python = await this.options.resolvePython();

    if (python === null) {
      throw new SpeechNotConfiguredError('O ambiente Python do ditado não está pronto.');
    }

    this.logger.info('Ditado: subindo o motor local.');

    const child = spawn(python, ['-u', this.options.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // `-u` acima e esta variável dizem a mesma coisa por dois caminhos: sem
      // saída sem buffer, os eventos chegariam em blocos e o texto pareceria
      // travado mesmo com o motor respondendo.
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // O Python no Windows escreve na página de código do sistema (cp1252
        // aqui), e "você está" chegaria como "voc� est�" — transcrição correta
        // corrompida no caminho. O motor também se protege disso do lado dele;
        // esta variável cobre o que sair antes de o script assumir o controle.
        PYTHONIOENCODING: 'utf-8',
      },
    });

    // Sem isto o `readline` entrega Buffer decodificado pelo padrão do sistema,
    // desfazendo do lado de cá o mesmo que a variável acima evita do lado de lá.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    this.process = child;

    // Já é string: o `setEncoding` acima decodificou.
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text !== '') {
        this.logger.info(`Ditado (motor): ${text}`);
      }
    });

    child.once('exit', (code) => {
      this.logger.info(`Ditado: o motor encerrou com código ${String(code)}.`);
      this.settleStop(this.compose());
      this.resolveReady(false);
      this.reader?.close();
      this.reader = null;
      this.process = null;
      this.ready = false;
    });

    child.once('error', (error) => {
      this.logger.error(`Ditado: falha ao executar o motor: ${error.message}`);
      this.resolveReady(false);
      this.process = null;
      this.ready = false;
    });

    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => {
      this.handleLine(line);
    });

    const ready = await Promise.race([
      new Promise<boolean>((resolve) => this.readyWaiters.push(resolve)),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READY_TIMEOUT_MS)),
    ]);

    if (!ready) {
      this.logger.warn('Ditado: o motor não ficou pronto a tempo.');
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }

    let event: EngineEvent;

    try {
      event = JSON.parse(trimmed) as EngineEvent;
    } catch {
      // Saída que não é do protocolo: aviso de biblioteca, traceback parcial.
      // Vai para o log em vez de derrubar a sessão.
      this.logger.info(`Ditado (motor): ${trimmed}`);

      return;
    }

    switch (event.type) {
      case 'ready':
        this.ready = true;
        this.description = `${event.model ?? '?'} em ${event.device ?? '?'}/${event.compute ?? '?'}`;
        this.logger.info(`Ditado: motor pronto — ${this.description}.`);
        this.resolveReady(true);

        return;

      case 'partial':
        if (typeof event.text === 'string') {
          this.currentPartial = event.text;
          this.partial.fire(this.compose());
        }

        return;

      case 'final':
        if (typeof event.text === 'string' && event.text !== '') {
          this.finals.push(event.text);
        }
        // A revisão pendente descrevia o enunciado que acabou de fechar; o
        // texto dela já está no `final`, mais completo.
        this.currentPartial = '';
        this.partial.fire(this.compose());

        return;

      case 'stopped':
        // O motor terminou de publicar o que tinha. É este evento que conclui
        // o `stop`; sem ele, cada ditado esperaria o tempo limite para saber
        // que já tinha o texto todo.
        this.settleStop(this.compose());

        return;

      case 'cancelled':
        this.settleStop(null);

        return;

      case 'listening':
      case 'speech':
        return;

      case 'error':
        this.logger.error(`Ditado (motor): ${event.code ?? 'ERRO'} — ${event.message ?? ''}`);

        // Sem dependências não há como seguir, e o processo vai sair. Liberar
        // quem espera agora evita a interface presa até o tempo limite.
        if (event.code === 'DEPENDENCIES_MISSING' || event.code === 'MODEL_LOAD_FAILED') {
          this.resolveReady(false);
        }

        return;

      default:
        return;
    }
  }

  /**
   * Junta os enunciados fechados e a revisão corrente.
   *
   * O motor publica um enunciado por vez; o campo de texto quer a fala inteira.
   */
  private compose(): string {
    const parts = [...this.finals];

    if (this.currentPartial !== '') {
      parts.push(this.currentPartial);
    }

    return parts.join(' ').trim();
  }

  private resolveReady(ok: boolean): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) {
      waiter(ok);
    }
  }

  /**
   * Conclui o `stop` pendente, se houver.
   *
   * Chamado tanto pelo caminho normal quanto pela saída do processo e pelo
   * `cancel` — qualquer um deles precisa liberar quem espera, senão a interface
   * fica em "transcrevendo" para sempre.
   */
  private settleStop(text: string | null): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    const waiter = this.stopWaiter;
    if (waiter === null) {
      return;
    }

    this.stopWaiter = null;
    waiter(text === null || text.trim() === '' ? null : text.trim());
  }

  private send(command: Record<string, unknown>): void {
    if (this.process === null || this.process.stdin.destroyed) {
      return;
    }

    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }
}
