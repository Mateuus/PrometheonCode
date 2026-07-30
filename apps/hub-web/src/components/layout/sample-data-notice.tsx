import { FlaskConical } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { env } from '@/lib/env';

/**
 * PROVISÓRIO — aviso de dados de exemplo.
 *
 * Enquanto a Hub API não sobe, as telas mostram dados inventados. Uma tela que
 * exibe número falso sem dizer que é falso é exatamente a tela que mente para o
 * usuário — e é isso que os sete estados existem para evitar. Some sozinho
 * quando `HUB_WEB_SAMPLE_DATA` for desligado.
 */
export async function SampleDataNotice() {
  if (!env().HUB_WEB_SAMPLE_DATA) {
    return null;
  }

  const t = await getTranslate();
  return (
    <p className="inline-flex items-center gap-2 rounded-full border border-alert/50 bg-alert/10 px-3 py-1 text-xs text-foreground">
      <FlaskConical aria-hidden className="size-3.5 text-alert" />
      <span className="font-medium">{t('common.provisionalData')}</span>
      <span className="text-muted">{t('common.provisionalDataHint')}</span>
    </p>
  );
}
