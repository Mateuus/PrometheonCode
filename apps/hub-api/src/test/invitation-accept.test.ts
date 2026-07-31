/**
 * Aceitar convite com uma conta que já existe (`POST /v1/invitations/accept`).
 *
 * O que esta suíte prova, e por que cada item importa:
 *
 * - o caminho feliz liga a conta à organização com o papel do convite, e o
 *   `GET /v1/me` passa a listar as duas organizações;
 * - **o endereço do convite é conferido**: uma conta com outro e-mail não entra,
 *   nem que tenha o token na mão — é a escalada de privilégio que o convite por
 *   e-mail existe para impedir;
 * - endereço não confirmado não aceita convite: sem isso, cadastrar-se com o
 *   e-mail de outra pessoa bastaria para consumir o convite dela;
 * - vencido, cancelado e já usado respondem com códigos **distintos**, porque a
 *   ação que resta ao usuário é diferente em cada caso;
 * - duas aceitações simultâneas com o mesmo token criam **uma** associação, e
 *   quem perdeu a corrida recebe resposta útil — nunca um 500;
 * - a associação aparece na auditoria e gera o evento de domínio no outbox, na
 *   mesma transação da escrita.
 */

import { invitations, organizationMembers, outboxMessages } from '@prometheon/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createHarness,
  lastMail,
  probeServices,
  registerAndLogin,
  tokenFromLink,
  uniqueEmail,
  type RegisteredUser,
  type TestHarness,
} from './support.js';

const probe = await probeServices();

interface AcceptedBody {
  data: {
    organization: { id: string; slug: string; role: string; permissions: string[] };
    member: { id: string; role: string; status: string; user: { id: string } };
  };
}

describe.skipIf(!probe.ok)('aceitar convite com conta existente', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_invite' });

    owner = await registerAndLogin(harness, {
      name: 'Olivia Owner',
      email: uniqueEmail('convite-owner'),
      password: 'senha-do-owner-de-convite',
      organizationName: 'Equipe do Convite',
    });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /**
   * Cria um convite pela rota real e devolve o token que foi para o e-mail.
   *
   * Passa pelo caminho do usuário de propósito: um convite inserido direto no
   * banco não provaria que o hash gravado casa com o token enviado.
   */
  async function invite(
    email: string,
    role: 'admin' | 'developer' | 'viewer' = 'developer',
  ): Promise<{ token: string; invitationId: string }> {
    const created = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.organizationId}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email, role },
    });

    if (created.statusCode !== 201) {
      throw new Error(`Convite não criado: ${created.payload}`);
    }

    await harness.authService.flushPendingMail();

    // `emailSchema` normaliza para minúsculas na borda, então é assim que o
    // endereço chega ao destinatário — mesmo que a chamada o tenha enviado com
    // outra caixa.
    const mail = await lastMail(
      harness.mailDirectory,
      'organization-invitation',
      email.toLowerCase(),
    );

    if (mail === undefined) {
      throw new Error(`Nenhum e-mail de convite capturado para ${email}.`);
    }

    return {
      token: tokenFromLink(mail),
      invitationId: body<{ data: { id: string } }>(created).data.id,
    };
  }

  function accept(token: string, accessToken: string) {
    return harness.app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { token },
    });
  }

  it('liga uma conta existente à organização com o papel do convite', async () => {
    const email = uniqueEmail('convidado-feliz');
    const guest = await registerAndLogin(harness, {
      name: 'Gabriel Convidado',
      email,
      password: 'senha-do-convidado-feliz',
      organizationName: 'Workspace do Gabriel',
    });

    const { token } = await invite(email, 'admin');
    const response = await accept(token, guest.accessToken);

    expect(response.statusCode).toBe(200);

    const accepted = body<AcceptedBody>(response).data;

    expect(accepted.organization.id).toBe(owner.organizationId);
    expect(accepted.member.role).toBe('admin');
    expect(accepted.member.status).toBe('active');
    expect(accepted.member.user.id).toBe(guest.userId);
    // O papel vem acompanhado do que ele permite: é o que a interface desenha.
    expect(accepted.organization.permissions).toContain('members.invite');

    // O convite foi consumido — e o token não sobreviveu à resposta.
    expect(response.payload).not.toContain(token);

    const invitation = await harness.app.db.manager.find(invitations, {
      where: { organizationId: owner.organizationId, email },
    });

    expect(invitation[0]?.status).toBe('accepted');
    expect(invitation[0]?.acceptedByUserId).toBe(guest.userId);

    // E `me` passa a enxergar as duas organizações.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${guest.accessToken}` },
    });

    const organizations = body<{ data: { organizations: { id: string }[] } }>(me).data
      .organizations;

    expect(organizations.map((item) => item.id)).toContain(owner.organizationId);
    expect(organizations).toHaveLength(2);
  });

  it('recusa quem tem o token mas não é a pessoa convidada', async () => {
    const invitedEmail = uniqueEmail('convidado-legitimo');
    const intruder = await registerAndLogin(harness, {
      name: 'Ivo Intruso',
      email: uniqueEmail('intruso'),
      password: 'senha-do-intruso-do-hub',
      organizationName: 'Workspace do Ivo',
    });

    const { token } = await invite(invitedEmail, 'admin');
    const response = await accept(token, intruder.accessToken);

    expect(response.statusCode).toBe(403);
    expect(body<{ error: { code: string; message: string } }>(response).error.code).toBe(
      'INVITATION_EMAIL_MISMATCH',
    );

    // A mensagem não entrega para quem o convite foi.
    expect(body<{ error: { message: string } }>(response).error.message).not.toContain(
      invitedEmail,
    );

    // Nada foi criado, e o convite continua valendo para quem é de direito.
    const members = await harness.app.db.manager.find(organizationMembers, {
      where: { organizationId: owner.organizationId, userId: intruder.userId },
    });

    expect(members).toHaveLength(0);

    const invitation = await harness.app.db.manager.find(invitations, {
      where: { organizationId: owner.organizationId, email: invitedEmail },
    });

    expect(invitation[0]?.status).toBe('pending');
  });

  it('compara o endereço ignorando a caixa das letras', async () => {
    const email = uniqueEmail('caixa-alta');
    const guest = await registerAndLogin(harness, {
      name: 'Carla Caixa',
      email,
      password: 'senha-da-carla-caixa-alta',
      organizationName: 'Workspace da Carla',
    });

    // `emailSchema` já normaliza na borda, então convidar em maiúsculas grava
    // minúsculas. A comparação do serviço é a segunda linha de defesa, para
    // linhas que não passaram por essa borda — é ela que este teste exercita,
    // reescrevendo o endereço gravado.
    const { token, invitationId } = await invite(email.toUpperCase(), 'viewer');

    await harness.app.db.manager.update(
      invitations,
      { id: invitationId },
      { email: email.toUpperCase() },
    );

    const response = await accept(token, guest.accessToken);

    expect(response.statusCode).toBe(200);
    expect(body<AcceptedBody>(response).data.member.role).toBe('viewer');
  });

  it('exige endereço confirmado antes de aceitar', async () => {
    const email = uniqueEmail('nao-verificado');
    const password = 'senha-de-quem-nao-verificou';

    // Cadastro sem passar pela verificação de e-mail.
    const registration = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        name: 'Nina Naoverificada',
        email,
        password,
        organizationName: 'Workspace da Nina',
        acceptedTerms: true,
      },
    });

    expect(registration.statusCode).toBe(202);

    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });

    const accessToken = body<{ data: { tokens: { accessToken: string } } }>(login).data.tokens
      .accessToken;

    const { token } = await invite(email);
    const response = await accept(token, accessToken);

    expect(response.statusCode).toBe(403);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('distingue convite vencido, cancelado e já usado', async () => {
    // --- vencido -----------------------------------------------------------
    const expiredEmail = uniqueEmail('vencido');
    const expiredGuest = await registerAndLogin(harness, {
      name: 'Valter Vencido',
      email: expiredEmail,
      password: 'senha-do-convite-vencido',
      organizationName: 'Workspace do Valter',
    });

    const expired = await invite(expiredEmail);

    await harness.app.db.manager.update(
      invitations,
      { id: expired.invitationId },
      { expiresAt: new Date(Date.now() - 1_000) },
    );

    const expiredResponse = await accept(expired.token, expiredGuest.accessToken);

    expect(expiredResponse.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(expiredResponse).error.code).toBe(
      'INVITATION_EXPIRED',
    );

    // O estado é corrigido no banco, o que libera o índice único para um convite novo.
    const afterExpiry = await harness.app.db.manager.find(invitations, {
      where: { id: expired.invitationId },
    });

    expect(afterExpiry[0]?.status).toBe('expired');

    // --- cancelado ---------------------------------------------------------
    const revokedEmail = uniqueEmail('cancelado');
    const revokedGuest = await registerAndLogin(harness, {
      name: 'Rita Revogada',
      email: revokedEmail,
      password: 'senha-do-convite-revogado',
      organizationName: 'Workspace da Rita',
    });

    const revoked = await invite(revokedEmail);

    await harness.app.db.manager.update(
      invitations,
      { id: revoked.invitationId },
      { status: 'revoked', revokedAt: new Date() },
    );

    const revokedResponse = await accept(revoked.token, revokedGuest.accessToken);

    expect(revokedResponse.statusCode).toBe(409);
    expect(body<{ error: { code: string } }>(revokedResponse).error.code).toBe(
      'INVITATION_REVOKED',
    );

    // --- já usado por outra pessoa ----------------------------------------
    // O mesmo token, apresentado por quem não o consumiu, é conflito e não
    // "endereço errado": o convite acabou.
    const usedEmail = uniqueEmail('ja-usado');
    const usedGuest = await registerAndLogin(harness, {
      name: 'Ulisses Usado',
      email: usedEmail,
      password: 'senha-do-convite-ja-usado',
      organizationName: 'Workspace do Ulisses',
    });

    const used = await invite(usedEmail);

    await harness.app.db.manager.update(
      invitations,
      { id: used.invitationId },
      { status: 'accepted', acceptedAt: new Date(), acceptedByUserId: owner.userId },
    );

    const usedResponse = await accept(used.token, usedGuest.accessToken);

    expect(usedResponse.statusCode).toBe(409);
    expect(body<{ error: { code: string } }>(usedResponse).error.code).toBe(
      'INVITATION_ALREADY_USED',
    );

    // Os três códigos são diferentes entre si — que é o ponto do teste.
    expect(
      new Set([
        body<{ error: { code: string } }>(expiredResponse).error.code,
        body<{ error: { code: string } }>(revokedResponse).error.code,
        body<{ error: { code: string } }>(usedResponse).error.code,
      ]).size,
    ).toBe(3);
  });

  it('recusa token que não existe', async () => {
    const guest = await registerAndLogin(harness, {
      name: 'Tania Token',
      email: uniqueEmail('token-inexistente'),
      password: 'senha-do-token-inexistente',
      organizationName: 'Workspace da Tania',
    });

    const response = await accept('nao-existe-este-token-de-convite', guest.accessToken);

    expect(response.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(response).error.code).toBe(
      'INVITATION_NOT_FOUND',
    );
  });

  it('exige autenticação', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: 'um-token-de-convite-qualquer' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('duas aceitações simultâneas criam uma associação só', async () => {
    const email = uniqueEmail('corrida');
    const guest = await registerAndLogin(harness, {
      name: 'Cora Corrida',
      email,
      password: 'senha-da-corrida-paralela',
      organizationName: 'Workspace da Cora',
    });

    const { token } = await invite(email, 'developer');

    // As duas partem juntas: é a única forma de exercitar a corrida de verdade.
    const [first, second] = await Promise.all([
      accept(token, guest.accessToken),
      accept(token, guest.accessToken),
    ]);

    // Nenhuma das duas pode ser erro do servidor.
    expect(first.statusCode).toBeLessThan(500);
    expect(second.statusCode).toBeLessThan(500);

    // A pessoa clicou duas vezes e entrou: as duas respostas dizem isso.
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(body<AcceptedBody>(first).data.member.id).toBe(
      body<AcceptedBody>(second).data.member.id,
    );

    // E o banco tem exatamente uma linha.
    const members = await harness.app.db.manager.find(organizationMembers, {
      where: { organizationId: owner.organizationId, userId: guest.userId },
    });

    expect(members).toHaveLength(1);
  });

  it('grava a associação na auditoria e o evento no outbox', async () => {
    const email = uniqueEmail('rastro');
    const guest = await registerAndLogin(harness, {
      name: 'Rui Rastro',
      email,
      password: 'senha-do-rastro-de-convite',
      organizationName: 'Workspace do Rui',
    });

    const { token } = await invite(email, 'developer');
    const response = await accept(token, guest.accessToken);

    expect(response.statusCode).toBe(200);

    const memberId = body<AcceptedBody>(response).data.member.id;

    // Auditoria: `audit.read` é de owner e admin, então quem lê é o dono.
    const audit = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit?action=invitation.accepted',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(audit.statusCode).toBe(200);

    const entries = body<{
      data: {
        items: {
          action: string;
          resourceId: string | null;
          actorUser: { id: string } | null;
          metadata: Record<string, unknown> | null;
        }[];
      };
    }>(audit).data.items;

    const entry = entries.find((item) => item.resourceId === memberId);

    expect(entry, 'a associação precisa aparecer na auditoria da organização').toBeDefined();
    expect(entry?.actorUser?.id).toBe(guest.userId);
    expect(entry?.metadata?.['role']).toBe('developer');

    // Evento de domínio: gravado no outbox, na mesma transação da escrita.
    const events = await harness.app.db.manager.find(outboxMessages, {
      where: { aggregateId: memberId, eventType: 'member.joined' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.organizationId).toBe(owner.organizationId);
    expect(events[0]?.payload).toMatchObject({ memberId, userId: guest.userId, role: 'developer' });
  });
});

describe.skipIf(probe.ok)('aceitar convite com conta existente (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
