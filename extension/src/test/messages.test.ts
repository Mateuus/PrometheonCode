import * as assert from 'node:assert/strict';
import {
  MAX_CONCURRENT_SESSIONS,
  MAX_MCP_NAME_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  MAX_TOOLS_PER_LIST,
} from '../core/types';
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

/** Agent Profile mínimo e válido; cada teste estraga um campo por vez. */
function agentProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Code Reviewer',
    providerProfileId: 'empresa1',
    role: 'reviewer',
    autonomyMode: 'manual',
    allowedTools: [],
    deniedTools: [],
    maxConcurrentSessions: 1,
    contextStrategy: 'project',
    enabled: true,
    ...overrides,
  };
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
      'accounts.refresh',
      'mcp.refresh',
      'mcp.import',
      'settings.openEditor',
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

  test('accounts.create só aceita provedor conhecido e nome utilizável', () => {
    assert.deepEqual(
      parseWebviewMessage({
        type: 'accounts.create',
        payload: { name: '  Mateus27  ', providerId: 'claude-code' },
      }),
      { type: 'accounts.create', payload: { name: 'Mateus27', providerId: 'claude-code' } },
    );

    for (const payload of [
      { name: 'Mateus27', providerId: 'chatgpt-cli' },
      { name: 'Mateus27' },
      { name: '   ', providerId: 'claude-code' },
      { name: 'x'.repeat(MAX_PROFILE_NAME_LENGTH + 1), providerId: 'claude-code' },
      { name: 42, providerId: 'claude-code' },
      { providerId: 'claude-code' },
    ]) {
      assert.equal(
        parseWebviewMessage({ type: 'accounts.create', payload }),
        null,
        `deveria recusar: ${JSON.stringify(payload)}`,
      );
    }
    assert.equal(parseWebviewMessage({ type: 'accounts.create' }), null);
  });

  test('agentProfiles.create exige o binding com uma conta', () => {
    const parsed = parseWebviewMessage({
      type: 'agentProfiles.create',
      payload: { profile: agentProfile() },
    });
    assert.deepEqual(parsed, {
      type: 'agentProfiles.create',
      payload: {
        profile: {
          name: 'Code Reviewer',
          providerProfileId: 'empresa1',
          role: 'reviewer',
          autonomyMode: 'manual',
          allowedTools: [],
          deniedTools: [],
          maxConcurrentSessions: 1,
          contextStrategy: 'project',
          enabled: true,
        },
      },
    });

    // Sem conta, com conta vazia ou com enum inventado a mensagem cai inteira.
    for (const invalid of [
      agentProfile({ providerProfileId: undefined }),
      agentProfile({ providerProfileId: '' }),
      agentProfile({ role: 'destroyer' }),
      agentProfile({ autonomyMode: 'bypass' }),
      agentProfile({ contextStrategy: 'global' }),
      agentProfile({ maxConcurrentSessions: 0 }),
      agentProfile({ maxConcurrentSessions: 2.5 }),
      agentProfile({ maxConcurrentSessions: MAX_CONCURRENT_SESSIONS + 1 }),
      agentProfile({ enabled: 'yes' }),
      agentProfile({ name: '' }),
      agentProfile({ allowedTools: 'Read' }),
      agentProfile({ allowedTools: [''] }),
      agentProfile({ allowedTools: Array.from({ length: MAX_TOOLS_PER_LIST + 1 }, () => 'Read') }),
      agentProfile({ model: 'x'.repeat(MAX_MODEL_LENGTH + 1) }),
      'não é objeto',
    ]) {
      assert.equal(
        parseWebviewMessage({ type: 'agentProfiles.create', payload: { profile: invalid } }),
        null,
        `deveria recusar: ${JSON.stringify(invalid)}`,
      );
    }
  });

  test('agentProfiles.update carrega o id e o perfil completo', () => {
    assert.deepEqual(
      parseWebviewMessage({
        type: 'agentProfiles.update',
        payload: { id: 'code-reviewer', profile: agentProfile({ model: ' opus-5 ' }) },
      }),
      {
        type: 'agentProfiles.update',
        payload: {
          id: 'code-reviewer',
          profile: {
            name: 'Code Reviewer',
            providerProfileId: 'empresa1',
            role: 'reviewer',
            model: 'opus-5',
            autonomyMode: 'manual',
            allowedTools: [],
            deniedTools: [],
            maxConcurrentSessions: 1,
            contextStrategy: 'project',
            enabled: true,
          },
        },
      },
    );

    assert.equal(
      parseWebviewMessage({ type: 'agentProfiles.update', payload: { profile: agentProfile() } }),
      null,
    );
    assert.equal(
      parseWebviewMessage({ type: 'agentProfiles.update', payload: { id: 'code-reviewer' } }),
      null,
    );
    assert.equal(
      parseWebviewMessage({ type: 'agentProfiles.setEnabled', payload: { id: 'a', enabled: 'sim' } }),
      null,
    );
    assert.deepEqual(
      parseWebviewMessage({ type: 'agentProfiles.setEnabled', payload: { id: 'a', enabled: false } }),
      { type: 'agentProfiles.setEnabled', payload: { id: 'a', enabled: false } },
    );
    assert.deepEqual(parseWebviewMessage({ type: 'agentProfiles.remove', payload: { id: 'a' } }), {
      type: 'agentProfiles.remove',
      payload: { id: 'a' },
    });
  });

  test('mcp.save valida o transporte e só aceita os campos dele', () => {
    assert.deepEqual(
      parseWebviewMessage({
        type: 'mcp.save',
        payload: {
          server: {
            name: ' filesystem ',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: [{ key: 'PORT', value: '3550' }],
            // Cabeçalho não pertence ao stdio: é descartado com o resto.
            headers: [{ key: 'Authorization', value: 'x' }],
            enabled: true,
          },
        },
      }),
      {
        type: 'mcp.save',
        payload: {
          server: {
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: [{ key: 'PORT', value: '3550' }],
            headers: [],
            enabled: true,
          },
        },
      },
    );

    assert.deepEqual(
      parseWebviewMessage({
        type: 'mcp.save',
        payload: {
          server: {
            name: 'origin-agls',
            transport: 'http',
            url: 'http://127.0.0.1:3550/mcp',
            headers: [],
            enabled: true,
          },
        },
      }),
      {
        type: 'mcp.save',
        payload: {
          server: {
            name: 'origin-agls',
            transport: 'http',
            args: [],
            env: [],
            url: 'http://127.0.0.1:3550/mcp',
            headers: [],
            enabled: true,
          },
        },
      },
    );

    for (const server of [
      { transport: 'stdio', command: 'npx', enabled: true },
      { name: 'fs', command: 'npx', enabled: true },
      { name: 'fs', transport: 'websocket', url: 'https://x.dev', enabled: true },
      { name: 'fs', transport: 'stdio', enabled: true },
      { name: 'fs', transport: 'stdio', command: 'npx' },
      { name: 'fs', transport: 'stdio', command: 'npx', enabled: true, args: 'oops' },
      { name: 'fs', transport: 'stdio', command: 'npx', enabled: true, args: [''] },
      { name: 'fs', transport: 'stdio', command: 'npx', enabled: true, env: { PORT: '1' } },
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        enabled: true,
        env: [{ key: 'PORT', value: 42 }],
      },
      { name: 'nome com espaço', transport: 'stdio', command: 'npx', enabled: true },
      { name: 'remoto', transport: 'http', url: 'ftp://example.com', enabled: true },
      { name: 'remoto', transport: 'http', url: 'not a url', enabled: true },
      { name: 'remoto', transport: 'sse', enabled: true },
      { name: 'x'.repeat(MAX_MCP_NAME_LENGTH + 1), transport: 'stdio', command: 'npx', enabled: true },
    ]) {
      assert.equal(
        parseWebviewMessage({ type: 'mcp.save', payload: { server } }),
        null,
        `deveria recusar: ${JSON.stringify(server)}`,
      );
    }

    assert.deepEqual(parseWebviewMessage({ type: 'mcp.remove', payload: { name: 'filesystem' } }), {
      type: 'mcp.remove',
      payload: { name: 'filesystem' },
    });
    assert.equal(parseWebviewMessage({ type: 'mcp.remove', payload: { name: '' } }), null);
    assert.deepEqual(
      parseWebviewMessage({ type: 'mcp.setEnabled', payload: { name: 'fs', enabled: true } }),
      { type: 'mcp.setEnabled', payload: { name: 'fs', enabled: true } },
    );
    assert.equal(parseWebviewMessage({ type: 'mcp.setEnabled', payload: { name: 'fs' } }), null);
  });

  test('as mensagens antigas de conta não existem mais', () => {
    // `accounts.add` abria um QuickPick; agora tudo acontece no painel.
    assert.equal(parseWebviewMessage({ type: 'accounts.add' }), null);
    assert.equal(parseWebviewMessage({ type: 'settings.open' }), null);
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
