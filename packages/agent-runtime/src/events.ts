/**
 * O que um agente em execução produz.
 *
 * Este é o vocabulário entre quem executa o agente e quem mostra o resultado —
 * a extensão do VS Code, o CLI, e o que vier depois. Nenhum deles conhece o
 * formato do provedor: todos falam isto.
 *
 * O contrato nasceu na extensão e foi movido para cá quando o CLI apareceu.
 * Duplicá-lo teria feito os dois divergirem no primeiro campo novo.
 */

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
}

export type AgentEvent =
  /** Texto da resposta, conforme chega. */
  | { readonly type: 'delta'; readonly text: string }
  /**
   * Ferramenta começou. `toolId` liga este evento ao `tool.completed`
   * correspondente — é o que permite desenhar o bloco em andamento antes de a
   * ferramenta terminar. `tool` é o nome ("Write", "Bash"), `title` o alvo
   * ("Server.ts") e `detail` a linha de apoio ("147 lines").
   */
  | {
      readonly type: 'tool.requested';
      readonly toolId: string;
      readonly tool: string;
      readonly title: string;
      readonly detail?: string;
    }
  /** Ferramenta terminou. `failed` distingue erro de sucesso. */
  | {
      readonly type: 'tool.completed';
      readonly toolId: string;
      readonly output?: string;
      readonly detail?: string;
      readonly failed?: boolean;
    }
  /** Houve raciocínio. O conteúdo não é exibido, só o fato. */
  | { readonly type: 'thought'; readonly durationMs: number }
  /**
   * Tokens contabilizados desde o último `usage` — é delta, não total. Serve
   * para contar enquanto o agente trabalha; o número que fica é o do `completed`.
   */
  | { readonly type: 'usage'; readonly delta: TokenUsage }
  | { readonly type: 'completed'; readonly text: string; readonly usage?: TokenUsage }
  | { readonly type: 'failed'; readonly error: SerializedError }
  | { readonly type: 'cancelled' };

/** Modo de trabalho pedido para o run. */
export type WorkMode = 'plan' | 'edit' | 'agent-team';

/** Quanto o agente pode decidir sozinho. */
export type Autonomy = 'manual' | 'auto' | 'bypass';
