import Link from 'next/link';
import type { Metadata } from 'next';
import { MailCheck } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Invitation' };

/**
 * Convite para uma organização.
 *
 * **A Hub API não expõe o convite antes do cadastro** — não existe
 * `GET /v1/invitations/:token`, e é uma decisão defensável: quem tem o link não
 * deveria conseguir descobrir qual organização convidou quem só por abri-lo.
 * O convite é consumido dentro de `POST /v1/auth/register`, junto com o
 * `invitationToken`.
 *
 * Por isso esta tela não promete o que não pode entregar: ela não mostra o nome
 * da organização nem o papel, porque não tem como saber. Ela encaminha para o
 * cadastro carregando o token — e, para quem já tem conta, diz a verdade
 * incômoda de que ainda não há como aceitar sem criar uma.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const [{ token }, t] = await Promise.all([params, getTranslate()]);

  return (
    <PublicShell centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <span className="mb-2 flex size-9 items-center justify-center rounded-[var(--radius-prom)] bg-accent-soft text-accent">
            <MailCheck aria-hidden className="size-4" />
          </span>
          <CardTitle className="text-lg">{t('invite.genericTitle')}</CardTitle>
          <CardDescription>{t('invite.genericSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/register?invitation=${encodeURIComponent(token)}`}>
                {t('action.acceptInvite')}
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/">{t('action.declineInvite')}</Link>
            </Button>
          </div>
          <p className="text-xs text-muted">{t('invite.existingAccount')}</p>
        </CardContent>
      </Card>
    </PublicShell>
  );
}
