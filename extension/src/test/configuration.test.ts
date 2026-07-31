import * as assert from 'node:assert/strict';
import { normalizeAgentProfile } from '../agents/AgentProfileStore';
import { resolveAgentProfiles } from '../agents/AgentProfileService';
import {
  contextWindowFor,
  modelWithoutWindow,
  type AccountSummary,
  type AgentProfile,
} from '../core/types';
import { buildEntry, looksLikeSecret, normalizeMcpEntry } from '../workspace/McpConfigStore';
import { getApi, isPrometheonError } from './helpers';

/** Agente válido em disco; cada caso estraga um campo por vez. */
function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    providerProfileId: 'empresa1',
    role: 'reviewer',
    autonomyMode: 'manual',
    allowedTools: ['Read'],
    deniedTools: [],
    skills: [],
    maxConcurrentSessions: 1,
    contextStrategy: 'project',
    enabled: true,
    ...overrides,
  };
}

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    profileId: 'empresa1',
    name: 'Empresa1',
    providerId: 'claude-code',
    providerName: 'Claude Code',
    configDirectory: '/tmp/empresa1',
    model: '',
    cliInstalled: true,
    authenticated: true,
    usage: {
      today: { input: 0, output: 0 },
      last7Days: { input: 0, output: 0 },
      total: { input: 0, output: 0 },
      runs: 0,
      lastRunAt: null,
    },
    ...overrides,
  };
}

suite('Agent Profiles — arquivo em disco', () => {
  test('aceita um agente completo e mantém só os campos conhecidos', () => {
    const parsed = normalizeAgentProfile(
      stored({ model: ' opus-5 ', systemPrompt: 'Revise com rigor.', extra: 'ignorado' }),
    );
    assert.deepEqual(parsed, {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      providerProfileId: 'empresa1',
      role: 'reviewer',
      model: 'opus-5',
      systemPrompt: 'Revise com rigor.',
      autonomyMode: 'manual',
      allowedTools: ['Read'],
      deniedTools: [],
      skills: [],
      maxConcurrentSessions: 1,
      contextStrategy: 'project',
      enabled: true,
    });
  });

  test('arquivo malformado é descartado em vez de virar execução errada', () => {
    for (const invalid of [
      null,
      undefined,
      42,
      'texto',
      [],
      {},
      stored({ id: '' }),
      stored({ providerProfileId: undefined }),
      stored({ providerProfileId: '  ' }),
      stored({ role: 'destroyer' }),
      stored({ autonomyMode: 'bypass' }),
      stored({ contextStrategy: 'global' }),
      stored({ maxConcurrentSessions: '1' }),
      stored({ maxConcurrentSessions: 0 }),
      stored({ maxConcurrentSessions: 999 }),
      stored({ enabled: 'sim' }),
      stored({ allowedTools: 'Read' }),
      stored({ allowedTools: [42] }),
      stored({ model: '' }),
    ]) {
      assert.equal(
        normalizeAgentProfile(invalid),
        null,
        `deveria recusar: ${JSON.stringify(invalid)}`,
      );
    }
  });
});

suite('Agent Profiles — binding com a conta', () => {
  test('agente sem Provider Profile é recusado com erro tipado', async () => {
    const api = await getApi();
    const draft = {
      name: 'Sem Conta',
      providerProfileId: '',
      role: 'reviewer' as const,
      autonomyMode: 'manual' as const,
      allowedTools: [],
      deniedTools: [],
      skills: [],
      maxConcurrentSessions: 1,
      contextStrategy: 'project' as const,
      enabled: true,
    };

    await assert.rejects(
      () => api.agentProfiles.create(draft),
      isPrometheonError('AgentProfileBindingRequiredError', 'agent-profile.binding-required'),
    );

    // Conta inexistente também falha: nada de cair em outro perfil.
    await assert.rejects(
      () => api.agentProfiles.create({ ...draft, providerProfileId: 'conta-que-nao-existe' }),
      isPrometheonError('AgentProfileBindingUnknownError', 'agent-profile.binding-unknown'),
    );

    assert.equal(
      (await api.agentProfiles.list()).some((profile) => profile.name === 'Sem Conta'),
      false,
      'nenhum agente pode ter sido gravado',
    );
  });

  test('agente criado guarda o binding pedido e sobrevive à releitura', async () => {
    const api = await getApi();
    const provider = await api.profiles.create({
      name: `Teste Binding ${Date.now()}`,
      providerId: 'claude-code',
    });

    let created: AgentProfile | null = null;
    try {
      created = await api.agentProfiles.create({
        name: 'Teste Reviewer',
        providerProfileId: provider.id,
        role: 'reviewer',
        model: 'configured-by-user',
        autonomyMode: 'manual',
        allowedTools: ['Read', 'Read'],
        deniedTools: ['Bash'],
        skills: [],
        maxConcurrentSessions: 2,
        contextStrategy: 'project',
        enabled: true,
      });

      assert.equal(created.providerProfileId, provider.id);
      // Ferramenta repetida é reduzida a uma; nada além disso é normalizado.
      assert.deepEqual(created.allowedTools, ['Read']);

      const reread = await api.agentProfiles.require(created.id);
      assert.equal(reread.providerProfileId, provider.id);
    } finally {
      if (created !== null) {
        await api.agentProfiles.remove(created.id);
      }
      await api.profiles.remove(provider.id);
      const { rmSync } = await import('node:fs');
      rmSync(provider.configDirectory, { recursive: true, force: true });
    }
  });

  test('binding quebrado vira aviso, e nunca outra conta', () => {
    const profile = normalizeAgentProfile(stored({ providerProfileId: 'sumiu' }));
    assert.ok(profile);
    const [summary] = resolveAgentProfiles([profile], [account()]);

    assert.ok(summary);
    assert.equal(summary.accountName, null);
    assert.equal(summary.accountAuthenticated, false);
    assert.match(summary.warning ?? '', /sumiu/);

    // Conta existente porém deslogada: o agente aparece, com o aviso certo.
    const bound = normalizeAgentProfile(stored());
    assert.ok(bound);
    const [signedOut] = resolveAgentProfiles([bound], [account({ authenticated: false })]);
    assert.equal(signedOut?.accountName, 'Empresa1');
    assert.match(signedOut?.warning ?? '', /not signed in/);
  });

  test('limite de concorrência é validado antes de gravar', async () => {
    const api = await getApi();
    await assert.rejects(
      () =>
        api.agentProfiles.create({
          name: 'Concorrente',
          providerProfileId: 'qualquer',
          role: 'implementer',
          autonomyMode: 'auto',
          allowedTools: [],
          deniedTools: [],
          skills: [],
          maxConcurrentSessions: 0,
          contextStrategy: 'isolated',
          enabled: true,
        }),
      isPrometheonError('InvalidAgentProfileError', 'agent-profile.invalid'),
    );
  });
});

suite('Servidores MCP — .mcp.json', () => {
  test('entrada stdio é lida com o padrão do formato', () => {
    // `type` ausente significa stdio, e campos desconhecidos são preservados.
    assert.deepEqual(
      normalizeMcpEntry('filesystem', {
        command: 'npx',
        args: [' -y ', '@modelcontextprotocol/server-filesystem'],
        env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        timeout: 30,
      }),
      {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: [{ key: 'GITHUB_TOKEN', value: '${GITHUB_TOKEN}' }],
        headers: [],
        enabled: true,
        preservedFields: ['timeout'],
        warnings: [],
      },
    );
  });

  test('entrada http exige url utilizável', () => {
    assert.deepEqual(
      normalizeMcpEntry('origin-agls', { type: 'http', url: 'http://127.0.0.1:3550/mcp' }),
      {
        name: 'origin-agls',
        transport: 'http',
        args: [],
        url: 'http://127.0.0.1:3550/mcp',
        env: [],
        headers: [],
        enabled: true,
        preservedFields: [],
        warnings: [],
      },
    );

    // `disabled` desliga sem apagar a configuração.
    const disabled = normalizeMcpEntry('sse-server', {
      type: 'sse',
      url: 'https://example.com/sse',
      disabled: true,
    });
    assert.equal(typeof disabled === 'string' ? null : disabled.enabled, false);
  });

  test('arquivo malformado é reportado, e não normalizado em silêncio', () => {
    const cases: [string, unknown][] = [
      ['fs', null],
      ['fs', 42],
      ['fs', 'texto'],
      ['fs', []],
      ['fs', {}],
      ['fs', { args: ['-y'] }],
      ['fs', { command: '' }],
      ['fs', { command: 'npx', args: 'oops' }],
      ['fs', { command: 'npx', args: [42] }],
      ['fs', { command: 'np\u0000x' }],
      ['fs', { command: 'npx', env: 'oops' }],
      ['fs', { command: 'npx', env: { KEY: 42 } }],
      ['fs', { command: 'npx', disabled: 'sim' }],
      ['fs', { type: 'websocket', url: 'https://example.com' }],
      ['fs', { type: 'http' }],
      ['fs', { type: 'http', url: 'ftp://example.com' }],
      ['fs', { type: 'http', url: 'not a url' }],
      ['nome com espaço', { command: 'npx' }],
      ['', { command: 'npx' }],
    ];

    for (const [name, value] of cases) {
      const result = normalizeMcpEntry(name, value);
      assert.equal(
        typeof result,
        'string',
        `deveria reportar problema: ${name} ${JSON.stringify(value)}`,
      );
    }
  });

  test('credencial em texto puro vira aviso, e o valor nunca aparece nele', () => {
    // Referência por nome de variável é o uso correto e não é apontada.
    assert.equal(looksLikeSecret({ key: 'GITHUB_TOKEN', value: '${GITHUB_TOKEN}' }), false);
    assert.equal(looksLikeSecret({ key: 'Authorization', value: 'MCP_TOKEN' }), false);
    assert.equal(looksLikeSecret({ key: 'PORT', value: '3550' }), false);

    assert.equal(looksLikeSecret({ key: 'Authorization', value: 'Bearer abcdef123456' }), true);
    assert.equal(looksLikeSecret({ key: 'api_key', value: 'sk-abcdef123456' }), true);
    assert.equal(looksLikeSecret({ key: 'X-Custom', value: 'ghp_abcdefghijklmnop' }), true);

    const parsed = normalizeMcpEntry('github', {
      type: 'http',
      url: 'https://example.com/mcp',
      // Valor inventado; o teste existe para provar que ele não aparece no aviso.
      headers: { Authorization: 'Bearer super-secret-value-123' }, // secret-scan:ignore
    });
    assert.notEqual(typeof parsed, 'string');
    const warnings = typeof parsed === 'string' ? [] : parsed.warnings;
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /Authorization/);
    assert.doesNotMatch(warnings[0] ?? '', /super-secret-value/, 'o valor não pode vazar no aviso');
  });

  test('a entrada gravada usa o formato do arquivo, e recusa rascunho inválido', () => {
    assert.deepEqual(
      buildEntry({
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pacote'],
        env: [{ key: 'PORT', value: '3550' }],
        headers: [],
        enabled: true,
      }),
      { command: 'npx', args: ['-y', 'pacote'], env: { PORT: '3550' } },
    );

    assert.deepEqual(
      buildEntry({
        name: 'origin-agls',
        transport: 'http',
        args: [],
        env: [],
        url: 'http://127.0.0.1:3550/mcp',
        headers: [],
        enabled: false,
      }),
      { type: 'http', url: 'http://127.0.0.1:3550/mcp', disabled: true },
    );

    for (const draft of [
      { name: 'fs', transport: 'stdio' as const, args: [], env: [], headers: [], enabled: true },
      {
        name: 'nome com espaço',
        transport: 'stdio' as const,
        command: 'npx',
        args: [],
        env: [],
        headers: [],
        enabled: true,
      },
      {
        name: 'remoto',
        transport: 'http' as const,
        args: [],
        env: [],
        url: 'ftp://example.com',
        headers: [],
        enabled: true,
      },
    ]) {
      assert.throws(
        () => buildEntry(draft),
        isPrometheonError('InvalidMcpServerError', 'mcp.server-invalid'),
      );
    }
  });

  test('a leitura responde sem lançar quando o arquivo não existe', async () => {
    const api = await getApi();
    const status = await api.mcp.status();
    assert.equal(typeof status.available, 'boolean');
    assert.ok(Array.isArray(status.servers));
    assert.ok(Array.isArray(status.problems));
    if (!status.available) {
      assert.equal(status.file, null);
      assert.match(status.message ?? '', /folder/i);
    } else {
      assert.match(status.file ?? '', /\.mcp\.json$/);
    }
  });
});

suite('Janela de contexto', () => {
  test('a marca do CLI vence a tabela', () => {
    // O CLI escreve a janela no nome do modelo. Ela manda: a mesma versão roda
    // com janelas diferentes conforme plano e flags da conta, e é o CLI quem
    // sabe qual delas está valendo agora.
    assert.equal(contextWindowFor('claude-opus-5[1m]'), 1_000_000);
    assert.equal(contextWindowFor('claude-opus-5[200k]'), 200_000);
    assert.equal(contextWindowFor('modelo-que-nao-conhecemos[500k]'), 500_000);
  });

  test('sem marca, a tabela responde', () => {
    assert.equal(contextWindowFor('claude-opus-5'), 1_000_000);
    assert.equal(contextWindowFor('claude-sonnet-5'), 1_000_000);
    assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200_000);
  });

  test('modelo desconhecido ou ausente cai no padrão em vez de sumir', () => {
    // Zero aqui apagaria o indicador; uma barra aproximada continua útil, e o
    // primeiro run corrige o número com o que o CLI reportar.
    assert.equal(contextWindowFor('modelo-do-futuro'), 200_000);
    assert.equal(contextWindowFor(''), 200_000);
    assert.equal(contextWindowFor(undefined), 200_000);
  });

  test('o rótulo perde a marca de janela, que já aparece no número', () => {
    assert.equal(modelWithoutWindow('claude-opus-5[1m]'), 'claude-opus-5');
    assert.equal(modelWithoutWindow('claude-opus-5'), 'claude-opus-5');
  });
});
