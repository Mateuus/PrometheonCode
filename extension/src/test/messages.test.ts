import * as assert from 'node:assert/strict';
import { MAX_MESSAGE_LENGTH, parseWebviewMessage } from '../views/messages';

suite('Validação das mensagens da webview', () => {
  test('aceita as mensagens sem payload', () => {
    for (const type of [
      'ui.ready',
      'chat.newLocal',
      'chat.clearLocal',
      'settings.open',
      'hub.connect.request',
    ]) {
      assert.deepEqual(parseWebviewMessage({ type }), { type });
    }
  });

  test('recusa qualquer coisa que não seja uma mensagem conhecida', () => {
    for (const raw of [
      null,
      undefined,
      42,
      'chat.send',
      [],
      {},
      { type: 123 },
      { type: 'chat.unknown' },
      { type: '__proto__' },
    ]) {
      assert.equal(parseWebviewMessage(raw), null, `deveria recusar: ${JSON.stringify(raw)}`);
    }
  });

  test('chat.send exige conteúdo com tamanho aceitável', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'chat.send', payload: { content: '  oi  ' } }), {
      type: 'chat.send',
      payload: { content: 'oi' },
    });

    assert.equal(parseWebviewMessage({ type: 'chat.send' }), null);
    assert.equal(parseWebviewMessage({ type: 'chat.send', payload: {} }), null);
    assert.equal(parseWebviewMessage({ type: 'chat.send', payload: { content: '   ' } }), null);
    assert.equal(parseWebviewMessage({ type: 'chat.send', payload: { content: 7 } }), null);
    assert.equal(
      parseWebviewMessage({
        type: 'chat.send',
        payload: { content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
      }),
      null,
      'payload acima do limite deve ser descartado',
    );
  });

  test('enums só aceitam valores declarados', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'chat.selectType', payload: { chatType: 'web' } }), {
      type: 'chat.selectType',
      payload: { chatType: 'web' },
    });
    assert.equal(
      parseWebviewMessage({ type: 'chat.selectType', payload: { chatType: 'telepathy' } }),
      null,
    );

    assert.deepEqual(
      parseWebviewMessage({ type: 'settings.setWorkMode', payload: { mode: 'agent-team' } }),
      { type: 'settings.setWorkMode', payload: { mode: 'agent-team' } },
    );
    assert.equal(
      parseWebviewMessage({ type: 'settings.setWorkMode', payload: { mode: 'destroy' } }),
      null,
    );

    assert.deepEqual(
      parseWebviewMessage({ type: 'settings.setAutonomy', payload: { autonomy: 'bypass' } }),
      { type: 'settings.setAutonomy', payload: { autonomy: 'bypass' } },
    );
    assert.equal(
      parseWebviewMessage({ type: 'settings.setAutonomy', payload: { autonomy: 'root' } }),
      null,
    );

    assert.equal(
      parseWebviewMessage({ type: 'workspace.initialize', payload: { choice: 'wipe-disk' } }),
      null,
    );
    assert.deepEqual(
      parseWebviewMessage({ type: 'workspace.initialize', payload: { choice: 'skip' } }),
      { type: 'workspace.initialize', payload: { choice: 'skip' } },
    );
  });

  test('identificadores precisam ser strings curtas e não vazias', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'chat.cancel', payload: { runId: 'run_1' } }), {
      type: 'chat.cancel',
      payload: { runId: 'run_1' },
    });
    assert.equal(parseWebviewMessage({ type: 'chat.cancel', payload: { runId: '' } }), null);
    assert.equal(parseWebviewMessage({ type: 'chat.cancel', payload: { runId: null } }), null);
    assert.equal(
      parseWebviewMessage({ type: 'agents.stop', payload: { sessionId: 'x'.repeat(200) } }),
      null,
    );
    assert.deepEqual(
      parseWebviewMessage({ type: 'settings.selectMainAgent', payload: { agentId: 'mock' } }),
      { type: 'settings.selectMainAgent', payload: { agentId: 'mock' } },
    );
  });

  test('campos extras não passam para o objeto validado', () => {
    const parsed = parseWebviewMessage({
      type: 'chat.send',
      payload: { content: 'oi', command: 'rm -rf /' },
    });
    assert.deepEqual(parsed, { type: 'chat.send', payload: { content: 'oi' } });
  });
});
