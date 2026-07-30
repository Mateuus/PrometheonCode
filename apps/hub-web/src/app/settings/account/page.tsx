import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { getCurrentUser } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, t] = await Promise.all([searchParams, getTranslate()]);
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const user = await applyForcedState(forced, await getCurrentUser());

  return (
    <div className="space-y-5">
      <SampleDataNotice />
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />

      <DataView result={user} retryHref="/settings/account" backHref="/app">
        {(data) => (
          <div className="max-w-2xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.profile')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="account-name">{t('auth.field.name')}</Label>
                  <Input id="account-name" name="name" defaultValue={data.name} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="account-email">{t('auth.field.email')}</Label>
                  <Input id="account-email" name="email" type="email" defaultValue={data.email} />
                </div>
              </CardContent>
              <CardFooter>
                <Button size="sm">{t('action.save')}</Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('account.security')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="account-current-password">{t('account.currentPassword')}</Label>
                  <Input
                    id="account-current-password"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="account-new-password">{t('account.newPassword')}</Label>
                  <Input
                    id="account-new-password"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted">{t('auth.field.passwordHint')}</p>
                </div>
              </CardContent>
              <CardFooter>
                <Button size="sm" variant="secondary">
                  {t('account.changePassword')}
                </Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-danger">{t('account.dangerZone')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Alert tone="danger" title={t('account.deleteAccount')}>
                  {t('account.deleteHint')}
                </Alert>
              </CardContent>
              <CardFooter>
                <Button size="sm" variant="danger">
                  {t('account.deleteAccount')}
                </Button>
              </CardFooter>
            </Card>
          </div>
        )}
      </DataView>
    </div>
  );
}
