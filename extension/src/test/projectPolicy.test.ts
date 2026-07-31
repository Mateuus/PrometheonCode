import * as assert from 'node:assert/strict';
import { parseWebviewMessage } from '../views/messages';
import { preCommitHook, prepareCommitMsgHook } from '../workspace/GitPolicyService';
import {
  DEFAULT_GRAPH_OUTPUT_DIR,
  defaultConfig,
  normalizeConfig,
  type GitConfig,
  type GraphifyConfig,
} from '../workspace/types';

function graphConfig(overrides: Partial<GraphifyConfig> = {}): GraphifyConfig {
  return { ...defaultConfig('Projeto').knowledge.graphify, ...overrides };
}

function gitConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return { ...defaultConfig('Projeto').git, ...overrides };
}

suite('Configuração de grafo e de commit', () => {
  test('os padrões protegem quem não configurou nada', () => {
    const config = defaultConfig('Projeto');

    // O grafo nasce desligado: anunciar um grafo que não existe faria o agente
    // gastar turnos com um comando que vai falhar.
    assert.equal(config.knowledge.graphify.enabled, false);
    assert.equal(config.knowledge.graphify.rebuildCommand, '');
    assert.equal(config.knowledge.graphify.rebuildOn, 'commit');
    assert.equal(config.knowledge.graphify.blockOnHygieneFailure, true);
    // Coautoria de IA desligada por padrão: creditar um modelo como autor é uma
    // escolha do time, e o padrão seguro é não fazer o que ninguém pediu.
    assert.equal(config.git.coAuthoredBy, false);
    assert.equal(config.git.commitStyle, 'conventional');
  });

  test('o YAML lido volta tipado, e o campo inválido cai no padrão', () => {
    const config = normalizeConfig(
      {
        knowledge: {
          graphify: {
            enabled: true,
            outputDir: '  grafo  ',
            rebuildCommand: 'make graph',
            rebuildOn: 'sexta-feira',
            blockOnHygieneFailure: false,
          },
        },
        git: { coAuthoredBy: true, commitStyle: 'haiku', scopes: ['hub', ' hub ', '', 'docs'] },
      },
      'Projeto',
    );

    assert.equal(config.knowledge.graphify.enabled, true);
    assert.equal(config.knowledge.graphify.outputDir, 'grafo');
    assert.equal(config.knowledge.graphify.rebuildCommand, 'make graph');
    // Gatilho desconhecido não vira "nunca reconstruir": volta ao recomendado.
    assert.equal(config.knowledge.graphify.rebuildOn, 'commit');
    assert.equal(config.knowledge.graphify.blockOnHygieneFailure, false);
    assert.equal(config.git.coAuthoredBy, true);
    assert.equal(config.git.commitStyle, 'conventional');
    assert.deepEqual(config.git.scopes, ['hub', 'docs']);
  });

  test('um arquivo sem as seções novas continua abrindo', () => {
    const config = normalizeConfig({ version: 1, workspace: { name: 'Antigo' } }, 'Projeto');

    assert.equal(config.knowledge.graphify.outputDir, DEFAULT_GRAPH_OUTPUT_DIR);
    assert.equal(config.git.coAuthoredBy, false);
  });
});

suite('Mensagens de grafo e de commit vindas da webview', () => {
  test('o patch chega tipado e só com os campos enviados', () => {
    const message = parseWebviewMessage({
      type: 'graph.update',
      payload: { patch: { rebuildCommand: '  make graph  ', rebuildOn: 'run' } },
    });

    assert.deepEqual(message, {
      type: 'graph.update',
      payload: { patch: { rebuildCommand: 'make graph', rebuildOn: 'run' } },
    });
  });

  test('valor de tipo errado derruba a mensagem inteira', () => {
    // Nada de aproveitar o campo bom e descartar o ruim: metade de um patch
    // gravaria uma configuração que ninguém pediu.
    assert.equal(
      parseWebviewMessage({
        type: 'graph.update',
        payload: { patch: { enabled: 'sim', rebuildCommand: 'make graph' } },
      }),
      null,
    );
    assert.equal(
      parseWebviewMessage({ type: 'graph.update', payload: { patch: { rebuildOn: 'nunca' } } }),
      null,
    );
    assert.equal(
      parseWebviewMessage({ type: 'git.update', payload: { patch: { coAuthoredBy: 1 } } }),
      null,
    );
  });

  test('patch vazio é descartado, e comando gigante também', () => {
    assert.equal(parseWebviewMessage({ type: 'graph.update', payload: { patch: {} } }), null);
    assert.equal(
      parseWebviewMessage({
        type: 'graph.update',
        payload: { patch: { rebuildCommand: 'x'.repeat(1_001) } },
      }),
      null,
    );
  });

  test('os escopos chegam limpos e sem repetição', () => {
    const message = parseWebviewMessage({
      type: 'git.update',
      payload: { patch: { scopes: [' hub ', 'hub', '', 'docs'] } },
    });

    assert.deepEqual(message, { type: 'git.update', payload: { patch: { scopes: ['hub', 'docs'] } } });
  });
});

suite('Hooks gerados', () => {
  test('o pre-commit reconstrói o grafo e o adiciona ao mesmo commit', () => {
    const hook = preCommitHook(
      graphConfig({ rebuildOn: 'commit', rebuildCommand: 'make graph', outputDir: 'grafo' }),
    );

    assert.match(hook, /^#!\/bin\/sh/);
    assert.match(hook, /prometheon:generated/);
    assert.match(hook, /make graph/);
    // Sem o `git add`, o commit levaria código novo com grafo velho — a
    // dessincronia que o hook existe para evitar.
    assert.match(hook, /git add 'grafo'/);
    assert.match(hook, /--no-verify/);
  });

  test('sem gatilho de commit, o hook não reconstrói nada', () => {
    const hook = preCommitHook(graphConfig({ rebuildOn: 'manual', rebuildCommand: 'make graph' }));

    assert.doesNotMatch(hook, /make graph/);
    assert.match(hook, /exit 0/);
  });

  test('sem comando configurado, o gatilho de commit não inventa um', () => {
    const hook = preCommitHook(graphConfig({ rebuildOn: 'commit', rebuildCommand: '' }));

    assert.doesNotMatch(hook, /git add/);
  });

  test('o check de higiene barra o commit quando está ligado', () => {
    const blocking = preCommitHook(
      graphConfig({ rebuildOn: 'commit', rebuildCommand: 'make graph' }),
    );
    const permissive = preCommitHook(
      graphConfig({
        rebuildOn: 'commit',
        rebuildCommand: 'make graph',
        blockOnHygieneFailure: false,
      }),
    );

    assert.match(blocking, /higiene falhou/);
    assert.doesNotMatch(permissive, /higiene falhou/);
  });

  test('o portão entra antes do rebuild e aborta o commit', () => {
    const hook = preCommitHook(
      graphConfig({ gate: 'npm test', rebuildOn: 'commit', rebuildCommand: 'make graph' }),
    );

    assert.ok(hook.indexOf('npm test') < hook.indexOf('make graph'));
    assert.match(hook, /if ! npm test; then/);
  });

  test('o comando do usuário entra citado, sem quebrar o script', () => {
    const hook = preCommitHook(
      graphConfig({ rebuildOn: 'commit', rebuildCommand: 'make graph', outputDir: "gra'fo" }),
    );

    // Uma aspa no nome da pasta não pode fechar a string e virar outro comando.
    assert.match(hook, /git add 'gra'\\''fo'/);
  });

  test('o prepare-commit-msg remove a coautoria de IA quando ela está desligada', () => {
    const hook = prepareCommitMsgHook(gitConfig({ coAuthoredBy: false }));

    assert.match(hook, /^#!\/bin\/sh/);
    assert.match(hook, /prometheon:generated/);
    assert.match(hook, /co-authored-by/i);
    assert.match(hook, /anthropic/i);
  });

  test('com coautoria permitida, o hook não mexe na mensagem', () => {
    const hook = prepareCommitMsgHook(gitConfig({ coAuthoredBy: true }));

    assert.doesNotMatch(hook, /co-authored-by/i);
    assert.match(hook, /exit 0/);
  });
});
