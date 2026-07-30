import type { Metadata } from 'next';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { getOrganizationBySlug, listMembers } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { relativeTime } from '@/lib/format';
import { roleLabel, viewerCan } from '@/lib/roles';
import type { Member } from '@/lib/api/types';
import type { Translate } from '@/i18n/dictionary';

export const metadata: Metadata = { title: 'Members' };

function memberStatusLabel(status: Member['status'], t: Translate): string {
  return {
    active: t('members.status.active'),
    invited: t('members.status.invited'),
    suspended: t('members.status.suspended'),
  }[status];
}

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ organizationSlug }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslate(),
    getLocale(),
  ]);

  const base = `/app/${organizationSlug}`;
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);

  const organization = await getOrganizationBySlug(organizationSlug);
  const members = await applyForcedState(
    forced,
    organization.ok ? await listMembers(organization.data.id) : { ok: false, kind: 'not-found' },
    [],
  );

  const canInvite = organization.ok && viewerCan(organization.data.viewerRole, 'members.invite');

  return (
    <div className="space-y-6">
      <SampleDataNotice />

      <PageHeader
        title={t('members.title')}
        description={t('members.subtitle')}
        {...(canInvite
          ? {
              actions: (
                <Button size="sm">
                  <UserPlus aria-hidden />
                  {t('action.invite')}
                </Button>
              ),
            }
          : {})}
      />

      <DataView
        result={members}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="members.empty"
        retryHref={`${base}/members`}
        backHref="/app"
      >
        {(items) => (
          <div className="overflow-x-auto rounded-[var(--radius-prom)] border border-line">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <caption className="sr-only">{t('members.title')}</caption>
              <thead>
                <tr className="border-b border-line bg-surface-raised text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('auth.field.name')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('members.role')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('audit.column.when')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('connection.status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((member) => (
                  <tr key={member.id} className="border-b border-line last:border-0 bg-surface">
                    <td className="px-4 py-3">
                      <span className="block font-medium text-foreground">{member.name}</span>
                      <span className="block text-xs text-muted">{member.email}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone="accent" icon={ShieldCheck}>
                        {roleLabel(member.role, t)}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {member.lastSeenAt
                        ? t('members.lastSeen', {
                            relativeTime: relativeTime(member.lastSeenAt, locale),
                          })
                        : t('members.joined', {
                            relativeTime: relativeTime(member.joinedAt, locale),
                          })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge tone={member.online ? 'activity' : 'neutral'}>
                          {member.online ? t('members.online') : t('members.offline')}
                        </StatusBadge>
                        {member.status !== 'active' ? (
                          <StatusBadge tone={member.status === 'suspended' ? 'danger' : 'alert'}>
                            {memberStatusLabel(member.status, t)}
                          </StatusBadge>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataView>
    </div>
  );
}
