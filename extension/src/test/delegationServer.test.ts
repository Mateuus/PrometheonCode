import * as assert from 'node:assert/strict';
import { Logger } from '../logger';
import {
  DelegationServer,
  type DelegatableAgent,
  type DelegationEndpoint,
  type DelegationMode,
} from '../agents/DelegationServer';

/**
 * O servidor é falado por um processo de fora — o CLI do provedor. Testá-lo por
 * HTTP de verdade é o único jeito de garantir o que importa aqui: que a
 * ferramenta esteja no ar, que o token barre quem não o tem, e que o modo
 * chegue como foi pedido.
 */

interface Call {
  readonly agent: string;
  readonly task: string;
  readonly mode: DelegationMode;
}

async function rpc(
  endpoint: DelegationEndpoint,
  method: string,
  params?: unknown,
  token = endpoint.token,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

/** Texto da resposta de `tools/call`, como o modelo o recebe. */
function contentOf(body: unknown): string {
  const result = (body as { result?: { content?: { text?: string }[] } }).result;
  return result?.content?.[0]?.text ?? '';
}

suite('DelegationServer', () => {
  const agents: DelegatableAgent[] = [
    { name: 'Pesquisador', role: 'Researcher', description: 'Lê e resume.', slots: 2 },
  ];
  const calls: Call[] = [];
  let server: DelegationServer;
  let endpoint: DelegationEndpoint;

  suiteSetup(async () => {
    server = new DelegationServer(
      {
        listAgents: () => Promise.resolve(agents),
        delegate: (agent, task, mode) => {
          calls.push({ agent, task, mode });
          return Promise.resolve(`ok: ${agent}`);
        },
        collect: (ticket) => Promise.resolve(`nada para ${ticket}`),
        running: () =>
          Promise.resolve([
            {
              ticket: 'task_1',
              agent: 'Pesquisador',
              task: 'ler docs',
              mode: 'report' as const,
              seconds: 12,
            },
          ]),
      },
      new Logger(),
    );
    endpoint = await server.start();
  });

  suiteTeardown(() => {
    server.dispose();
  });

  test('escuta só no loopback e exige o token', async () => {
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const semToken = await rpc(endpoint, 'tools/list', undefined, 'token-errado');
    assert.equal(semToken.status, 401);
    // Qualquer processo da máquina alcança o loopback; o token é o que separa
    // o CLI que nós chamamos de quem só descobriu a porta.
    assert.deepEqual(calls, []);
  });

  test('mostra o que ainda está rodando, para não delegar duas vezes o mesmo', async () => {
    // Sem isto o orquestrador redelegou uma função que já estava em andamento,
    // e voltaram duas variantes do mesmo arquivo, em duas branches.
    const { body } = await rpc(endpoint, 'tools/call', { name: 'prometheon_status' });
    const text = contentOf(body);
    assert.match(text, /task_1/);
    assert.match(text, /"Pesquisador" \(report\)/);
    assert.match(text, /ler docs/);
  });

  test('anuncia as quatro ferramentas com o prefixo que o CLI usa', async () => {
    const { body } = await rpc(endpoint, 'tools/list');
    const names = ((body as { result: { tools: { name: string }[] } }).result.tools ?? []).map(
      (tool) => tool.name,
    );
    assert.deepEqual(names, [
      'prometheon_list_agents',
      'prometheon_delegate',
      'prometheon_status',
      'prometheon_collect',
    ]);
    assert.deepEqual(endpoint.toolNames, names.map((name) => `mcp__prometheon__${name}`));
  });

  test('a lista traz o nome isolado, com função e vagas', async () => {
    const { body } = await rpc(endpoint, 'tools/call', { name: 'prometheon_list_agents' });
    const text = contentOf(body);
    // O nome entre aspas e numa linha só: colado ao papel, o modelo copiava a
    // linha inteira e a delegação falhava na primeira tentativa.
    assert.match(text, /agent: "Pesquisador"/);
    assert.match(text, /role: Researcher/);
    assert.match(text, /can run: 2 task\(s\)/);
  });

  test('o modo chega como foi pedido, e o padrão não escreve em disco', async () => {
    calls.length = 0;
    await rpc(endpoint, 'tools/call', {
      name: 'prometheon_delegate',
      arguments: { agent: 'Pesquisador', task: 'pesquise', mode: 'changes' },
    });
    await rpc(endpoint, 'tools/call', {
      name: 'prometheon_delegate',
      arguments: { agent: 'Pesquisador', task: 'pesquise' },
    });
    await rpc(endpoint, 'tools/call', {
      name: 'prometheon_delegate',
      arguments: { agent: 'Pesquisador', task: 'pesquise', mode: 'inventado' },
    });

    assert.deepEqual(
      calls.map((call) => call.mode),
      ['changes', 'report', 'report'],
    );
  });

  test('argumento faltando vira erro de ferramenta, e não delegação', async () => {
    calls.length = 0;
    const { body } = await rpc(endpoint, 'tools/call', {
      name: 'prometheon_delegate',
      arguments: { agent: 'Pesquisador' },
    });
    assert.equal((body as { result: { isError?: boolean } }).result.isError, true);
    assert.deepEqual(calls, []);
  });

  test('a falha do worker volta como conteúdo, não derruba a chamada', async () => {
    // O orquestrador precisa ler o motivo para decidir o próximo passo; um erro
    // de protocolo esconderia isso dele.
    const quebrado = new DelegationServer(
      {
        listAgents: () => Promise.resolve([]),
        delegate: () => Promise.reject(new Error('sem vaga')),
        collect: () => Promise.resolve(''),
        running: () => Promise.resolve([]),
      },
      new Logger(),
    );
    const outro = await quebrado.start();
    const { status, body } = await rpc(outro, 'tools/call', {
      name: 'prometheon_delegate',
      arguments: { agent: 'x', task: 'y' },
    });
    assert.equal(status, 200);
    assert.equal((body as { result: { isError?: boolean } }).result.isError, true);
    assert.match(contentOf(body), /sem vaga/);
    quebrado.dispose();
  });
});
