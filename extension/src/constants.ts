/** Identificadores estáveis, usados no manifest, nos comandos e nos testes. */
export const EXTENSION_ID = 'prometheon.prometheon-code';
export const CONFIG_SECTION = 'prometheon';

/**
 * A mesma interface é registrada em dois lugares, porque uma view do VS Code
 * pertence a um único container: `CHAT_VIEW_ID` fica na Activity Bar e
 * `CHAT_VIEW_SECONDARY_ID` na Secondary Side Bar, junto do chat nativo.
 * As duas compartilham provider e estado.
 */
export const CHAT_VIEW_ID = 'prometheon.chatView';
export const CHAT_VIEW_SECONDARY_ID = 'prometheon.chatViewSecondary';

export const CHAT_VIEW_IDS: readonly string[] = [CHAT_VIEW_ID, CHAT_VIEW_SECONDARY_ID];
