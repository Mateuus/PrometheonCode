import type { Metadata } from 'next';
import { InvitationCard } from '@/components/invitations/invitation-card';

export const metadata: Metadata = { title: 'Invitation' };

/**
 * Convite com o token no caminho.
 *
 * O e-mail da Hub API aponta para `/invitations/accept?token=…`; esta rota
 * continua existindo porque links antigos e o material de suporte usam a forma
 * com o token no caminho. As duas desenham a mesma tela.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return <InvitationCard token={token} />;
}
