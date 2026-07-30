import * as assert from 'node:assert/strict';
import { parseAuthStatus } from '../providers/ClaudeCodeAdapter';
import { getApi } from './helpers';

suite('Contas de provedor', () => {
  test('lê o status do Claude Code sem inventar campo nenhum', () => {
    const signedIn = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'pessoa@example.com',
        orgId: 'org_123',
        orgName: 'Organização',
        subscriptionType: 'max',
      }),
    );
    assert.deepEqual(signedIn, {
      authenticated: true,
      accountLabel: 'pessoa@example.com',
      organization: 'Organização',
      plan: 'max',
      authMethod: 'claude.ai',
    });

    // Perfil recém-criado: o CLI responde só o essencial, e nada é preenchido.
    assert.deepEqual(
      parseAuthStatus(JSON.stringify({ loggedIn: false, authMethod: 'none' })),
      { authenticated: false, authMethod: 'none' },
    );

    // `orgId` nunca vai para a interface: identifica a conta sem servir a ela.
    const parsed = parseAuthStatus(JSON.stringify({ loggedIn: true, orgId: 'org_123' }));
    assert.equal(JSON.stringify(parsed).includes('org_123'), false);
  });

  test('saída inesperada do CLI não vira conta autenticada', () => {
    for (const output of ['', 'not json', 'null', '"texto"', '[]']) {
      const parsed = parseAuthStatus(output);
      assert.equal(parsed.authenticated, false, `deveria recusar: ${output}`);
    }
  });

  test('perfis do mesmo provedor recebem diretórios diferentes', async () => {
    const api = await getApi();
    const created = [
      await api.profiles.create({ name: 'Teste Mateus27', providerId: 'claude-code' }),
      await api.profiles.create({ name: 'Teste Mateus27', providerId: 'claude-code' }),
    ];

    try {
      assert.notEqual(created[0]?.id, created[1]?.id, 'ids precisam ser únicos');
      assert.notEqual(
        created[0]?.configDirectory,
        created[1]?.configDirectory,
        'duas contas nunca podem compartilhar o diretório de configuração',
      );
      for (const profile of created) {
        assert.match(profile?.configDirectory ?? '', /claude-code/);
        assert.doesNotMatch(
          profile?.configDirectory ?? '',
          /Prometheon[\\/](extension|src)/,
          'credenciais não podem morar dentro do repositório',
        );
      }
    } finally {
      for (const profile of created) {
        if (profile !== undefined) {
          await api.profiles.remove(profile.id);
        }
      }
    }
  });

  test('remover um perfil não apaga o diretório de credenciais', async () => {
    const api = await getApi();
    const profile = await api.profiles.create({ name: 'Teste Removivel', providerId: 'claude-code' });
    const directory = profile.configDirectory;

    await api.profiles.remove(profile.id);
    assert.equal(
      (await api.profiles.list()).some((item) => item.id === profile.id),
      false,
      'o perfil sai da lista',
    );

    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(directory), true, 'o diretório fica para o usuário decidir');
    const { rmSync } = await import('node:fs');
    rmSync(directory, { recursive: true, force: true });
  });

  test('perfil desconhecido falha com erro tipado, sem cair em outra conta', async () => {
    const api = await getApi();
    await assert.rejects(
      () => api.profiles.require('nao-existe'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'provider.profile-not-found');
        return true;
      },
    );
  });
});

suite('Uso de tokens', () => {
  test('soma por perfil e separa as janelas de tempo', async () => {
    const api = await getApi();
    const profileId = `teste-uso-${Date.now()}`;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    await api.usage.record(profileId, { input: 100, output: 40 }, now);
    await api.usage.record(profileId, { input: 50, output: 10 }, now);
    await api.usage.record(profileId, { input: 200, output: 80 }, now - 3 * day);
    await api.usage.record(profileId, { input: 999, output: 999 }, now - 30 * day);

    const usage = api.usage.usageFor(profileId, now);
    assert.deepEqual(usage.today, { input: 150, output: 50 });
    assert.deepEqual(usage.last7Days, { input: 350, output: 130 });
    assert.deepEqual(usage.total, { input: 1349, output: 1129 });
    assert.equal(usage.runs, 4);

    // Uso de um perfil não contamina o outro.
    assert.deepEqual(api.usage.usageFor('outro-perfil', now).total, { input: 0, output: 0 });
  });

  test('execução sem tokens não gera registro', async () => {
    const api = await getApi();
    const profileId = `teste-vazio-${Date.now()}`;
    await api.usage.record(profileId, { input: 0, output: 0 });
    assert.equal(api.usage.usageFor(profileId).runs, 0);
  });
});
