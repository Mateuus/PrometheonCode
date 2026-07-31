import type { Metadata } from 'next';
import { Laptop, MonitorSmartphone } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import {
  RevokeDeviceForm,
  RevokeSessionForm,
  SignOutEverywhereForm,
} from '@/components/forms/session-forms';
import { listDevices, listSessions } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { absoluteDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Sessions' };

/**
 * Sessões da conta.
 *
 * A lista vem de `GET /v1/me/sessions` e cada linha pode ser derrubada por
 * `DELETE /v1/sessions/:id`. O que a API entrega é deliberadamente resumido —
 * rótulo do cliente em vez do user agent, rede em vez do endereço exato — porque
 * quem sequestrou a sessão abre exatamente esta tela.
 */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, t, locale] = await Promise.all([searchParams, getTranslate(), getLocale()]);
  const forced = devForcedState(query);
  const [sessions, devices] = await Promise.all([
    applyForcedState(forced, await listSessions()),
    listDevices(),
  ]);

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />
      <PageHeader
        title={t('sessions.title')}
        description={t('sessions.subtitle')}
        actions={<SignOutEverywhereForm />}
      />

      <DataView result={sessions} retryHref="/settings/sessions" backHref="/app">
        {(items) => (
          <div className="max-w-3xl space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MonitorSmartphone aria-hidden className="size-4 text-muted" />
                  {t('sessions.list')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {items.length === 0 ? (
                  <p className="text-sm text-muted">{t('sessions.empty')}</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {items.map((session) => (
                      <li
                        key={session.id}
                        className="flex flex-wrap items-start justify-between gap-3 py-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                            {session.clientName ?? t('sessions.unknownClient')}
                            {session.current ? (
                              <StatusBadge tone="activity">{t('sessions.current')}</StatusBadge>
                            ) : null}
                          </p>
                          <dl className="text-xs text-muted">
                            <div className="flex gap-1.5">
                              <dt>{t('sessions.origin')}</dt>
                              <dd className="font-mono">{session.ipAddress ?? '—'}</dd>
                            </div>
                            <div className="flex gap-1.5">
                              <dt>{t('sessions.startedAt')}</dt>
                              <dd>{absoluteDateTime(session.createdAt, locale)}</dd>
                            </div>
                            <div className="flex gap-1.5">
                              <dt>{t('sessions.lastUsedAt')}</dt>
                              <dd>{absoluteDateTime(session.lastUsedAt, locale)}</dd>
                            </div>
                          </dl>
                        </div>
                        <RevokeSessionForm sessionId={session.id} current={session.current} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* Os dispositivos ficam nesta mesma tela porque respondem à mesma
                pergunta. Numa tela própria, alguém encerraria as sessões, acharia
                que terminou, e deixaria o editor conectado por 90 dias. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Laptop aria-hidden className="size-4 text-muted" />
                  {t('devices.list')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!devices.ok || devices.data.length === 0 ? (
                  <p className="text-sm text-muted">{t('devices.empty')}</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {devices.data.map((device) => (
                      <li
                        key={device.id}
                        className="flex flex-wrap items-start justify-between gap-3 py-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <p className="text-sm font-medium text-foreground">{device.name}</p>
                          <dl className="text-xs text-muted">
                            <div className="flex gap-1.5">
                              <dt>{t('sessions.origin')}</dt>
                              <dd className="font-mono">{device.ipAddress ?? '—'}</dd>
                            </div>
                            <div className="flex gap-1.5">
                              <dt>{t('devices.connectedAt')}</dt>
                              <dd>{absoluteDateTime(device.connectedAt, locale)}</dd>
                            </div>
                            <div className="flex gap-1.5">
                              <dt>{t('devices.lastSeenAt')}</dt>
                              <dd>
                                {device.lastSeenAt === null
                                  ? t('devices.never')
                                  : absoluteDateTime(device.lastSeenAt, locale)}
                              </dd>
                            </div>
                            {device.credentialExpiresAt === null ? null : (
                              <div className="flex gap-1.5">
                                <dt>{t('devices.expiresAt')}</dt>
                                <dd>{absoluteDateTime(device.credentialExpiresAt, locale)}</dd>
                              </div>
                            )}
                          </dl>
                        </div>
                        <RevokeDeviceForm deviceId={device.id} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Alert title={t('devices.hint')} />
            <Alert title={t('sessions.privacyNote')} />
          </div>
        )}
      </DataView>
    </div>
  );
}
