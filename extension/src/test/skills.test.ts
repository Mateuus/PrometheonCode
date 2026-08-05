import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  estimateTokens,
  extractTitle,
  isValidSkillName,
  parseSkillFile,
  promptDescription,
  SKILL_PROMPT_DESC_LIMIT,
} from '../skills/frontmatter';
import { buildSkillIndex, effectiveAutonomy, selectSkills } from '../skills/SkillIndexBuilder';
import { prunedMarker, resolveInside } from '../skills/SkillLoader';
import { ceilingOf } from '../skills/SkillRegistry';
import type { AgentProfile, CustomAgentRole, SkillSummary } from '../core/types';

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'test-driven-development',
    title: 'Test Driven Development',
    description: 'Enforce RED-GREEN-REFACTOR, tests before code.',
    category: 'software-development',
    scope: 'project',
    riskLevel: 'low',
    version: '1.0.0',
    license: 'MIT',
    author: 'Mateus Rodrigues',
    platforms: [],
    requiresMcp: [],
    autonomyCeiling: 'auto',
    bodyTokensEstimate: 900,
    supportFiles: [],
    path: '/tmp/skills/software-development/test-driven-development/SKILL.md',
    supported: true,
    ...overrides,
  };
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'implementer',
    name: 'Implementer',
    providerProfileId: 'empresa1',
    role: 'implementer',
    autonomyMode: 'auto',
    allowedTools: [],
    deniedTools: [],
    skills: [],
    maxConcurrentSessions: 1,
    contextStrategy: 'project',
    enabled: true,
    ...overrides,
  };
}

function role(skills: readonly string[]): CustomAgentRole {
  return {
    id: 'gameplay-pie-ue5-test',
    label: 'Gameplay PIE UE5 Test',
    description: 'Testes de gameplay em PIE.',
    basedOn: 'tester',
    skills,
    scope: 'project',
  };
}

suite('Skills', () => {
  test('o frontmatter é separado do corpo com as regras dos três hosts', () => {
    const { frontmatter, body } = parseSkillFile(
      '---\nname: plan\ndescription: Write a plan.\n---\n\n# Plan\n\nCorpo.\n',
    );

    assert.equal(frontmatter['name'], 'plan');
    assert.equal(frontmatter['description'], 'Write a plan.');
    assert.match(body, /^# Plan/);
  });

  test('um BOM antes do `---` não descarta o frontmatter', () => {
    // Editores gráficos do Windows gravam o BOM ao salvar como UTF-8; deixá-lo
    // no lugar quebraria o teste do `---` e a skill perderia os metadados.
    const { frontmatter } = parseSkillFile('﻿---\nname: plan\ndescription: x\n---\n\ncorpo');

    assert.equal(frontmatter['name'], 'plan');
  });

  test('o fechamento tolera espaço à direita', () => {
    const { frontmatter, body } = parseSkillFile('---\nname: plan\ndescription: x\n---  \ncorpo');

    assert.equal(frontmatter['name'], 'plan');
    assert.equal(body, 'corpo');
  });

  test('sem frontmatter válido o corpo volta inteiro, e não é erro', () => {
    for (const raw of ['# Só o corpo\n', '---\nname: plan\nsem fechamento']) {
      const { frontmatter, body } = parseSkillFile(raw);
      assert.deepEqual(frontmatter, {});
      assert.equal(body, raw);
    }
  });

  test('YAML malformado cai no modo tolerante em vez de derrubar a skill', () => {
    const { frontmatter } = parseSkillFile(
      '---\nname: plan\n  description: "aspas: erradas\nversion: 1.0.0\n---\ncorpo',
    );

    assert.equal(frontmatter['name'], 'plan');
    assert.equal(frontmatter['version'], '1.0.0');
  });

  test('a descrição do índice é cortada em 57 caracteres mais reticências', () => {
    const short = 'Enforce RED-GREEN-REFACTOR.';
    assert.equal(promptDescription(short), short);

    const long = 'x'.repeat(200);
    const cut = promptDescription(long);
    assert.equal(cut.length, SKILL_PROMPT_DESC_LIMIT);
    assert.ok(cut.endsWith('...'));
  });

  test('o nome segue a regra comum aos três hosts', () => {
    for (const valid of ['plan', 'unreal-mcp', 'p5js', 'a']) {
      assert.equal(isValidSkillName(valid), true, valid);
    }
    for (const invalid of ['Plan', '-plan', 'plan_b', 'plan.md', '', 'x'.repeat(65)]) {
      assert.equal(isValidSkillName(invalid), false, invalid);
    }
  });

  test('o título vem do primeiro `#`, com o nome como reserva', () => {
    assert.equal(extractTitle('# Unreal Engine MCP\n\ntexto', 'unreal-mcp'), 'Unreal Engine MCP');
    assert.equal(extractTitle('sem título', 'unreal-mcp'), 'unreal-mcp');
  });

  test('as skills do papel entram, e as que faltam são reportadas', () => {
    const catalog = [skill(), skill({ name: 'systematic-debugging' })];
    const selection = selectSkills(
      profile({ role: 'custom', customRoleId: 'gameplay-pie-ue5-test', skills: ['unreal-mcp'] }),
      role(['test-driven-development']),
      catalog,
    );

    assert.deepEqual(
      selection.loadable.map((entry) => entry.name),
      ['test-driven-development'],
    );
    assert.deepEqual(selection.missing, ['unreal-mcp']);
  });

  test('skill de outra plataforma não é oferecida, mas continua no catálogo', () => {
    const catalog = [skill({ name: 'imessage', supported: false }), skill()];
    const selection = selectSkills(
      profile({ skills: ['imessage', 'test-driven-development'] }),
      null,
      catalog,
    );

    assert.deepEqual(
      selection.loadable.map((entry) => entry.name),
      ['test-driven-development'],
    );
    assert.deepEqual(selection.missing, [], 'existe: só não roda aqui');
  });

  test('o orquestrador vê o catálogo inteiro quando pode delegar', () => {
    const catalog = [skill(), skill({ name: 'unreal-mcp', category: 'creative' })];
    const selection = selectSkills(
      profile({ role: 'orchestrator', skills: ['test-driven-development'] }),
      null,
      catalog,
      true,
    );

    assert.equal(selection.indexed.length, 2, 'precisa saber o que existe');
    assert.deepEqual(
      selection.loadable.map((entry) => entry.name),
      ['test-driven-development'],
      'mas só carrega o que é dele',
    );
  });

  test('sem delegação, nem o orquestrador paga pelo catálogo inteiro', () => {
    // Fora do modo de equipe não há a quem entregar: listar o que ele não pode
    // executar seria contexto pago por uma capacidade que aquele run não tem.
    const catalog = [skill(), skill({ name: 'unreal-mcp', category: 'creative' })];
    const selection = selectSkills(
      profile({ role: 'orchestrator', skills: ['test-driven-development'] }),
      null,
      catalog,
      false,
    );

    assert.deepEqual(
      selection.indexed.map((entry) => entry.name),
      ['test-driven-development'],
    );
    assert.ok(!buildSkillIndex(selection).includes('delegate'), 'não promete o que não há');
  });

  test('o índice marca com `*` o que o agente pode carregar', () => {
    const catalog = [skill(), skill({ name: 'unreal-mcp', category: 'creative' })];
    const index = buildSkillIndex(
      selectSkills(profile({ role: 'orchestrator', skills: ['unreal-mcp'] }), null, catalog, true),
    );

    assert.match(index, /^<available_skills>/);
    assert.match(index, /\* unreal-mcp:/);
    assert.match(index, /- test-driven-development:/);
  });

  test('a skill que o agente pode carregar vem com o caminho do arquivo', () => {
    // O índice não pode citar uma função de carga que não existe em CLI nenhum:
    // o agente tentaria chamá-la e desistiria da skill achando que ela falhou.
    // O que ele tem é a ferramenta de leitura, então o índice dá o caminho.
    const catalog = [skill({ path: '/tmp/skills/sd/test-driven-development/SKILL.md' })];
    const index = buildSkillIndex(
      selectSkills(profile({ skills: ['test-driven-development'] }), null, catalog),
    );

    assert.ok(index.includes('/tmp/skills/sd/test-driven-development/SKILL.md'));
    assert.ok(!index.includes('skill.load'), 'nenhuma função inexistente no prompt');
  });

  test('mesmo sem orçamento para a descrição, o caminho continua no índice', () => {
    // Sem ele a skill vira um nome que o agente não tem como abrir — pior do
    // que não estar no índice, porque parece disponível.
    const catalog = Array.from({ length: 30 }, (_, index) =>
      skill({ name: `skill-${String(index)}`, path: `/tmp/skills/s/skill-${String(index)}/SKILL.md`, description: 'x'.repeat(300) }),
    );
    const index = buildSkillIndex(
      selectSkills(
        profile({ skills: catalog.map((entry) => entry.name) }),
        null,
        catalog,
      ),
      200,
    );

    for (const entry of catalog) {
      assert.ok(index.includes(entry.path), `${entry.name} ficou sem caminho`);
    }
  });

  test('índice acima do orçamento perde a descrição, nunca o nome', () => {
    // A regra é dura: um agente que não sabe que a capacidade existe não pede
    // por ela, e o sintoma é igual ao de a skill não estar instalada.
    const catalog = Array.from({ length: 40 }, (_, index) =>
      skill({ name: `skill-${String(index)}`, description: 'x'.repeat(400) }),
    );
    const selection = selectSkills(profile({ role: 'orchestrator' }), null, catalog, true);
    const index = buildSkillIndex(selection, 200);

    for (const entry of catalog) {
      assert.ok(index.includes(entry.name), `${entry.name} sumiu do índice`);
    }
    assert.ok(!index.includes('xxxxx'), 'a descrição é que deveria cair');
  });

  test('uma skill nunca amplia a autonomia do agente — só a restringe', () => {
    const bypass = profile({ autonomyMode: 'bypass-temporary' });

    assert.equal(effectiveAutonomy(bypass, [skill({ autonomyCeiling: 'auto' })]), 'auto');
    assert.equal(effectiveAutonomy(bypass, [skill({ autonomyCeiling: 'manual' })]), 'manual');
    assert.equal(
      effectiveAutonomy(profile({ autonomyMode: 'manual' }), [
        skill({ autonomyCeiling: 'bypass-temporary' }),
      ]),
      'manual',
      'o teto da skill não promove o agente',
    );
  });

  test('skill que não declara teto não rebaixa quem está em bypass', () => {
    // Nenhuma das 33 skills instaladas declarava `autonomy_ceiling`, e o padrão
    // era `auto`: qualquer skill anexada derrubava para `auto` um agente posto
    // em bypass de propósito, com confirmação, e o aviso não dizia qual delas
    // tinha feito isso. O silêncio da skill não vale por uma opinião.
    assert.equal(ceilingOf({}), 'bypass-temporary');
    assert.equal(ceilingOf({ category: 'software-development' }), 'bypass-temporary');

    const bypass = profile({ autonomyMode: 'bypass-temporary' });
    assert.equal(
      effectiveAutonomy(bypass, [skill({ autonomyCeiling: ceilingOf({}) })]),
      'bypass-temporary',
      'o bypass escolhido no painel precisa sobreviver a uma skill calada',
    );
  });

  test('o que a skill declara continua valendo, e segredo vem antes de tudo', () => {
    assert.equal(ceilingOf({ autonomy_ceiling: 'manual' }), 'manual');
    assert.equal(ceilingOf({ autonomy_ceiling: 'auto' }), 'auto');
    assert.equal(
      ceilingOf({ autonomy_ceiling: 'bypass-temporary', risk: { handles_secrets: true } }),
      'manual',
      'skill que mexe com segredo não roda sozinha, diga o que disser o teto',
    );
    assert.equal(
      ceilingOf({ autonomy_ceiling: 'coisa-inventada' }),
      'bypass-temporary',
      'valor fora da escala é declaração nenhuma',
    );
  });

  test('referência só resolve dentro da própria skill', () => {
    const root = vscode.Uri.file('/tmp/skills/creative/unreal-mcp');

    assert.ok(resolveInside(root, 'references/pitfalls.md') !== null);
    assert.ok(resolveInside(root, 'scripts/run.py') !== null);

    for (const escape of [
      '../../../etc/passwd',
      'references/../../secret',
      'SKILL.md',
      'docs/leia.md',
      'references/sub/pasta.md',
      '',
    ]) {
      assert.equal(resolveInside(root, escape), null, `deveria recusar: ${escape}`);
    }
  });

  test('o marcador de compactação diz onde reler a skill', () => {
    assert.equal(
      prunedMarker('unreal-mcp', '1.0.0', '/tmp/skills/creative/unreal-mcp/SKILL.md'),
      '[SKILL_PRUNED: unreal-mcp@1.0.0; read it again at /tmp/skills/creative/unreal-mcp/SKILL.md]',
    );
    assert.match(prunedMarker('plan', null, '/tmp/plan/SKILL.md'), /^\[SKILL_PRUNED: plan;/);
  });

  test('a estimativa de tokens erra para mais, que é o lado seguro', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
  });
});
