/**
 * Execução de agentes, sem editor.
 *
 * O que este pacote entrega é o caminho entre "uma pessoa pediu algo" e "os
 * eventos do que o agente fez" — sem depender do VS Code, de terminal ou de
 * qualquer interface. Quem mostra decide como mostrar.
 *
 * A extensão tem a própria cópia deste código por enquanto: ela vive fora do
 * workspace pnpm e não consegue importar daqui. Quando ela migrar, esta é a
 * fonte que fica.
 */

export type {
  AgentEvent,
  Autonomy,
  SerializedError,
  TokenUsage,
  WorkMode,
} from './events.js';

export {
  permissionModeFor,
  readUsage,
  translateLine,
  type TranslationResult,
} from './claude-stream.js';

export {
  claudeIsAvailable,
  claudeVersion,
  runClaude,
  type ClaudeRun,
  type ClaudeRunOptions,
} from './claude-runner.js';
