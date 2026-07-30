import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CHAT_VIEW_ID, CHAT_VIEW_SECONDARY_ID, EXTENSION_ID } from '../constants';
import { assertNoCredentialLike, getApi } from './helpers';

const COMMANDS = [
  'prometheon.openChat',
  'prometheon.newLocalChat',
  'prometheon.configureWorkspace',
  'prometheon.initializeWorkspace',
  'prometheon.selectMainAgent',
  'prometheon.selectWorkMode',
  'prometheon.selectAutonomy',
  'prometheon.disableBypassPermissions',
  'prometheon.openSettings',
  'prometheon.showDiagnostics',
];

suite('Extensão', () => {
  test('ativa e expõe a API interna', async () => {
    const api = await getApi();
    assert.ok(api.core);
    assert.ok(api.registry);
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
  });

  test('registra todos os comandos declarados', async () => {
    await getApi();
    const registered = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) {
      assert.ok(registered.includes(command), `comando ausente: ${command}`);
    }
  });

  test('declara a webview view no manifest', async () => {
    const packageJson = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes?: {
        views?: Record<string, { id: string; type?: string }[]>;
        viewsContainers?: Record<string, { id: string }[]>;
      };
    };

    // A view existe nos dois containers: Activity Bar e Secondary Side Bar.
    const declared = Object.values(packageJson.contributes?.views ?? {}).flat();
    for (const id of [CHAT_VIEW_ID, CHAT_VIEW_SECONDARY_ID]) {
      const view = declared.find((candidate) => candidate.id === id);
      assert.ok(view, `view não declarada: ${id}`);
      assert.equal(view.type, 'webview');
    }

    const containers = packageJson.contributes?.viewsContainers ?? {};
    assert.ok(containers['activitybar'], 'container da Activity Bar ausente');
    assert.ok(
      containers['secondarySidebar'],
      'container da Secondary Side Bar ausente — a chave é "secondarySidebar"',
    );
  });

  test('ambas as views do chat estão registradas no VS Code', async () => {
    await getApi();
    // registerWebviewViewProvider não é consultável; o proxy de foco de cada
    // view só existe quando ela foi contribuída e o provider registrado.
    const commands = await vscode.commands.getCommands(true);
    for (const id of [CHAT_VIEW_ID, CHAT_VIEW_SECONDARY_ID]) {
      assert.ok(commands.includes(`${id}.focus`), `view não registrada: ${id}`);
    }
  });

  test('gera diagnóstico sem expor segredos', async () => {
    const api = await getApi();
    const report = await api.core.buildDiagnostics();

    assert.match(report, /Extension version:/);
    assert.match(report, /Registered adapters: mock/);
    assert.match(report, /Bypass: inactive/);
    assertNoCredentialLike(report);
  });
});
