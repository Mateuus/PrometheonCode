import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslate } from '@/i18n/server';
import type { MessageKey } from '@/i18n/catalog';
import type { Translate } from '@/i18n/dictionary';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DeviceDecisionForm } from '@/components/forms/device-forms';
import { getDeviceVerification, getViewer } from '@/lib/api/queries';
import type { ApiFailure } from '@/lib/api/result';
import { deviceVerificationRequestSchema } from '@/lib/api/schemas';
import { normalizeUserCode } from '@/lib/device-code';
import { absoluteDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Authorize device' };

/**
 * Autorização de dispositivo — o passo 3 do device flow (`Docs/09`).
 *
 * A extensão pede um código à Hub API e abre o navegador em
 * `/device?user_code=XXXX-YYYY` (ver `AuthService.startDeviceAuthorization`);
 * quem preferiu "Copy code" chega sem parâmetro e digita. Esta página mostra o
 * que está sendo autorizado e grava a decisão — a extensão, em polling, recolhe
 * a credencial sozinha depois do "aprovar".
 *
 * A rota está em `PRIVATE_PREFIXES` (`src/proxy.ts`): sem sessão não há o que
 * decidir, e o redirect de login preserva `?user_code=` no `next`. O visual é o
 * `PublicShell` de propósito — é uma tela de decisão focada, como o consent de
 * OAuth: navegação de produto aqui só ofereceria rotas de fuga no meio de uma
 * escolha de segurança.
 */

/** Rótulo de cada tipo de cliente do contrato (`deviceKindSchema`). */
const KIND_KEYS: Record<'vscode' | 'cli' | 'ci' | 'other', MessageKey> = {
  vscode: 'device.kind.vscode',
  cli: 'device.kind.cli',
  ci: 'device.kind.ci',
  other: 'device.kind.other',
};

/** Casca comum das variações da tela: card curto e centrado. */
function DeviceScreen({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <PublicShell centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-lg">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </PublicShell>
  );
}

/**
 * Entrada manual do código. Submete via GET para a própria página: a URL fica
 * igual à que a extensão abriria, recarregável e sem JavaScript no meio.
 */
function CodeEntryForm({ t }: { t: Translate }) {
  return (
    <form method="get" action="/device" className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="user-code">{t('device.enter.label')}</Label>
        <Input
          id="user-code"
          name="user_code"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={16}
          required
          // A página inteira é este campo: quem chegou sem código veio digitá-lo.
          autoFocus
          placeholder={t('device.enter.placeholder')}
          className="text-center font-mono text-lg uppercase tracking-[0.25em]"
        />
      </div>
      <Button type="submit" className="w-full">
        {t('device.enter.submit')}
      </Button>
    </form>
  );
}

/** Código desconhecido ou vencido: explica e já oferece a segunda tentativa. */
function InvalidCodeScreen({ t }: { t: Translate }) {
  return (
    <DeviceScreen title={t('device.invalid.title')}>
      <Alert tone="danger" title={t('device.error.invalidCode')} />
      <CodeEntryForm t={t} />
    </DeviceScreen>
  );
}

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, locale, params] = await Promise.all([getTranslate(), getLocale(), searchParams]);

  // A API monta a URL com `user_code` (snake_case, ver
  // `startDeviceAuthorization`); `userCode` também entra, por robustez com
  // links escritos à mão. A normalização espelha a do servidor: maiúsculas,
  // sem separadores, hífen no meio.
  const raw = params.user_code ?? params.userCode;
  const code = normalizeUserCode(Array.isArray(raw) ? raw[0] : raw);

  if (code === '') {
    return (
      <DeviceScreen title={t('device.enter.title')} description={t('device.enter.description')}>
        <CodeEntryForm t={t} />
      </DeviceScreen>
    );
  }

  // Fora do contrato (6 a 16 caracteres) nem vai à rede: a API responderia um
  // 400 de validação que, para quem digitou, é a mesma coisa que código errado.
  if (!deviceVerificationRequestSchema.safeParse({ userCode: code }).success) {
    return <InvalidCodeScreen t={t} />;
  }

  // A verificação e o viewer andam juntos: a tela mostra o pedido e, ao lado,
  // com qual conta e em qual organização ele seria aprovado.
  const [verification, viewer] = await Promise.all([getDeviceVerification(code), getViewer()]);

  // O middleware já barrou quem não tem sessão; `unauthorized` aqui é a sessão
  // morrendo entre a portaria e a chamada. O login devolve a pessoa a esta URL.
  if (
    (!verification.ok && verification.kind === 'unauthorized') ||
    (!viewer.ok && viewer.kind === 'unauthorized')
  ) {
    redirect(`/login?next=${encodeURIComponent(`/device?user_code=${encodeURIComponent(code)}`)}`);
  }

  if (!verification.ok) {
    // Inválido e expirado são o mesmo caso aqui: o estado vive no Redis com
    // TTL, e uma chave vencida é indistinguível de uma que nunca existiu.
    if (verification.code === 'DEVICE_CODE_INVALID' || verification.kind === 'not-found') {
      return <InvalidCodeScreen t={t} />;
    }
    return <FailureScreen t={t} kind={verification.kind} code={code} />;
  }

  if (!viewer.ok) {
    return <FailureScreen t={t} kind={viewer.kind} code={code} />;
  }

  const details: { label: string; value: string; mono?: boolean }[] = [
    { label: t('device.field.device'), value: verification.data.deviceName },
    { label: t('device.field.client'), value: t(KIND_KEYS[verification.data.deviceKind]) },
    // A plataforma chega crua da extensão (`windows`, `darwin`…) e é mostrada
    // como veio: traduzir um identificador só atrapalharia a conferência.
    { label: t('device.field.platform'), value: verification.data.platform ?? '—', mono: true },
    {
      label: t('device.field.requestedAt'),
      value: absoluteDateTime(verification.data.requestedAt, locale),
    },
    {
      label: t('device.field.expiresAt'),
      value: absoluteDateTime(verification.data.expiresAt, locale),
    },
  ];

  return (
    <DeviceScreen title={t('device.title')} description={t('device.subtitle')}>
      {/* O código em destaque é o cerne da conferência: precisa ser comparável
          de relance com o que o editor está mostrando. */}
      <div className="space-y-1.5">
        <div className="rounded-[var(--radius-prom)] border border-line bg-surface-raised px-4 py-4 text-center">
          <p className="font-mono text-2xl font-semibold tracking-[0.25em] text-foreground">
            {code}
          </p>
        </div>
        <p className="text-xs text-muted">{t('device.checkCode')}</p>
      </div>

      <dl className="space-y-1.5 text-sm">
        {details.map((detail) => (
          <div key={detail.label} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted">{detail.label}</dt>
            <dd
              className={
                detail.mono
                  ? 'min-w-0 break-words text-right font-mono text-foreground'
                  : 'min-w-0 break-words text-right font-medium text-foreground'
              }
            >
              {detail.value}
            </dd>
          </div>
        ))}
      </dl>

      <Alert tone="alert" title={t('device.securityWarning.title')}>
        {t('device.securityWarning.body')}
      </Alert>

      <p className="text-xs text-muted">{t('auth.signedInAs', { email: viewer.data.user.email })}</p>

      {viewer.data.organizations.length === 0 ? (
        // A credencial de dispositivo é sempre presa a uma organização
        // (`Docs/09`); sem nenhuma, não há o que aprovar — e dizer isso vale
        // mais que um erro da API depois do clique.
        <>
          <Alert title={t('device.noOrganizations.title')}>
            {t('device.noOrganizations.description')}
          </Alert>
          <Button asChild variant="secondary">
            <Link href="/app">{t('action.goToDashboard')}</Link>
          </Button>
        </>
      ) : (
        <DeviceDecisionForm
          userCode={code}
          organizations={viewer.data.organizations.map(({ id, name }) => ({ id, name }))}
          defaultOrganizationId={viewer.data.activeOrganizationId}
        />
      )}
    </DeviceScreen>
  );
}

/** API fora do ar ou resposta fora do contrato: nada foi decidido. */
function FailureScreen({
  t,
  kind,
  code,
}: {
  t: Translate;
  kind: ApiFailure['kind'];
  code: string;
}) {
  const offline = kind === 'offline';
  return (
    <DeviceScreen title={t('device.title')}>
      <Alert
        tone="danger"
        title={t(offline ? 'state.offline.title' : 'state.error.title')}
      >
        {t(offline ? 'auth.error.offline' : 'state.error.description')}
      </Alert>
      <Button asChild variant="secondary">
        <Link href={`/device?user_code=${encodeURIComponent(code)}`}>{t('action.retry')}</Link>
      </Button>
    </DeviceScreen>
  );
}
