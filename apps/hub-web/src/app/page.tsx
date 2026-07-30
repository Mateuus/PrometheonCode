import Link from 'next/link';
import { Brain, ScrollText, Users } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Logo } from '@/components/brand/logo';

export default async function LandingPage() {
  const t = await getTranslate();

  const features = [
    { icon: Brain, title: t('landing.feature.brain.title'), body: t('landing.feature.brain.description') },
    { icon: Users, title: t('landing.feature.agents.title'), body: t('landing.feature.agents.description') },
    { icon: ScrollText, title: t('landing.feature.audit.title'), body: t('landing.feature.audit.description') },
  ];

  return (
    <PublicShell>
      <section className="flex flex-col items-start gap-6">
        <Logo className="size-12" />
        <div>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {t('landing.heroTitle')}
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted">{t('landing.heroSubtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="lg">
            <Link href="/app">{t('landing.ctaPrimary')}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/register">{t('landing.ctaSecondary')}</Link>
          </Button>
        </div>
      </section>

      <section className="mt-12 grid gap-4 sm:grid-cols-3">
        {features.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <CardHeader>
              <span className="mb-2 flex size-9 items-center justify-center rounded-[var(--radius-prom)] bg-accent-soft text-accent">
                <Icon aria-hidden className="size-4" />
              </span>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{body}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <Alert className="mt-8" title={t('app.tagline')}>
        {t('landing.note')}
      </Alert>
    </PublicShell>
  );
}
