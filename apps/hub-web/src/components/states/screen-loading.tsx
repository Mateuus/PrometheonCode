import { getTranslate } from '@/i18n/server';
import { LoadingState } from './loading-state';

/** Fallback padrão de `loading.tsx`, já traduzido. */
export async function ScreenLoading({ rows = 4 }: { rows?: number }) {
  const t = await getTranslate();
  return (
    <div className="space-y-4">
      <div className="h-6 w-40 animate-pulse rounded bg-surface-raised" />
      <LoadingState label={t('state.loading.title')} rows={rows} />
    </div>
  );
}
