import { AUTONOMY_LABELS, WORK_MODE_LABELS } from '../core/types';
import { newId } from '../utils/ids';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  AgentSession,
  StartAgentInput,
} from './AgentAdapter';

/** Intervalo entre pedaços do streaming simulado. Curto o suficiente para não travar a UI. */
const CHUNK_DELAY_MS = 22;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aproximação grosseira de tokens; só o adaptador real sabe o número certo. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** Divide o texto preservando os espaços, para o streaming parecer natural. */
function toChunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

/**
 * Adaptador simulado. Existe para validar toda a cadeia chat → core → agente sem
 * depender de nenhuma CLI externa. Os adaptadores reais implementarão a mesma
 * interface e podem substituí-lo sem mudanças na interface.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly displayName = 'Mock Agent';
  readonly transport = 'mock' as const;
  readonly capabilities: AgentCapabilities = {
    chat: true,
    edit: false,
    delegate: true,
    terminal: false,
  };

  private readonly sessions = new Map<string, { cancelled: boolean }>();

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  start(_input: StartAgentInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: newId('mock-session'),
      agentId: this.id,
      startedAt: Date.now(),
    };
    this.sessions.set(session.id, { cancelled: false });
    return Promise.resolve(session);
  }

  async *send(sessionId: string, message: AgentInput): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      yield {
        type: 'failed',
        error: { name: 'UnknownSessionError', message: `Sessão desconhecida: ${sessionId}` },
      };
      return;
    }

    session.cancelled = false;
    yield { type: 'status', status: 'working' };

    const images = message.attachments?.length ?? 0;
    const reply =
      `Prometheon está funcionando. Recebi sua mensagem no modo ` +
      `${WORK_MODE_LABELS[message.workMode]}, com autonomia ` +
      `${AUTONOMY_LABELS[message.autonomy]}.` +
      (images === 0 ? '' : ` Vieram ${images} imagem(ns) anexada(s).`);

    let emitted = '';
    for (const chunk of toChunks(reply)) {
      await delay(CHUNK_DELAY_MS);
      if (session.cancelled) {
        yield { type: 'cancelled' };
        yield { type: 'status', status: 'stopped' };
        return;
      }
      emitted += chunk;
      yield { type: 'delta', text: chunk };
    }

    // Sem CLI real não há contagem verdadeira: estimamos por caracteres, só para
    // a interface de uso ter o que exibir enquanto os adaptadores não chegam.
    yield {
      type: 'completed',
      text: emitted,
      usage: {
        input: estimateTokens(message.content) + (message.attachments?.length ?? 0) * 800,
        output: estimateTokens(emitted),
      },
    };
    yield { type: 'status', status: 'completed' };
  }

  interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.cancelled = true;
    }
    return Promise.resolve();
  }

  dispose(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }
}
