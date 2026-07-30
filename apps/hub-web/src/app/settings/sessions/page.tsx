import type { Metadata } from 'next';
import { MonitorSmartphone } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/status-badge';
import { UnauthorizedState } from '@/components/states/screen-states';
import { SignOutEverywhereForm } from '@/components/forms/session-forms';
import { readSession } from '@/lib/auth/session';
import { absoluteDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Sessions' };

/**
 * Sessões da conta.
 *
 * **A Hub API ainda não lista sessões.** O contrato tem `sessionSchema` e
 * `sessionPageSchema`, mas nenhuma rota os serve — não existe `GET /v1/me/sessions`
 * nem `DELETE /v1/sessions/:id`. Inventar uma tabela aqui seria a tela mentindo
 * sobre o que sabe.
 *
 * O que existe de verdade: esta sessão, que o Hub Web custodia no cookie, e
 * `POST /v1/auth/logout` com `allSessions`, que encerra todas de uma vez. É o
 * que a tela oferece, dizendo com todas as letras o que falta.
 */
export default async function SessionsPage() {
  const [t, locale, session] = await Promise.all([getTranslate(), getLocale(), readSession()]);

  if (!session) {
    return <UnauthorizedState />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('sessions.title')}
        description={t('sessions.subtitle')}
        actions={<SignOutEverywhereForm />}
      />

      <div className="max-w-3xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MonitorSmartphone aria-hidden className="size-4 text-muted" />
              {t('sessions.current')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-line text-sm">
              <div className="flex items-center justify-between gap-2 py-2">
                <dt className="text-muted">{t('auth.field.email')}</dt>
                <dd className="font-medium text-foreground">{session.user.email}</dd>
              </div>
              <div className="flex items-center justify-between gap-2 py-2">
                <dt className="text-muted">{t('sessions.identifier')}</dt>
                <dd className="font-mono text-xs text-muted">{session.sessionId}</dd>
              </div>
              <div className="flex items-center justify-between gap-2 py-2">
                <dt className="text-muted">{t('sessions.accessExpiresAt')}</dt>
                <dd className="flex items-center gap-2 font-medium text-foreground">
                  {absoluteDateTime(session.accessExpiresAt, locale)}
                  <StatusBadge tone="activity">{t('sessions.autoRenew')}</StatusBadge>
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Alert title={t('sessions.listUnavailable')}>{t('sessions.listUnavailableHint')}</Alert>
      </div>
    </div>
  );
}
