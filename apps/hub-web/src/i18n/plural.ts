import type { MessageKey } from './catalog';
import type { Translate, TranslationValues } from './dictionary';

/**
 * Plural das frases contadas.
 *
 * Português, inglês e espanhol compartilham as mesmas duas formas — singular
 * para 1 e plural para o resto —, então uma chave `.one` ao lado da chave
 * plural resolve os três idiomas sem trazer uma biblioteca de ICU inteira. No
 * dia em que um idioma com mais formas entrar (russo, árabe), este arquivo é o
 * único lugar que muda.
 */

/** Chaves que existem em par: a plural e a `.one`. */
export type CountableKey = 'admin.plans.days' | 'agents.runningCount';

export function plural(
  t: Translate,
  key: CountableKey,
  count: number,
  values?: TranslationValues,
): string {
  const resolved: MessageKey = count === 1 ? (`${key}.one` as MessageKey) : key;
  return t(resolved, { count, ...values });
}
