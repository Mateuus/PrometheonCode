import Link from 'next/link';
import type { Metadata } from 'next';
import { MailCheck } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StateBlock } from '@/components/states/state-block';
import { DataView } from '@/components/states/data-view';
import { getInvitation } from '@/lib/api/queries';
import { readForcedState, applyForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { relativeTime } from '@/lib/format';
import { roleLabel } from '@/lib/roles';

export const metadata: Metadata = { title: 'Invitation' };

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ token }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslate(),
    getLocale(),
  ]);

  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const invitation = await applyForcedState(forced, await getInvitation(token));

  return (
    <PublicShell centered>
      <div className="w-full max-w-md">
        {invitation.ok ? (
          <Card>
            <CardHeader>
              <span className="mb-2 flex size-9 items-center justify-center rounded-[var(--radius-prom)] bg-accent-soft text-accent">
                <MailCheck aria-hidden className="size-4" />
              </span>
              <CardTitle className="text-lg">
                {t('invite.title', { organization: invitation.data.organizationName })}
              </CardTitle>
              <CardDescription>
                {t('invite.subtitle', { role: roleLabel(invitation.data.role, t) })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted">
                {t('invite.expiresAt', {
                  relativeTime: relativeTime(invitation.data.expiresAt, locale),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link href={`/app/${invitation.data.organizationSlug}`}>
                    {t('action.acceptInvite')}
                  </Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/">{t('action.declineInvite')}</Link>
                </Button>
              </div>
              <p className="text-xs text-muted">{t('invite.needsAccount')}</p>
            </CardContent>
          </Card>
        ) : invitation.kind === 'not-found' ? (
          // Convite inválido tem mensagem própria: dizer "erro" aqui esconderia
          // a única informação útil, que é pedir um convite novo.
          <StateBlock
            icon={MailCheck}
            tone="alert"
            title={t('invite.invalid.title')}
            description={t('invite.invalid.description')}
            actions={
              <Button asChild variant="secondary" size="sm">
                <Link href="/">{t('action.goBack')}</Link>
              </Button>
            }
          />
        ) : (
          <DataView result={invitation} retryHref={`/invite/${token}`} backHref="/">
            {() => null}
          </DataView>
        )}
      </div>
    </PublicShell>
  );
}
