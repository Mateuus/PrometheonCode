import * as assert from 'node:assert/strict';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_LENGTH,
  base64ByteLength,
  parseWebviewMessage,
} from '../views/messages';

/** PNG 1x1 válido, usado como anexo de teste. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function attachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'shot.png', mimeType: 'image/png', data: PIXEL, byteSize: 68, ...overrides };
}

suite('Validação das mensagens da webview', () => {
  test('aceita as mensagens sem payload', () => {
    for (const type of [
      'ui.ready',
      'chat.newLocal',
      'chat.clearLocal',
      'chat.attachImages',
      'speech.start',
      'speech.stop',
      'speech.cancel',
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
      payload: { content: 'oi', attachments: [] },
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

  test('anexos: só imagem declarada, base64 válido e dentro do limite', () => {
    const parsed = parseWebviewMessage({
      type: 'chat.send',
      // Uma mensagem só com imagem é legítima: o print é a pergunta.
      payload: { content: '', attachments: [attachment()] },
    });
    assert.deepEqual(parsed, {
      type: 'chat.send',
      payload: {
        content: '',
        attachments: [
          {
            name: 'shot.png',
            mimeType: 'image/png',
            data: PIXEL,
            byteSize: base64ByteLength(PIXEL),
          },
        ],
      },
    });

    for (const invalid of [
      attachment({ mimeType: 'image/svg+xml' }),
      attachment({ mimeType: 'text/html' }),
      attachment({ data: 'não é base64!' }),
      attachment({ data: '' }),
      attachment({ name: '' }),
      attachment({ name: 42 }),
      'não é objeto',
    ]) {
      assert.equal(
        parseWebviewMessage({ type: 'chat.send', payload: { content: 'oi', attachments: [invalid] } }),
        null,
        `deveria recusar: ${JSON.stringify(invalid)}`,
      );
    }

    assert.equal(
      parseWebviewMessage({
        type: 'chat.send',
        payload: {
          content: 'oi',
          attachments: Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => attachment()),
        },
      }),
      null,
      'acima do número máximo de anexos',
    );

    assert.equal(
      parseWebviewMessage({
        type: 'chat.send',
        payload: {
          content: 'oi',
          attachments: [attachment({ data: 'A'.repeat(MAX_ATTACHMENT_BYTES * 2) })],
        },
      }),
      null,
      'anexo acima do limite de bytes',
    );

    assert.equal(
      parseWebviewMessage({ type: 'chat.send', payload: { content: 'oi', attachments: {} } }),
      null,
    );
  });

  test('o tamanho declarado do anexo é recalculado, não aceito', () => {
    const parsed = parseWebviewMessage({
      type: 'chat.send',
      payload: { content: 'oi', attachments: [attachment({ byteSize: 999_999 })] },
    });
    assert.equal(
      parsed?.type === 'chat.send' ? parsed.payload.attachments[0]?.byteSize : null,
      base64ByteLength(PIXEL),
    );
  });

  test('as dimensões do anexo são opcionais, mas precisam ser plausíveis', () => {
    const parsed = parseWebviewMessage({
      type: 'chat.send',
      payload: { content: 'oi', attachments: [attachment({ width: 420, height: 210 })] },
    });
    assert.deepEqual(
      parsed?.type === 'chat.send'
        ? [parsed.payload.attachments[0]?.width, parsed.payload.attachments[0]?.height]
        : null,
      [420, 210],
    );

    for (const invalid of [0, -3, 12.5, '420', Number.NaN, 1_000_000]) {
      assert.equal(
        parseWebviewMessage({
          type: 'chat.send',
          payload: { content: 'oi', attachments: [attachment({ width: invalid })] },
        }),
        null,
        `deveria recusar width=${String(invalid)}`,
      );
    }
  });

  test('o nome do anexo é reduzido ao nome do arquivo', () => {
    const parsed = parseWebviewMessage({
      type: 'chat.send',
      payload: { content: 'oi', attachments: [attachment({ name: '../../etc/passwd.png' })] },
    });
    assert.equal(
      parsed?.type === 'chat.send' ? parsed.payload.attachments[0]?.name : null,
      'passwd.png',
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
    assert.deepEqual(parsed, { type: 'chat.send', payload: { content: 'oi', attachments: [] } });
  });

  test('chat.openSession exige um identificador utilizável', () => {
    assert.deepEqual(
      parseWebviewMessage({ type: 'chat.openSession', payload: { conversationId: 'conv_1' } }),
      { type: 'chat.openSession', payload: { conversationId: 'conv_1' } },
    );
    assert.equal(parseWebviewMessage({ type: 'chat.openSession' }), null);
    assert.equal(
      parseWebviewMessage({ type: 'chat.openSession', payload: { conversationId: '' } }),
      null,
    );
  });
});
