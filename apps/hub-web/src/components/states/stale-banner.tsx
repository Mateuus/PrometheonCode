import { History } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { relativeTime } from '@/lib/format';

/**
 * Estado 7 de 7 — dado possivelmente desatualizado.
 *
 * Aparece quando a leitura veio de cache porque a origem falhou. A tela segue
 * mostrando os números, e diz de quando eles são: número velho sem aviso é a
 * tela mentindo para o usuário.
 */
export async function StaleDataBanner({ fetchedAt }: { fetchedAt: string }) {
  const [t, locale] = await Promise.all([getTranslate(), getLocale()]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-[var(--radius-prom)] border border-alert/50 bg-alert/10 px-4 py-3 text-sm"
    >
      <History aria-hidden className="mt-0.5 size-4 shrink-0 text-alert" />
      <div>
        <p className="font-medium text-foreground">{t('state.stale.title')}</p>
        <p className="mt-0.5 text-muted">
          {t('state.stale.description', { relativeTime: relativeTime(fetchedAt, locale) })}
        </p>
      </div>
    </div>
  );
}
