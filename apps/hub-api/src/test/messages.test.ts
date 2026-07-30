/**
 * Conversas e mensagens.
 *
 * O que esta suíte precisa provar, e prova contra o MySQL real:
 *
 * 1. `sequence` é contíguo e único mesmo com escritas concorrentes;
 * 2. `message.created` vai para o outbox na **mesma transação** da mensagem —
 *    e não sobra evento quando a transação falha;
 * 3. envelope e partes são gravados juntos, e raciocínio bruto não entra;
 * 4. quem é da organização mas não do projeto não lê a conversa;
 * 5. a paginação por cursor não repete nem pula mensagem.
 */

import {
  conversations,
  messages,
  newId,
  outboxMessages,
  projectMembers,
} from '@prometheon/database';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MessageRepository } from '../modules/messages/repository.js';
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

interface MessageBody {
  data: {
    id: string;
    sequence: number;
    authorType: string;
    parts: { type: string; index: number; text?: string; summary?: string }[];
    contextRefs: { kind: string; reference: string }[];
  };
}

describe.skipIf(!probe.ok)('conversas e mensagens', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;
  let stranger: RegisteredUser;
  let organizationId: string;
  let projectId: string;
  let conversationId: string;

  async function postMessage(
    payload: Record<string, unknown>,
    token = owner.accessToken,
    target = conversationId,
  ) {
    return harness.app.inject({
      method: 'POST',
      url: `/v1/conversations/${target}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_messages' });

    owner = await registerAndLogin(harness, {
      name: 'Olivia Owner',
      email: uniqueEmail('owner'),
      password: 'senha-do-owner-de-mensagens',
      organizationName: 'Mensagens',
    });

    organizationId = owner.organizationId;

    const strangerEmail = uniqueEmail('stranger');
    const invitation = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: strangerEmail, role: 'developer' },
    });

    expect(invitation.statusCode, invitation.payload).toBe(201);

    await harness.authService.flushPendingMail();

    const mail = await lastMail(harness.mailDirectory, 'organization-invitation', strangerEmail);

    stranger = await registerAndLogin(harness, {
      name: 'Estela Estranha',
      email: strangerEmail,
      password: 'senha-de-quem-nao-e-do-projeto',
      invitationToken: tokenFromLink(mail!),
    });

    const project = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/projects`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Chat do time' },
    });

    projectId = body<{ data: { id: string } }>(project).data.id;

    const conversation = await harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/conversations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { title: 'Planejamento', initialMessage: 'Vamos começar.' },
    });

    expect(conversation.statusCode, conversation.payload).toBe(201);

    conversationId = body<{ data: { id: string } }>(conversation).data.id;
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('a conversa nasce com a primeira mensagem já na sequência 1', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(response.statusCode, response.payload).toBe(200);

    const items = body<{ data: { items: MessageBody['data'][] } }>(response).data.items;

    expect(items).toHaveLength(1);
    expect(items[0]?.sequence).toBe(1);
    expect(items[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Vamos começar.' });
  });

  it('grava envelope e partes ordenadas na mesma transação', async () => {
    const response = await postMessage({
      parts: [
        { type: 'text', text: 'Primeira parte' },
        {
          type: 'tool_call',
          toolCallId: 'call-1',
          toolName: 'search',
          arguments: { query: 'outbox' },
        },
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          status: 'ok',
          result: { hits: 3 },
          output: 'três resultados',
        },
      ],
      contextRefs: [{ kind: 'file', reference: 'src/app.ts', label: 'app' }],
    });

    expect(response.statusCode, response.payload).toBe(201);

    const message = body<MessageBody>(response).data;

    expect(message.parts.map((part) => part.index)).toEqual([0, 1, 2]);
    expect(message.parts.map((part) => part.type)).toEqual([
      'text',
      'tool_call',
      'tool_result',
    ]);
    expect(message.contextRefs).toEqual([
      { kind: 'file', reference: 'src/app.ts', label: 'app' },
    ]);
  });

  it('recusa resumo de raciocínio em mensagem de pessoa', async () => {
    const response = await postMessage({
      parts: [{ type: 'reasoning_summary', summary: 'pensei um pouco' }],
    });

    expect(response.statusCode).toBe(400);

    const error = body<{ error: { code: string; fields?: { path: string }[] } }>(response).error;

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fields?.[0]?.path).toBe('parts.0.type');
  });

  it('recusa resumo longo demais, que é raciocínio bruto com outro nome', async () => {
    const response = await postMessage({
      authorType: 'agent',
      authorAgentRunId: '01JQZZZZZZZZZZZZZZZZZZZZZZ',
      parts: [{ type: 'reasoning_summary', summary: 'x'.repeat(4_001) }],
    });

    expect(response.statusCode).toBe(400);
    expect(body<{ error: { message: string } }>(response).error.message).toContain(
      'Raw model reasoning is never stored',
    );
  });

  it('aceita resumo operacional de agente dentro do teto', async () => {
    const response = await postMessage({
      authorType: 'agent',
      authorAgentRunId: '01JQZZZZZZZZZZZZZZZZZZZZZZ',
      parts: [{ type: 'reasoning_summary', summary: 'Analisei três arquivos e propus um plano.' }],
    });

    expect(response.statusCode, response.payload).toBe(201);
    expect(body<MessageBody>(response).data.authorType).toBe('agent');
  });

  it('sequence não repete nem deixa buraco com escritas concorrentes', async () => {
    const before = await harness.app.db
      .select({ lastSequence: conversations.lastSequence })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    const start = before[0]?.lastSequence ?? 0;
    const total = 12;

    const responses = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        postMessage({ parts: [{ type: 'text', text: `concorrente ${String(index)}` }] }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode, response.payload).toBe(201);
    }

    const sequences = responses
      .map((response) => body<MessageBody>(response).data.sequence)
      .sort((left, right) => left - right);

    const expected = Array.from({ length: total }, (_, index) => start + index + 1);

    // Sem repetição e sem buraco: exatamente `start+1 ⬦ start+total`.
    expect(sequences).toEqual(expected);

    const rows = await harness.app.db
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    expect(new Set(rows.map((row) => row.sequence)).size).toBe(rows.length);
  });

  it('grava message.created no outbox junto da mensagem', async () => {
    const response = await postMessage({
      parts: [{ type: 'text', text: 'evento por favor' }],
    });

    expect(response.statusCode, response.payload).toBe(201);

    const message = body<MessageBody>(response).data;

    const events = await harness.app.db
      .select({
        eventType: outboxMessages.eventType,
        aggregateId: outboxMessages.aggregateId,
        aggregateSequence: outboxMessages.aggregateSequence,
        payload: outboxMessages.payload,
        publishedAt: outboxMessages.publishedAt,
      })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.eventType, 'message.created'),
          eq(outboxMessages.aggregateId, conversationId),
          eq(outboxMessages.aggregateSequence, message.sequence),
        ),
      );

    expect(events).toHaveLength(1);
    expect(events[0]?.publishedAt).toBeNull();
    expect(events[0]?.payload).toMatchObject({
      conversationId,
      messageId: message.id,
      sequence: message.sequence,
      authorType: 'user',
      status: 'complete',
    });
  });

  it('transação que falha não deixa mensagem, sequência nem evento', async () => {
    const repository = new MessageRepository(harness.app.db);

    const before = await harness.app.db
      .select({
        lastSequence: conversations.lastSequence,
        messageCount: conversations.messageCount,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    const outboxBefore = await harness.app.db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, conversationId));

    await expect(
      repository.create({
        organizationId,
        projectId,
        conversationId,
        authorType: 'user',
        authorUserId: owner.userId,
        authorAgentRunId: null,
        status: 'complete',
        parts: [{ sequence: 0, type: 'text', content: 'nunca gravada', payload: null, toolName: null }],
        contextRefs: [],
        dedupeKey: null,
        // Falha depois de tudo escrito: é o pior momento possível, e é
        // exatamente onde o outbox tem de provar que não sobrevive sozinho.
        onCommitted: () => {
          throw new Error('falha proposital dentro da transação');
        },
      }),
    ).rejects.toThrow('falha proposital');

    const after = await harness.app.db
      .select({
        lastSequence: conversations.lastSequence,
        messageCount: conversations.messageCount,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    // A sequência voltou atrás junto com a mensagem: nada de número queimado.
    expect(after[0]?.lastSequence).toBe(before[0]?.lastSequence);
    expect(after[0]?.messageCount).toBe(before[0]?.messageCount);

    const outboxAfter = await harness.app.db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, conversationId));

    expect(outboxAfter).toHaveLength(outboxBefore.length);
  });

  it('a mesma chave de idempotência não cria duas mensagens', async () => {
    const payload = {
      parts: [{ type: 'text', text: 'só uma vez' }],
      idempotencyKey: `idem-${Date.now().toString(36)}`,
    };

    const first = await postMessage(payload);
    const second = await postMessage(payload);

    expect(first.statusCode, first.payload).toBe(201);
    expect(second.statusCode, second.payload).toBe(201);
    expect(body<MessageBody>(second).data.id).toBe(body<MessageBody>(first).data.id);
    expect(body<MessageBody>(second).data.sequence).toBe(body<MessageBody>(first).data.sequence);
  });

  describe('autorização', () => {
    it('nega leitura a quem é da organização e não do projeto', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${stranger.accessToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { code: string } }>(response).error.code).toBe(
        'PROJECT_ACCESS_DENIED',
      );
    });

    it('nega escrita a quem é da organização e não do projeto', async () => {
      const response = await postMessage(
        { parts: [{ type: 'text', text: 'entrando sem convite' }] },
        stranger.accessToken,
      );

      expect(response.statusCode).toBe(403);
    });

    it('nega o viewer, que não tem chat.write', async () => {
      const email = uniqueEmail('viewer');
      const invitation = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { email, role: 'viewer' },
      });

      expect(invitation.statusCode, invitation.payload).toBe(201);

      await harness.authService.flushPendingMail();

      const mail = await lastMail(harness.mailDirectory, 'organization-invitation', email);
      const viewer = await registerAndLogin(harness, {
        name: 'Vera Viewer',
        email,
        password: 'senha-do-viewer-de-mensagens',
        invitationToken: tokenFromLink(mail!),
      });

      // Entra no projeto: o que barra daqui em diante é a permissão, não a
      // participação. (A rota para adicionar membro de projeto ainda não existe.)
      await harness.app.db.insert(projectMembers).values({
        id: newId(),
        organizationId,
        projectId,
        userId: viewer.userId,
        status: 'active',
      });

      const read = await harness.app.inject({
        method: 'GET',
        url: `/v1/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });

      expect(read.statusCode, read.payload).toBe(200);

      const write = await postMessage(
        { parts: [{ type: 'text', text: 'viewer escrevendo' }] },
        viewer.accessToken,
      );

      expect(write.statusCode).toBe(403);
      expect(body<{ error: { message: string } }>(write).error.message).toContain('chat.write');
    });

    it('nega sem credencial', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/conversations/${conversationId}/messages`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  it('pagina por cursor sem repetir nem pular mensagem', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        cursor === null
          ? `/v1/conversations/${conversationId}/messages?limit=5`
          : `/v1/conversations/${conversationId}/messages?limit=5&cursor=${encodeURIComponent(cursor)}`;

      const response = await harness.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      expect(response.statusCode, response.payload).toBe(200);

      const page = body<{
        data: {
          items: { sequence: number }[];
          pageInfo: { nextCursor: string | null };
        };
      }>(response).data;

      seen.push(...page.items.map((item) => item.sequence));
      cursor = page.pageInfo.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 30);

    const rows = await harness.app.db
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort((left, right) => left - right)).toEqual(
      rows.map((row) => row.sequence).sort((left, right) => left - right),
    );
  });

  it('afterSequence retoma a leitura de onde o cliente parou', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversationId}/messages?afterSequence=2&limit=3`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(response.statusCode, response.payload).toBe(200);

    const items = body<{ data: { items: { sequence: number }[] } }>(response).data.items;

    expect(items[0]?.sequence).toBe(3);
    // Leitura crescente: é assim que a retomada avança.
    expect(items.map((item) => item.sequence)).toEqual([...items.map((item) => item.sequence)].sort(
      (left, right) => left - right,
    ));
  });
});

describe.skipIf(probe.ok)('conversas e mensagens (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
