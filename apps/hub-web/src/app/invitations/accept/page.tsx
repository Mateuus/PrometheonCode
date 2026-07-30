import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { InvitationCard } from '@/components/invitations/invitation-card';

export const metadata: Metadata = { title: 'Invitation' };

/**
 * Endereço do link que sai no e-mail de convite.
 *
 * A Hub API monta `${webUrl}/invitations/accept?token=…` (ver
 * `AuthService.sendInvitationEmail`), então esta rota **é** o convite — e não
 * existir aqui fazia todo convite por e-mail cair em 404. `/invite/[token]`
 * continua funcionando e desenha a mesma tela.
 *
 * A rota fica fora de `PRIVATE_PREFIXES` de propósito: quem clica no link do
 * e-mail costuma não ter sessão no navegador, e mandá-lo ao login sem explicar o
 * que aconteceu perderia o convite pelo caminho. A tela decide o que oferecer.
 */
export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const raw = query.token;
  const token = Array.isArray(raw) ? raw[0] : raw;

  if (typeof token !== 'string' || token.trim() === '') {
    notFound();
  }

  return <InvitationCard token={token} />;
}
