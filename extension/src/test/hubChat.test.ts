import * as assert from 'node:assert/strict';
import { EventInbox } from '../chat/WebChatService';
import { readConversation, readMessage, readProject } from '../hub/LiveHubClient';
import { parseFrame } from '../hub/realtime';

/**
 * A resposta do Hub chega como `unknown`. Estes testes fixam a regra da
 * fronteira: o que não casa com o contrato some inteiro, e nunca vira um
 * registro pela metade que a interface exibiria como se fosse real.
 */
suite('Hub — leitura das respostas', () => {
  test('projeto sem id ou sem nome é descartado', () => {
    assert.deepEqual(readProject({ id: 'prj_1', name: 'Prometheon', slug: 'prometheon' }), {
      id: 'prj_1',
      name: 'Prometheon',
      slug: 'prometheon',
    });

    for (const invalid of [null, undefined, 42, [], {}, { id: 'prj_1' }, { name: 'Sem id' }]) {
      assert.equal(readProject(invalid), null, `deveria recusar: ${JSON.stringify(invalid)}`);
    }
  });

  test('conversa sem título ainda é utilizável', () => {
    // Conversa recém-criada não tem título nem última mensagem; some da lista
    // seria pior do que mostrá-la como "Untitled", que é o que ela é.
    const parsed = readConversation({
      id: 'cnv_1',
      createdAt: '2026-07-30T12:00:00.000Z',
      lastMessageAt: null,
      messageCount: 0,
    });

    assert.equal(parsed?.title, 'Untitled');
    assert.equal(parsed?.updatedAt, parsed?.createdAt, 'sem mensagem, a criação ordena');
  });

  test('a última mensagem manda na ordenação da lista', () => {
    const parsed = readConversation({
      id: 'cnv_2',
      title: 'Refatorar o adapter',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastMessageAt: '2026-07-30T18:30:00.000Z',
      messageCount: 12,
    });

    assert.equal(parsed?.updatedAt, Date.parse('2026-07-30T18:30:00.000Z'));
    assert.equal(parsed?.messageCount, 12);
  });

  test('conversa sem id é descartada', () => {
    assert.equal(readConversation({ title: 'Sem id' }), null);
    assert.equal(readConversation('texto'), null);
  });

  test('só as partes de texto entram no corpo da mensagem', () => {
    // `tool_call` e `reasoning_summary` pertencem à timeline de passos.
    // Despejá-los aqui transformaria a resposta num log.
    const parsed = readMessage({
      id: 'msg_1',
      authorType: 'agent',
      status: 'complete',
      createdAt: '2026-07-30T12:00:00.000Z',
      authorUser: null,
      parts: [
        { type: 'text', content: 'Primeiro' },
        { type: 'reasoning_summary', content: 'não deve aparecer' },
        { type: 'tool_call', content: 'nem isto' },
        { type: 'text', content: 'Segundo' },
      ],
    });

    assert.equal(parsed?.content, 'Primeiro\n\nSegundo');
  });

  test('autor desconhecido derruba a mensagem, status desconhecido não', () => {
    const base = {
      id: 'msg_2',
      createdAt: '2026-07-30T12:00:00.000Z',
      parts: [{ type: 'text', content: 'oi' }],
    };

    // Um autor que não conhecemos mudaria de lado quem falou — é grave.
    assert.equal(readMessage({ ...base, authorType: 'robot', status: 'complete' }), null);
    // Um status novo só afeta a decoração; a mensagem continua legível.
    assert.equal(readMessage({ ...base, authorType: 'user', status: 'inventado' })?.status,
      'complete');
  });

  test('o nome de quem escreveu vem do autor, quando o Hub o informa', () => {
    const parsed = readMessage({
      id: 'msg_3',
      authorType: 'user',
      status: 'complete',
      createdAt: '2026-07-30T12:00:00.000Z',
      authorUser: { name: 'Mateus' },
      parts: [],
    });

    assert.equal(parsed?.authorName, 'Mateus');
    assert.equal(parsed?.content, '', 'mensagem sem parte de texto tem corpo vazio');
  });
});

suite('Hub — canal de tempo real', () => {
  test('só quadro de evento vira evento', () => {
    // `welcome`, `error` e heartbeat fazem parte do protocolo e não são falha;
    // tratá-los como erro encheria o log a cada batida do coração.
    for (const ignored of [
      JSON.stringify({ type: 'welcome', protocolVersion: 1 }),
      JSON.stringify({ type: 'error', code: 'x' }),
      JSON.stringify({ type: 'event' }),
      'não é json',
      '',
      42,
      null,
    ]) {
      assert.equal(parseFrame(ignored), null, `deveria ignorar: ${JSON.stringify(ignored)}`);
    }
  });

  test('a conversa é lida do agregado ou do dado, nessa ordem', () => {
    assert.deepEqual(
      parseFrame(
        JSON.stringify({
          type: 'event',
          event: {
            type: 'message.created',
            aggregate: { type: 'conversation', id: 'cnv_1', sequence: 4 },
            data: { messageId: 'msg_9' },
          },
        }),
      ),
      { type: 'message.created', conversationId: 'cnv_1', messageId: 'msg_9' },
    );

    // Publicador que não usa agregado de conversa ainda é entendido.
    assert.deepEqual(
      parseFrame(
        JSON.stringify({
          type: 'event',
          event: { type: 'message.updated', data: { conversationId: 'cnv_2', id: 'msg_3' } },
        }),
      ),
      { type: 'message.updated', conversationId: 'cnv_2', messageId: 'msg_3' },
    );
  });

  test('evento sem conversa não é descartado, só fica sem alvo', () => {
    // Eventos da organização (presença, dispositivo) chegam pelo mesmo canal.
    // Quem filtra por conversa os ignora; derrubá-los aqui seria decidir por ele.
    assert.deepEqual(
      parseFrame(JSON.stringify({ type: 'event', event: { type: 'presence.updated', data: {} } })),
      { type: 'presence.updated', conversationId: null, messageId: null },
    );
  });
});

suite('Web Chat — fim do run', () => {
  test('atividade acorda a espera na hora', async () => {
    const inbox = new EventInbox();
    setTimeout(() => {
      inbox.push('message.created');
    }, 5);

    assert.equal(await inbox.waitForActivity(1_000), true);
  });

  test('silêncio encerra o run em vez de esperar para sempre', async () => {
    // Não há evento de "terminei" no contrato do Hub. Sem este limite o painel
    // ficaria girando no "trabalhando" depois de o Hub já ter acabado.
    const inbox = new EventInbox();
    assert.equal(await inbox.waitForActivity(10), false);
  });

  test('evento chegado antes da espera não se perde', async () => {
    // O canal é assíncrono: o evento pode chegar entre uma volta e outra do
    // laço. Perdê-lo faria a resposta do agente nunca aparecer.
    const inbox = new EventInbox();
    inbox.push('message.created');

    assert.equal(await inbox.waitForActivity(10), true);
  });
});
