import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { EMPTY_PROJECT_POLICY } from '../permissions/types';
import { mergeGitignore } from '../workspace/WorkspaceInitializer';
import {
  PROMETHEON_DIR,
  CONFIG_FILE_NAME,
  DIRECTORIES_NEEDING_GITKEEP,
  GITIGNORE_ENTRIES,
  WORKSPACE_DIRECTORIES,
} from '../workspace/types';
import { assertNoCredentialLike, exists, getApi, readText, workspaceFolder } from './helpers';

suite('mergeGitignore', () => {
  test('preserva o conteúdo existente e acrescenta o que falta', () => {
    const existing = 'node_modules/\ndist/\n';
    const { content, added } = mergeGitignore(existing);

    assert.ok(content.startsWith(existing), 'o conteúdo original deve permanecer no início');
    assert.deepEqual(added, [...GITIGNORE_ENTRIES]);
    for (const line of ['node_modules/', 'dist/', ...GITIGNORE_ENTRIES]) {
      assert.ok(content.split(/\r?\n/).includes(line), `linha ausente: ${line}`);
    }
  });

  test('é idempotente', () => {
    const first = mergeGitignore('node_modules/\n');
    const second = mergeGitignore(first.content);

    assert.deepEqual(second.added, []);
    assert.equal(second.content, first.content);
  });

  test('não duplica entradas já presentes', () => {
    const existing = `# Prometheon\n.prometheon/local/\n`;
    const { content, added } = mergeGitignore(existing);

    assert.ok(!added.includes('.prometheon/local/'));
    assert.equal(content.split(/\r?\n/).filter((line) => line === '.prometheon/local/').length, 1);
  });

  test('lida com arquivo vazio', () => {
    const { content, added } = mergeGitignore('');
    assert.deepEqual(added, [...GITIGNORE_ENTRIES]);
    assert.ok(content.startsWith('# Prometheon\n'));
  });
});

suite('Inicialização do workspace', () => {
  suiteSetup(async () => {
    const api = await getApi();
    // Evita diálogos: com Edit + Auto a escrita de arquivo é liberada direto.
    api.permissions.update({
      workMode: 'edit',
      autonomy: 'auto',
      bypass: null,
      projectPolicy: EMPTY_PROJECT_POLICY,
    });
  });

  test('cria a estrutura .prometheon esperada', async () => {
    const api = await getApi();
    const folder = workspaceFolder();

    const outcome = await api.initializer.initializeCurrentWorkspace();
    assert.equal(outcome.kind, 'done', `resultado inesperado: ${JSON.stringify(outcome)}`);

    const root = vscode.Uri.joinPath(folder.uri, PROMETHEON_DIR);
    for (const relative of WORKSPACE_DIRECTORIES) {
      const uri = vscode.Uri.joinPath(root, ...relative.split('/'));
      const stat = await vscode.workspace.fs.stat(uri);
      assert.equal(stat.type, vscode.FileType.Directory, `esperava diretório: ${relative}`);
    }

    for (const relative of DIRECTORIES_NEEDING_GITKEEP) {
      assert.ok(
        await exists(vscode.Uri.joinPath(root, ...relative.split('/'), '.gitkeep')),
        `.gitkeep ausente em ${relative}`,
      );
    }

    assert.ok(await exists(vscode.Uri.joinPath(root, 'knowledge', 'Home.md')));
  });

  test('grava um prometheon.yaml válido e sem segredos', async () => {
    const api = await getApi();
    const configUri = vscode.Uri.joinPath(
      workspaceFolder().uri,
      PROMETHEON_DIR,
      CONFIG_FILE_NAME,
    );
    assert.ok(await exists(configUri));

    const text = await readText(configUri);
    assertNoCredentialLike(text);

    const parsed = parse(text) as Record<string, unknown>;
    assert.equal(parsed['version'], 1);

    const config = await api.workspace.readConfig();
    assert.ok(config);
    assert.equal(config.chat.defaultType, 'local');
    assert.equal(config.orchestration.mainAgent, 'mock');
    assert.equal(config.orchestration.maxWorkers, 3);
    assert.equal(config.knowledge.graphify.enabled, false);
    assert.equal(config.knowledge.obsidian.enabled, true);
    assert.deepEqual(config.knowledge.obsidian.paths, ['.prometheon/knowledge']);
    assert.equal(config.hub.enabled, false);
  });

  test('preserva o .gitignore que já existia', async () => {
    const uri = vscode.Uri.joinPath(workspaceFolder().uri, '.gitignore');
    const lines = (await readText(uri)).split(/\r?\n/);

    // A fixture nasce com estas duas linhas; elas não podem desaparecer.
    assert.ok(lines.includes('node_modules/'));
    assert.ok(lines.includes('dist/'));
    for (const entry of GITIGNORE_ENTRIES) {
      assert.ok(lines.includes(entry), `entrada não adicionada: ${entry}`);
    }
  });

  test('rodar de novo não recria nem sobrescreve', async () => {
    const api = await getApi();
    const configUri = vscode.Uri.joinPath(workspaceFolder().uri, PROMETHEON_DIR, CONFIG_FILE_NAME);

    const marker = '\n# comentário do time preservado\n';
    const original = await readText(configUri);
    await vscode.workspace.fs.writeFile(
      configUri,
      new TextEncoder().encode(original + marker),
    );

    const outcome = await api.initializer.initializeCurrentWorkspace();
    assert.equal(outcome.kind, 'done');
    if (outcome.kind === 'done') {
      assert.equal(outcome.createdConfig, false, 'não deveria recriar a configuração');
      assert.deepEqual(outcome.gitignoreAdded, [], 'não deveria acrescentar nada ao .gitignore');
    }

    const after = await readText(configUri);
    assert.ok(after.includes('# comentário do time preservado'));
  });

  test('atualizar a orquestração preserva comentários do arquivo', async () => {
    const api = await getApi();
    const configUri = vscode.Uri.joinPath(workspaceFolder().uri, PROMETHEON_DIR, CONFIG_FILE_NAME);

    await api.settings.updateOrchestration(configUri, { workMode: 'agent-team', maxWorkers: 5 });
    const text = await readText(configUri);

    assert.ok(text.includes('# comentário do time preservado'));
    assert.ok(text.includes('# Configuração compartilhável do Prometheon.'));

    const config = await api.workspace.readConfig();
    assert.equal(config?.orchestration.workMode, 'agent-team');
    assert.equal(config?.orchestration.maxWorkers, 5);
  });

  test('o workspace passa a ser reportado como configurado', async () => {
    const api = await getApi();
    const status = await api.workspace.status();
    assert.equal(status.configured, true);
    assert.equal(status.hasGit, true);
  });
});
