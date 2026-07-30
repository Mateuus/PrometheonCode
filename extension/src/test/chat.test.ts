import * as assert from 'node:assert/strict';
import { getApi, isPrometheonError } from './helpers';

const hubNotConfigured = isPrometheonError('HubNotConfiguredError', 'hub.not-configured');

suite('Chat', () => {
  test('alterna entre Local Chat e Web Chat', async () => {
    const api = await getApi();

    await api.core.setChatType('web');
    assert.equal(api.core.snapshot.chatType, 'web');
    // Sem Hub configurado o estado tem de continuar "local-only".
    assert.equal(api.core.snapshot.hub.state, 'local-only');

    await api.core.setChatType('local');
    assert.equal(api.core.snapshot.chatType, 'local');
  });

  test('WebChatService falha com HubNotConfiguredError', async () => {
    const api = await getApi();

    await assert.rejects(
      () => api.webChat.createConversation({ chatType: 'web' }),
      hubNotConfigured,
    );
    await assert.rejects(() => api.webChat.getMessages('qualquer'), hubNotConfigured);
    await assert.rejects(() => api.webChat.cancel('qualquer'), hubNotConfigured);

    await assert.rejects(async () => {
      for await (const _event of api.webChat.sendMessage({
        conversationId: 'qualquer',
        content: 'olá',
        workMode: 'plan',
        autonomy: 'manual',
        mainAgentId: 'mock',
      })) {
        assert.fail('não deveria produzir eventos sem Hub');
      }
    }, hubNotConfigured);

    // Listar é inofensivo e não deve explodir: apenas não há conversas remotas.
    assert.deepEqual(await api.webChat.listConversations(), []);
  });

  test('Local Chat aceita a mensagem e o mock responde com streaming', async () => {
    const api = await getApi();
    await api.core.setChatType('local');

    const conversation = await api.localChat.createConversation({ chatType: 'local' });
    const deltas: string[] = [];
    let completed: string | null = null;
    let userMessageId: string | null = null;

    for await (const event of api.localChat.sendMessage({
      conversationId: conversation.id,
      content: 'ping',
      workMode: 'edit',
      autonomy: 'auto',
      mainAgentId: 'mock',
    })) {
      switch (event.type) {
        case 'run.started':
          userMessageId = event.message.id;
          assert.equal(event.message.author, 'user');
          assert.equal(event.message.content, 'ping');
          break;
        case 'message.created':
          assert.equal(event.message.author, 'agent');
          assert.equal(event.message.agentName, 'Mock Agent');
          assert.equal(event.message.status, 'streaming');
          break;
        case 'message.delta':
          deltas.push(event.delta);
          break;
        case 'message.completed':
          completed = event.content;
          break;
        case 'run.failed':
          assert.fail(`run falhou: ${event.error.message}`);
          break;
        default:
          break;
      }
    }

    assert.ok(userMessageId, 'mensagem do usuário não foi persistida');
    assert.ok(deltas.length > 1, 'esperava mais de um pedaço no streaming');
    assert.ok(completed, 'run não foi concluído');
    assert.equal(completed, deltas.join(''));
    assert.match(completed, /Prometheon está funcionando/);
    // O modo e a autonomia usados aparecem na resposta simulada.
    assert.match(completed, /modo Edit/);
    assert.match(completed, /autonomia Auto/);

    const persisted = await api.localChat.getMessages(conversation.id);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[1]?.status, 'sent');
    assert.equal(persisted[1]?.content, completed);
  });

  test('a sessão nasce "Untitled" e é nomeada pela primeira mensagem', async () => {
    const api = await getApi();
    const conversation = await api.localChat.createConversation({ chatType: 'local' });
    assert.equal(conversation.title, 'Untitled');

    for await (const _event of api.localChat.sendMessage({
      conversationId: conversation.id,
      content: 'Como está o build?\nsegunda linha',
      workMode: 'plan',
      autonomy: 'manual',
      mainAgentId: 'mock',
    })) {
      // consome o stream até o fim
    }

    const summaries = await api.localChat.listConversations();
    const summary = summaries.find((item) => item.id === conversation.id);
    assert.equal(summary?.title, 'Como está o build?');
  });

  test('o histórico de sessões acompanha o tipo de chat selecionado', async () => {
    const api = await getApi();
    await api.core.setChatType('local');
    await api.core.newLocalChat();

    const opened = api.core.snapshot.conversationId;
    assert.ok(opened, 'esperava uma conversa aberta');
    assert.ok(
      api.core.snapshot.sessions.some((session) => session.id === opened),
      'a sessão aberta deve aparecer no histórico local',
    );
    assert.ok(api.core.snapshot.sessions.every((session) => session.chatType === 'local'));

    // Sem Hub não há sessões remotas para listar, e isso não pode quebrar a view.
    await api.core.setChatType('web');
    assert.deepEqual(api.core.snapshot.sessions, []);
    await api.core.setChatType('local');
  });

  test('a mensagem carrega as imagens anexadas até o agente', async () => {
    const api = await getApi();
    const conversation = await api.localChat.createConversation({ chatType: 'local' });

    let completed = '';
    for await (const event of api.localChat.sendMessage({
      conversationId: conversation.id,
      content: '',
      attachments: [
        { id: 'att_1', name: 'shot.png', mimeType: 'image/png', data: 'AAAA', byteSize: 3 },
      ],
      workMode: 'plan',
      autonomy: 'manual',
      mainAgentId: 'mock',
    })) {
      if (event.type === 'message.completed') {
        completed = event.content;
      }
    }

    const persisted = await api.localChat.getMessages(conversation.id);
    assert.equal(persisted[0]?.attachments?.length, 1);
    assert.equal(persisted[0]?.attachments?.[0]?.name, 'shot.png');
    assert.match(completed, /1 imagem/);

    // Uma mensagem só de imagem também nomeia a sessão.
    const summaries = await api.localChat.listConversations();
    assert.equal(summaries.find((item) => item.id === conversation.id)?.title, '1 image');
  });

  test('limpar a conversa local apaga só as mensagens', async () => {
    const api = await getApi();
    const conversation = await api.localChat.createConversation({ chatType: 'local' });

    for await (const _event of api.localChat.sendMessage({
      conversationId: conversation.id,
      content: 'algo',
      workMode: 'plan',
      autonomy: 'manual',
      mainAgentId: 'mock',
    })) {
      // consome o stream até o fim
    }
    assert.ok((await api.localChat.getMessages(conversation.id)).length > 0);

    await api.localChat.clearConversation(conversation.id);
    assert.deepEqual(await api.localChat.getMessages(conversation.id), []);

    const summaries = await api.localChat.listConversations();
    assert.ok(summaries.some((summary) => summary.id === conversation.id));
  });
});
