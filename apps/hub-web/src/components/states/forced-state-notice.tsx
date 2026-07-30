import { FlaskConical } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import type { ForcedState } from '@/lib/api/state-override';

/**
 * Aviso de estado forçado.
 *
 * Aparece só quando `?state=` está em uso, fora de produção. Existe pelo mesmo
 * motivo que os sete estados existem: uma tela que mostra um estado inventado
 * sem dizer que é inventado mente para quem olha — inclusive para quem está
 * revisando o desenho.
 */
export async function ForcedStateNotice({ forced }: { forced: ForcedState | undefined }) {
  if (!forced) {
    return null;
  }

  const t = await getTranslate();
  return (
    <p className="inline-flex items-center gap-2 rounded-full border border-alert/50 bg-alert/10 px-3 py-1 text-xs text-foreground">
      <FlaskConical aria-hidden className="size-3.5 text-alert" />
      <span className="font-medium">{t('dev.forcedState')}</span>
      <code className="font-mono text-muted">{forced}</code>
      <span className="text-muted">{t('dev.forcedStateHint')}</span>
    </p>
  );
}
