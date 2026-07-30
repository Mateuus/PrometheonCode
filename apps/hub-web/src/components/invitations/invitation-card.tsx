import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { readSession } from '@/lib/auth/session';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AcceptInvitationForm } from '@/components/forms/invitation-forms';

/**
 * Convite para uma organização.
 *
 * **A Hub API não expõe o convite antes de ele ser consumido** — não existe
 * `GET /v1/invitations/:token`, e é uma decisão defensável: quem tem o link não
 * deveria descobrir qual organização convidou quem só por abri-lo. Por isso a
 * tela não mostra o nome da organização nem o papel; ela não tem como saber, e
 * prometer o que não pode entregar seria pior.
 *
 * O que ela oferece depende de haver sessão:
 *
 * - **com sessão**, um botão que aceita de verdade (`POST /v1/invitations/accept`).
 *   A API confere que o endereço do convite é o da conta; se não for, a recusa
 *   aparece aqui com o motivo;
 * - **sem sessão**, dois caminhos — entrar com a conta convidada ou criar a
 *   conta já com o convite, que é o fluxo antigo e continua valendo.
 */
export async function InvitationCard({ token }: { token: string }) {
  const [t, session] = await Promise.all([getTranslate(), readSession()]);
  const acceptPath = `/invitations/accept?token=${encodeURIComponent(token)}`;

  return (
    <PublicShell centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <span className="mb-2 flex size-9 items-center justify-center rounded-[var(--radius-prom)] bg-accent-soft text-accent">
            <MailCheck aria-hidden className="size-4" />
          </span>
          <CardTitle className="text-lg">
            {session ? t('invite.signedInTitle') : t('invite.genericTitle')}
          </CardTitle>
          <CardDescription>
            {session
              ? t('invite.signedInSubtitle', { email: session.user.email })
              : t('invite.genericSubtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {session ? (
            <>
              <AcceptInvitationForm token={token} />
              <Button asChild variant="ghost">
                <Link href="/app">{t('action.declineInvite')}</Link>
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link href={`/login?next=${encodeURIComponent(acceptPath)}`}>
                    {t('invite.signInToAccept')}
                  </Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href={`/register?invitation=${encodeURIComponent(token)}`}>
                    {t('action.acceptInvite')}
                  </Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/">{t('action.declineInvite')}</Link>
                </Button>
              </div>
              <p className="text-xs text-muted">{t('invite.signedOutHint')}</p>
            </>
          )}
        </CardContent>
      </Card>
    </PublicShell>
  );
}
