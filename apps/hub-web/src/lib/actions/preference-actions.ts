'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isLocale, LOCALE_COOKIE } from '@/i18n/config';
import { THEME_COOKIE } from '@/lib/auth/session';

/**
 * Preferências de apresentação: tema e idioma.
 *
 * Ficam em cookie porque quem monta o HTML é o servidor — o tema precisa estar
 * decidido antes da primeira pintura, senão a página pisca. Não são credencial,
 * então não exigem `HttpOnly`; ainda assim saem com `SameSite=Lax` e sem
 * `Secure` só em desenvolvimento, onde o Hub roda sem TLS.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

const oneYear = 60 * 60 * 24 * 365;

export async function setThemeAction(theme: ThemePreference): Promise<void> {
  const store = await cookies();
  if (theme === 'system') {
    // Sem cookie, o CSS entrega a decisão ao `prefers-color-scheme`.
    store.delete(THEME_COOKIE);
  } else {
    store.set(THEME_COOKIE, theme, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: oneYear,
    });
  }
  revalidatePath('/', 'layout');
}

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) {
    return;
  }
  (await cookies()).set(LOCALE_COOKIE, locale, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: oneYear,
  });
  revalidatePath('/', 'layout');
}
