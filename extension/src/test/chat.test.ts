import * as assert from 'node:assert/strict';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentSession,
} from '../agents/AgentAdapter';
import { AgentRegistry } from '../agents/AgentRegistry';
import { LocalChatService } from '../chat/LocalChatService';
import { MAX_STEP_OUTPUT_CHARS } from '../chat/types';
import { Logger } from '../logger';
import { getApi, isPrometheonError } from './helpers';

const hubNotConfigured = isPrometheonError('HubNotConfiguredError', 'hub.not-configured');

/**
 * Adaptador de roteiro fixo. Existe para exercitar o contrato de passos sem
 * depender da sequência simulada do MockAgentAdapter, que pode mudar.
 */
class ScriptedAdapter implements AgentAdapter {
  readonly id = 'scripted';
  readonly displayName = 'Scripted Agent';
  readonly transport = 'mock' as const;
  readonly capabilities: AgentCapabilities = {
    chat: true,
    edit: false,
    delegate: false,
    terminal: false,
  };

  constructor(private readonly script: readonly AgentEvent[]) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  start(): Promise<AgentSession> {
    return Promise.resolve({ id: 'scripted-session', agentId: this.id, startedAt: Date.now() });
  }

  async *send(): AsyncIterable<AgentEvent> {
    for (const event of this.script) {
      yield await Promise.resolve(event);
    }
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Chat local isolado com um adaptador de roteiro. Usa o mesmo armazenamento da
 * extensão, mas um registro próprio, para não mexer no registro compartilhado.
 */
async function scriptedChat(
  script: readonly AgentEvent[],
): Promise<{ chat: LocalChatService; conversationId: string }> {
  const api = await getApi();
  const registry = new AgentRegistry();
  registry.register(new ScriptedAdapter(script));
  const chat = new LocalChatService(api.localState, registry, new Logger());
  const conversation = await chat.createConversation({ chatType: 'local' });
  return { chat, conversationId: conversation.id };
}

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

  test('os passos do agente chegam ao consumidor na ordem certa', async () => {
    const { chat, conversationId } = await scriptedChat([
      { type: 'status', status: 'working' },
      { type: 'thought', durationMs: 3200 },
      { type: 'tool.requested', toolId: 't1', tool: 'Read', title: 'a.ts', detail: '10 lines' },
      { type: 'tool.completed', toolId: 't1', output: 'const a = 1;' },
      { type: 'tool.requested', toolId: 't2', tool: 'Bash', title: 'npm test', detail: 'npm test' },
      { type: 'tool.completed', toolId: 't2', output: 'ok', failed: true },
      { type: 'completed', text: 'pronto' },
    ]);

    const seen: string[] = [];
    for await (const event of chat.sendMessage({
      conversationId,
      content: 'vai',
      workMode: 'edit',
      autonomy: 'auto',
      mainAgentId: 'scripted',
    })) {
      if (event.type === 'step.started' || event.type === 'step.completed') {
        seen.push(`${event.type}:${event.step.kind}:${event.step.tool}:${event.step.status}`);
      }
    }

    assert.deepEqual(seen, [
      'step.completed:thought:Thought:done',
      'step.started:tool:Read:running',
      'step.completed:tool:Read:done',
      'step.started:tool:Bash:running',
      'step.completed:tool:Bash:failed',
    ]);
  });

  test('os passos são persistidos e voltam em getMessages', async () => {
    const { chat, conversationId } = await scriptedChat([
      { type: 'thought', durationMs: 1500 },
      {
        type: 'tool.requested',
        toolId: 't1',
        tool: 'Write',
        title: 'ProviderProfileService.ts',
        detail: '147 lines',
      },
      { type: 'tool.completed', toolId: 't1', output: 'export class ProviderProfileService {}' },
      { type: 'completed', text: 'feito' },
    ]);

    for await (const _event of chat.sendMessage({
      conversationId,
      content: 'escreve',
      workMode: 'edit',
      autonomy: 'auto',
      mainAgentId: 'scripted',
    })) {
      // consome o stream até o fim
    }

    // Recarregar a conversa precisa devolver os passos junto da mensagem.
    const messages = await chat.getMessages(conversationId);
    const steps = messages[1]?.steps ?? [];
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.kind, 'thought');
    assert.equal(steps[0]?.durationMs, 1500);
    assert.equal(steps[1]?.tool, 'Write');
    assert.equal(steps[1]?.title, 'ProviderProfileService.ts');
    assert.equal(steps[1]?.detail, '147 lines');
    assert.equal(steps[1]?.status, 'done');
    assert.equal(steps[1]?.output, 'export class ProviderProfileService {}');
    assert.equal(steps[1]?.truncated, undefined);
  });

  test('a saída longa de um passo é truncada antes de persistir', async () => {
    const long = 'x'.repeat(MAX_STEP_OUTPUT_CHARS + 500);
    const { chat, conversationId } = await scriptedChat([
      { type: 'tool.requested', toolId: 't1', tool: 'Bash', title: 'cat big.log' },
      { type: 'tool.completed', toolId: 't1', output: long },
      { type: 'completed', text: 'ok' },
    ]);

    let emitted: { output?: string; truncated?: boolean } | null = null;
    for await (const event of chat.sendMessage({
      conversationId,
      content: 'lê',
      workMode: 'edit',
      autonomy: 'auto',
      mainAgentId: 'scripted',
    })) {
      if (event.type === 'step.completed') {
        emitted = event.step;
      }
    }

    assert.equal(emitted?.output?.length, MAX_STEP_OUTPUT_CHARS);
    assert.equal(emitted?.truncated, true);

    const messages = await chat.getMessages(conversationId);
    const step = messages[1]?.steps?.[0];
    assert.equal(step?.output?.length, MAX_STEP_OUTPUT_CHARS);
    assert.equal(step?.truncated, true);
  });

  test('um passo em andamento é fechado quando o run falha', async () => {
    const { chat, conversationId } = await scriptedChat([
      { type: 'tool.requested', toolId: 't1', tool: 'Bash', title: 'npm run build' },
      { type: 'failed', error: { name: 'BuildError', message: 'quebrou' } },
    ]);

    for await (const _event of chat.sendMessage({
      conversationId,
      content: 'build',
      workMode: 'edit',
      autonomy: 'auto',
      mainAgentId: 'scripted',
    })) {
      // consome o stream até o fim
    }

    const messages = await chat.getMessages(conversationId);
    assert.equal(messages[1]?.steps?.[0]?.status, 'failed');
  });

  test('o mock emite uma sequência de passos visível na interface', async () => {
    const api = await getApi();
    const conversation = await api.localChat.createConversation({ chatType: 'local' });

    for await (const _event of api.localChat.sendMessage({
      conversationId: conversation.id,
      content: 'mostra os passos',
      workMode: 'edit',
      autonomy: 'auto',
      mainAgentId: 'mock',
    })) {
      // consome o stream até o fim
    }

    const messages = await api.localChat.getMessages(conversation.id);
    const steps = messages[1]?.steps ?? [];
    assert.ok(
      steps.some((step) => step.kind === 'thought'),
      'esperava um passo de raciocínio',
    );
    assert.deepEqual(
      steps.filter((step) => step.kind === 'tool').map((step) => step.tool),
      ['Read', 'Write', 'Bash'],
    );
    assert.ok(steps.every((step) => step.status === 'done'));
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
