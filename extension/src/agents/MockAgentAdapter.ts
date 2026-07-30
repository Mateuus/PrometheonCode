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

/** Pausa entre um passo simulado e o próximo, para o bloco em andamento aparecer. */
const STEP_DELAY_MS = 260;

/**
 * Roteiro dos passos simulados. Nada aqui executa ferramenta nenhuma: são
 * strings fixas, escritas só para a timeline do chat ter o que desenhar
 * enquanto os adaptadores reais (Claude Code, Codex CLI…) não existem.
 */
const SIMULATED_STEPS: readonly {
  readonly tool: string;
  readonly title: string;
  readonly detail: string;
  readonly output: string;
}[] = [
  {
    tool: 'Read',
    title: 'AgentAdapter.ts',
    detail: '66 lines',
    output: [
      'export type AgentEvent =',
      "  | { readonly type: 'status'; readonly status: ActiveAgentStatus }",
      "  | { readonly type: 'delta'; readonly text: string }",
      "  | { readonly type: 'completed'; readonly text: string }",
    ].join('\n'),
  },
  {
    tool: 'Write',
    title: 'ProviderProfileService.ts',
    detail: '147 lines',
    output: [
      'export class ProviderProfileService {',
      '  constructor(private readonly store: ProfileStore) {}',
      '',
      '  async create(input: CreateProfileInput): Promise<ProviderProfile> {',
      '    const profile = {',
      "      id: newId('profile'),",
      '      providerId: input.providerId,',
      '      configDirectory: this.directoryFor(input),',
      '    };',
      '    await this.store.upsert(profile);',
      '    return profile;',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    tool: 'Bash',
    title: 'Run verification',
    detail: 'npm run verify',
    output: [
      '> prometheon-code@0.0.1 verify',
      '> npm run check-types && npm run lint && npm test',
      '',
      '  Chat',
      '    ✔ os passos do agente chegam na ordem',
      '    ✔ os passos sobrevivem ao reload da conversa',
      '',
      '  12 passing (1.4s)',
    ].join('\n'),
  },
];

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

    // Sequência simulada: um raciocínio e três ferramentas, para a timeline do
    // chat funcionar sem nenhuma CLI instalada. Nada é lido nem executado.
    yield { type: 'thought', durationMs: 3200 };

    for (const [index, step] of SIMULATED_STEPS.entries()) {
      await delay(STEP_DELAY_MS);
      if (session.cancelled) {
        yield { type: 'cancelled' };
        yield { type: 'status', status: 'stopped' };
        return;
      }
      const toolId = `${sessionId}-tool-${index}`;
      yield {
        type: 'tool.requested',
        toolId,
        tool: step.tool,
        title: step.title,
        detail: step.detail,
      };
      await delay(STEP_DELAY_MS);
      if (session.cancelled) {
        yield { type: 'tool.completed', toolId, failed: true };
        yield { type: 'cancelled' };
        yield { type: 'status', status: 'stopped' };
        return;
      }
      yield { type: 'tool.completed', toolId, output: step.output };
    }

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
