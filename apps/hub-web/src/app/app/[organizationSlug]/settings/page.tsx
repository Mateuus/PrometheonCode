import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import {
  DeleteOrganizationForm,
  UpdateOrganizationForm,
} from '@/components/forms/organization-forms';
import { ForbiddenState } from '@/components/states/screen-states';
import { getOrganizationBySlug } from '@/lib/api/queries';
import { devForcedState } from '@/lib/api/state-override';
import { viewerCan } from '@/lib/roles';

export const metadata: Metadata = { title: 'Organization settings' };

/**
 * Identidade da organização: nome, endereço e exclusão.
 *
 * Quem não tem `organization.manage` vê a negativa em vez de um formulário que
 * a API recusaria — esconder o formulário não autoriza ninguém, mas oferecer um
 * botão que sempre falha é pior que não oferecer.
 */
export default async function OrganizationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ organizationSlug }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslate(),
  ]);

  const base = `/app/${organizationSlug}`;
  const forced = devForcedState(query);
  const organization = await getOrganizationBySlug(organizationSlug);

  return (
    <div className="space-y-6">
      <ForcedStateNotice forced={forced} />

      <PageHeader
        title={t('organizationSettings.title')}
        description={t('organizationSettings.subtitle')}
      />

      <DataView result={organization} retryHref={`${base}/settings`} backHref={base}>
        {(data) =>
          viewerCan({ role: data.role, permissions: data.permissions }, 'organization.manage') ? (
            <div className="max-w-2xl space-y-6">
              <UpdateOrganizationForm name={data.name} slug={data.slug} version={data.version} />
              <DeleteOrganizationForm slug={data.slug} version={data.version} />
            </div>
          ) : (
            <ForbiddenState backHref={base} />
          )
        }
      </DataView>
    </div>
  );
}
