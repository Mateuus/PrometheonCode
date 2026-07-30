'use client';

import { useTransition } from 'react';
import { Languages } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from '@/i18n/config';
import { setLocaleAction } from '@/lib/actions/preference-actions';

/**
 * Seletor de idioma.
 *
 * Um `<select>` nativo de propósito: teclado, leitor de tela e mobile já
 * funcionam sem uma linha de JavaScript de acessibilidade escrita por nós.
 */
export function LocaleSelect({ current }: { current: Locale }) {
  const t = useTranslate();
  const [pending, startTransition] = useTransition();

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted">
      <Languages aria-hidden className="size-3.5" />
      <span className="sr-only">{t('locale.change')}</span>
      <select
        value={current}
        disabled={pending}
        onChange={(event) => {
          const value = event.target.value;
          startTransition(() => setLocaleAction(value));
        }}
        className="rounded-[var(--radius-prom)] border border-line bg-surface px-2 py-1 text-xs text-foreground"
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}
