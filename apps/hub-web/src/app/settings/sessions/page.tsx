import type { Metadata } from 'next';
import { MonitorSmartphone } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { listSessions } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { relativeTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Sessions' };

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, t, locale] = await Promise.all([searchParams, getTranslate(), getLocale()]);
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const sessions = await applyForcedState(forced, await listSessions(), []);

  return (
    <div className="space-y-5">
      <SampleDataNotice />

      <PageHeader
        title={t('sessions.title')}
        description={t('sessions.subtitle')}
        actions={
          <Button size="sm" variant="danger">
            {t('action.revokeAll')}
          </Button>
        }
      />

      <DataView
        result={sessions}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="sessions.empty"
        retryHref="/settings/sessions"
        backHref="/app"
      >
        {(items) => (
          <ul className="max-w-3xl space-y-2">
            {items.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center gap-3 rounded-[var(--radius-prom)] border border-line bg-surface p-4"
              >
                <span className="flex size-8 items-center justify-center rounded-[6px] bg-surface-raised text-muted">
                  <MonitorSmartphone aria-hidden className="size-4" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {session.deviceLabel}
                    {session.current ? (
                      <StatusBadge tone="accent">{t('sessions.current')}</StatusBadge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted">
                    {t('sessions.lastActive', {
                      relativeTime: relativeTime(session.lastActiveAt, locale),
                    })}
                    {' · '}
                    {t('sessions.ipAddress')}: {session.ipAddress}
                  </p>
                </div>

                {session.current ? null : (
                  <Button size="sm" variant="ghost">
                    {t('action.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DataView>
    </div>
  );
}
