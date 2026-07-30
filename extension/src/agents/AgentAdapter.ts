import type { ImageAttachment } from '../chat/types';
import type { TokenUsage } from '../providers/UsageTracker';
import type {
  ActiveAgentStatus,
  Autonomy,
  SerializedError,
  WorkMode,
} from '../core/types';
import type { AgentQuestionOutcome, AgentQuestionRequest } from './questions';

export type AgentTransport = 'cli' | 'api' | 'mock';

export interface AgentCapabilities {
  readonly chat: boolean;
  readonly edit: boolean;
  /** Pode delegar trabalho a workers (necessário para o modo Agent Team). */
  readonly delegate: boolean;
  readonly terminal: boolean;
}

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly startedAt: number;
}

export interface StartAgentInput {
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  /** Caminho da pasta de trabalho, quando houver workspace aberto. */
  readonly workspaceFolder?: string;
  readonly role?: 'main' | 'worker';
  readonly task?: string;
}

export interface AgentInput {
  readonly content: string;
  /** Imagens enviadas junto da mensagem. Adaptadores sem suporte devem ignorá-las. */
  readonly attachments?: readonly ImageAttachment[];
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
}

export type AgentEvent =
  | { readonly type: 'status'; readonly status: ActiveAgentStatus }
  | { readonly type: 'delta'; readonly text: string }
  /**
   * Ferramenta começou. `toolId` liga este evento ao `tool.completed`
   * correspondente — é o que permite à interface desenhar o bloco em andamento
   * antes de a ferramenta terminar. `tool` é o nome exibido em destaque
   * ("Write", "Bash"), `title` é o alvo ("ProviderProfileService.ts") e
   * `detail` a linha de apoio ("147 lines", o comando executado).
   */
  | {
      readonly type: 'tool.requested';
      readonly toolId: string;
      readonly tool: string;
      readonly title: string;
      readonly detail?: string;
    }
  /** Ferramenta terminou. `detail` substitui o que veio no início, quando dado. */
  | {
      readonly type: 'tool.completed';
      readonly toolId: string;
      readonly output?: string;
      readonly detail?: string;
      readonly failed?: boolean;
    }
  /** Raciocínio já concluído, exibido como "Thought for 3s". */
  | { readonly type: 'thought'; readonly durationMs: number }
  /**
   * O agente parou para perguntar. O run só continua quando a resposta chega
   * por `answer` — nada é decidido no lugar do usuário. Só um pedido pode ficar
   * aberto por sessão.
   *
   * Quem emite isto precisa estar pronto para receber a resposta **antes** de
   * emitir: a espera se arma primeiro, o evento sai depois. Consumidor nenhum é
   * obrigado a esperar um instante antes de responder.
   */
  | { readonly type: 'question.asked'; readonly request: AgentQuestionRequest }
  /** O pedido acima foi resolvido: respondido, cancelado ou abandonado. */
  | {
      readonly type: 'question.answered';
      readonly requestId: string;
      readonly outcome: AgentQuestionOutcome;
    }
  /** `usage` vem do CLI quando ele reporta; adaptadores sem isso omitem. */
  | { readonly type: 'completed'; readonly text: string; readonly usage?: TokenUsage }
  | { readonly type: 'failed'; readonly error: SerializedError }
  | { readonly type: 'cancelled' };

/**
 * Contrato de qualquer agente controlado pelo Prometheon. Adaptadores reais
 * (Claude Code, Codex CLI, Gemini CLI…) implementarão esta mesma interface.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly transport: AgentTransport;
  readonly capabilities: AgentCapabilities;

  isAvailable(): Promise<boolean>;
  start(input: StartAgentInput): Promise<AgentSession>;
  send(sessionId: string, message: AgentInput): AsyncIterable<AgentEvent>;
  /**
   * Entrega a resposta de um `question.asked`. Só quem emite o evento precisa
   * implementar — um adaptador que nunca pergunta pode omitir o método.
   * Um `requestId` desconhecido é ignorado, e não um erro: a resposta pode ter
   * chegado depois de o run acabar.
   */
  answer?(sessionId: string, requestId: string, outcome: AgentQuestionOutcome): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
}
