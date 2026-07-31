import Link from 'next/link';
import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import type { MessageKey } from '@/i18n/catalog';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { LoginForm } from '@/components/auth/auth-form';
import { ProviderButtons } from '@/components/auth/provider-buttons';
import { safeRedirect } from '@/lib/auth/safe-redirect';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Traduz o motivo que veio do provedor numa mensagem para a pessoa.
 *
 * `cancelled` devolve `null` de propósito: desistir na tela do GitHub é uma
 * decisão, não uma falha, e mostrar um alerta para ela seria repreender alguém
 * por ter mudado de ideia.
 */
function providerErrorKey(value: string | undefined): MessageKey | null {
  switch (value) {
    case undefined:
    case 'cancelled':
      return null;
    case 'IDENTITY_LINK_REQUIRED':
      return 'auth.provider.linkRequired';
    case 'PROVIDER_REJECTED':
      return 'auth.provider.rejected';
    case 'offline':
    case 'PROVIDER_UNAVAILABLE':
      return 'auth.provider.unavailable';
    default:
      return 'auth.provider.failed';
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslate();
  const params = await searchParams;

  // O `next` só volta ao formulário depois de passar pelo filtro de open
  // redirect — o que chega pela URL nunca é confiável.
  const raw = params.next;
  const next = safeRedirect(Array.isArray(raw) ? raw[0] : raw);
  const justReset = (Array.isArray(params.reset) ? params.reset[0] : params.reset) === '1';
  const justVerified = (Array.isArray(params.verified) ? params.verified[0] : params.verified) === '1';

  // A volta do provedor traz o motivo quando algo não deu certo. Quem apenas
  // desistiu na tela do GitHub não recebe aviso nenhum: cancelar não é erro, e
  // um alerta vermelho para uma decisão consciente só confunde.
  const providerRaw = params.provider;
  const provider = Array.isArray(providerRaw) ? providerRaw[0] : providerRaw;
  const providerMessage = providerErrorKey(provider);

  return (
    <PublicShell centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('auth.login.title')}</CardTitle>
          <CardDescription>{t('auth.login.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {justReset ? <Alert tone="success" title={t('auth.reset.done')} /> : null}
          {justVerified ? <Alert tone="success" title={t('auth.verify.done')} /> : null}
          {providerMessage === null ? null : <Alert tone="danger" title={t(providerMessage)} />}

          <ProviderButtons next={next} />

          <LoginForm next={next} />

          <p className="text-center text-sm text-muted">
            <Link href="/forgot-password" className="text-link underline underline-offset-4">
              {t('auth.forgot.link')}
            </Link>
          </p>
          <p className="text-center text-sm text-muted">
            {t('auth.login.noAccount')}{' '}
            <Link href="/register" className="text-link underline underline-offset-4">
              {t('action.signUp')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </PublicShell>
  );
}
