import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CHAT_VIEW_ID, EXTENSION_ID } from '../constants';
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
      contributes?: { views?: Record<string, { id: string; type?: string }[]> };
    };
    const views = packageJson.contributes?.views?.['prometheon'] ?? [];
    const chatView = views.find((view) => view.id === CHAT_VIEW_ID);
    assert.ok(chatView, 'view do chat não declarada');
    assert.equal(chatView.type, 'webview');
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
