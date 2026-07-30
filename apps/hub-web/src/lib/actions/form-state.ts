import type { MessageKey } from '@/i18n/catalog';

/**
 * Retorno padrão de uma Server Action de formulário.
 *
 * O erro trafega como **chave de tradução**, não como frase pronta: quem
 * escreve a mensagem final é a tela, no idioma da requisição. Assim a action
 * não precisa saber em que língua o usuário está.
 */
export interface FormState {
  status: 'idle' | 'error';
  /** Erro geral do formulário. */
  messageKey?: MessageKey;
  /** Erro por campo, indexado pelo `name` do input. */
  fieldErrors?: Partial<Record<string, MessageKey>>;
}

export const idleFormState: FormState = { status: 'idle' };

export function formError(
  messageKey: MessageKey,
  fieldErrors?: Partial<Record<string, MessageKey>>,
): FormState {
  return { status: 'error', messageKey, ...(fieldErrors ? { fieldErrors } : {}) };
}
