import 'server-only';
import { cookies, headers } from 'next/headers';
import { buildDictionary, createTranslate, type Dictionary, type Translate } from './dictionary';
import { LOCALE_COOKIE, isLocale, matchLocale, type Locale } from './config';

/**
 * Idioma da requisição: primeiro a escolha explícita guardada no cookie, depois
 * o `Accept-Language` do navegador, e por fim o inglês.
 *
 * O locale não entra na URL. As rotas do `Docs/05` não têm segmento de idioma e
 * inventar um aqui quebraria todo link publicado.
 */
export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const chosen = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) {
    return chosen;
  }

  const headerStore = await headers();
  return matchLocale(headerStore.get('accept-language'));
}

export async function getDictionary(): Promise<Dictionary> {
  return buildDictionary(await getLocale());
}

/** Tradutor para Server Components. Client Components usam `useTranslate()`. */
export async function getTranslate(): Promise<Translate> {
  return createTranslate(await getDictionary());
}
