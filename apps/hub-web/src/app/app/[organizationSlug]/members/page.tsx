import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { InviteMemberForm } from '@/components/forms/member-forms';
import { getOrganizationBySlug, listMembers } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { relativeTime } from '@/lib/format';
import { roleLabel, viewerCan } from '@/lib/roles';
import type { OrganizationMember } from '@/lib/api/types';
import type { Translate } from '@/i18n/dictionary';

export const metadata: Metadata = { title: 'Members' };

function memberStatusLabel(status: OrganizationMember['status'], t: Translate): string {
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
  const forced = devForcedState(query);

  const organization = await getOrganizationBySlug(organizationSlug);
  const members = await applyForcedState(
    forced,
    organization.ok ? await listMembers(organization.data.id) : organization,
    [],
  );

  const canInvite =
    organization.ok &&
    viewerCan(
      { role: organization.data.role, permissions: organization.data.permissions },
      'members.invite',
    );

  return (
    <div className="space-y-6">
      <ForcedStateNotice forced={forced} />

      <PageHeader
        title={t('members.title')}
        description={t('members.subtitle')}
        {...(canInvite ? { actions: <InviteMemberForm organizationSlug={organizationSlug} /> } : {})}
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
                    {t('members.membershipStatus')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((member) => (
                  <tr key={member.id} className="border-b border-line last:border-0 bg-surface">
                    <td className="px-4 py-3">
                      <span className="block font-medium text-foreground">{member.user.name}</span>
                      <span className="block text-xs text-muted">{member.user.email}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone="accent" icon={ShieldCheck}>
                        {roleLabel(member.role, t)}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {member.joinedAt
                        ? t('members.joined', {
                            relativeTime: relativeTime(member.joinedAt, locale),
                          })
                        : t('members.notJoinedYet')}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        tone={
                          member.status === 'active'
                            ? 'success'
                            : member.status === 'suspended'
                              ? 'danger'
                              : 'alert'
                        }
                      >
                        {memberStatusLabel(member.status, t)}
                      </StatusBadge>
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
