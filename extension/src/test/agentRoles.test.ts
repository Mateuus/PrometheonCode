import * as assert from 'node:assert/strict';
import { mergeByPrecedence } from '../agents/AgentRoleService';
import {
  normalizeCustomRole,
  normalizeRoleList,
  roleId,
  stripFrontmatter,
} from '../agents/AgentRoleStore';
import { resolveAgentProfiles } from '../agents/AgentProfileService';
import {
  MAX_ROLE_DESCRIPTION_LENGTH,
  MAX_ROLE_LABEL_LENGTH,
  type AccountSummary,
  type AgentProfile,
  type AgentRoleScope,
  type CustomAgentRole,
} from '../core/types';

/** Papel válido em disco; cada caso estraga um campo por vez. */
function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gameplay-pie-ue5-test',
    label: 'Gameplay PIE UE5 Test',
    description: 'Roda testes de gameplay em PIE e relata o que quebrou.',
    basedOn: 'tester',
    skills: ['unreal-mcp', 'test-driven-development'],
    ...overrides,
  };
}

function role(id: string, scope: AgentRoleScope, label = id): CustomAgentRole {
  return { id, label, description: 'x', basedOn: 'tester', skills: [], scope };
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

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'tester',
    name: 'Tester',
    providerProfileId: 'empresa1',
    role: 'custom',
    customRoleId: 'gameplay-pie-ue5-test',
    autonomyMode: 'manual',
    allowedTools: [],
    deniedTools: [],
    skills: [],
    maxConcurrentSessions: 1,
    contextStrategy: 'project',
    enabled: true,
    ...overrides,
  };
}

suite('Papéis nomeados', () => {
  test('um papel gravado sobrevive à releitura com o escopo de onde veio', () => {
    const parsed = normalizeCustomRole(stored(), 'project');
    assert.deepEqual(parsed, {
      id: 'gameplay-pie-ue5-test',
      label: 'Gameplay PIE UE5 Test',
      description: 'Roda testes de gameplay em PIE e relata o que quebrou.',
      basedOn: 'tester',
      skills: ['unreal-mcp', 'test-driven-development'],
      scope: 'project',
    });
  });

  test('papel malformado é descartado inteiro, nunca corrigido em silêncio', () => {
    for (const invalid of [
      stored({ id: '' }),
      stored({ id: undefined }),
      stored({ label: '' }),
      stored({ label: 'x'.repeat(MAX_ROLE_LABEL_LENGTH + 1) }),
      stored({ description: undefined }),
      stored({ description: 'x'.repeat(MAX_ROLE_DESCRIPTION_LENGTH + 1) }),
      // `custom` não pode ser base de si mesmo, e um papel inventado não existe.
      stored({ basedOn: 'destroyer' }),
      stored({ basedOn: undefined }),
      stored({ skills: 'unreal-mcp' }),
      stored({ skills: [''] }),
      'não é objeto',
      null,
    ]) {
      assert.equal(
        normalizeCustomRole(invalid, 'project'),
        null,
        `deveria recusar: ${JSON.stringify(invalid)}`,
      );
    }
  });

  test('a lista aceita tanto `{roles: [...]}` quanto o array solto', () => {
    const warnings: string[] = [];
    const warn = (message: string): void => void warnings.push(message);

    const wrapped = normalizeRoleList({ version: 1, roles: [stored()] }, 'project', warn);
    const bare = normalizeRoleList([stored()], 'machine', warn);

    assert.equal(wrapped.length, 1);
    assert.equal(bare.length, 1);
    assert.equal(wrapped[0]?.scope, 'project');
    assert.equal(bare[0]?.scope, 'machine');
    assert.deepEqual(warnings, [], 'nenhum aviso para entrada válida');
  });

  test('id repetido no mesmo arquivo fica com o primeiro e avisa', () => {
    const warnings: string[] = [];
    const roles = normalizeRoleList(
      [stored(), stored({ label: 'Outro' }), 'lixo'],
      'project',
      (message) => void warnings.push(message),
    );

    assert.equal(roles.length, 1);
    assert.equal(roles[0]?.label, 'Gameplay PIE UE5 Test');
    assert.equal(warnings.length, 1, 'a entrada inválida precisa aparecer no log');
  });

  test('projeto vence Hub, que vence máquina — e o perdedor não é apagado', () => {
    const merged = mergeByPrecedence([
      [role('shared', 'project', 'Do projeto')],
      [role('shared', 'hub', 'Do Hub'), role('so-hub', 'hub', 'Só no Hub')],
      [role('shared', 'machine', 'Da máquina'), role('so-local', 'machine', 'Só local')],
    ]);

    // A lista sai ordenada por rótulo, para a interface; o que importa aqui é
    // de qual escopo cada id sobreviveu.
    assert.deepEqual(
      [...merged].sort((a, b) => a.id.localeCompare(b.id, 'en')).map((entry) => [entry.id, entry.scope]),
      [
        ['shared', 'project'],
        ['so-hub', 'hub'],
        ['so-local', 'machine'],
      ],
    );
    assert.equal(merged.find((entry) => entry.id === 'shared')?.label, 'Do projeto');
  });

  test('o id sai do rótulo, sem acento e sem colidir com o do vizinho', () => {
    assert.equal(roleId('Gameplay PIE UE5 Test'), 'gameplay-pie-ue5-test');
    // NFD separa o acento da letra: "Revisão" precisa virar "revisao".
    assert.equal(roleId('Revisão de Código'), 'revisao-de-codigo');
    assert.equal(roleId('  ---  '), '');
    assert.equal(roleId('x'.repeat(100)).length, 64);
  });

  test('agente cujo papel sumiu é avisado, e não reapontado para outro', () => {
    const [resolved] = resolveAgentProfiles([profile()], [account()], []);

    assert.equal(resolved?.customRole, null);
    assert.match(String(resolved?.warning), /does not exist here/);
  });

  test('papel resolvido aparece no resumo junto da conta', () => {
    const known = role('gameplay-pie-ue5-test', 'project', 'Gameplay PIE UE5 Test');
    const [resolved] = resolveAgentProfiles([profile()], [account()], [known]);

    assert.equal(resolved?.customRole?.label, 'Gameplay PIE UE5 Test');
    assert.equal(resolved?.warning, undefined);
  });

  test('o aviso do papel vem antes do da conta desconectada', () => {
    const [resolved] = resolveAgentProfiles(
      [profile()],
      [account({ authenticated: false })],
      [],
    );

    // Sem papel o agente não sabe o que é; entrar em sessão assim é o pior dos
    // dois casos, então é esse o aviso que a interface mostra.
    assert.match(String(resolved?.warning), /does not exist here/);
  });
});

suite('Prompt de função em arquivo', () => {
  test('o frontmatter sai e o corpo fica', () => {
    const raw = '---\nrole: teste\nextends: tester\n---\n\n# Missão\nFazer X.\n';
    assert.equal(stripFrontmatter(raw), '\n# Missão\nFazer X.\n');
  });

  test('arquivo sem frontmatter volta intacto', () => {
    assert.equal(stripFrontmatter('# Missão\nFazer X.\n'), '# Missão\nFazer X.\n');
  });

  test('um "---" no meio do corpo não é frontmatter', () => {
    // Só o cabeçalho do INÍCIO do arquivo é metadado; um separador horizontal
    // no meio do prompt é conteúdo e precisa sobreviver.
    const raw = '# Missão\n\n---\n\n## Sempre\n';
    assert.equal(stripFrontmatter(raw), raw);
  });

  test('frontmatter com CRLF também é cortado', () => {
    const raw = '---\r\nrole: t\r\n---\r\ncorpo\r\n';
    assert.equal(stripFrontmatter(raw), 'corpo\r\n');
  });
});
