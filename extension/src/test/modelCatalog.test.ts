import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../constants';
import { merge, normalizeCatalog, MAX_MODELS_PER_PROVIDER } from '../providers/ModelCatalog';
import { PROVIDER_IDS } from '../providers/types';

function silent(): (message: string) => void {
  return () => undefined;
}

function collected(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => void messages.push(message), messages };
}

suite('Catálogo de modelos', () => {
  test('o arquivo que acompanha a extensão é válido e cobre os provedores', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extensão ${EXTENSION_ID} não encontrada`);

    const raw: unknown = JSON.parse(
      readFileSync(join(extension.extensionPath, 'media', 'models.json'), 'utf8'),
    );
    const catalog = normalizeCatalog(raw, silent());

    // Um provedor com adaptador registrado sem modelo algum deixaria o campo
    // Model daquela conta sem lista — o que é justamente o que isto evita.
    for (const providerId of PROVIDER_IDS) {
      const entry = catalog.find((candidate) => candidate.providerId === providerId);
      assert.ok(entry !== undefined, `sem modelos para ${providerId}`);
      assert.ok(entry.models.length > 0);
    }

    for (const entry of catalog) {
      for (const model of entry.models) {
        assert.notEqual(model.id.trim(), '', `id vazio em ${entry.providerId}`);
        assert.notEqual(model.label.trim(), '', `rótulo vazio em ${model.id}`);
      }
    }
  });

  test('entrada malformada é descartada sozinha, sem levar o arquivo junto', () => {
    const { warn, messages } = collected();
    const catalog = normalizeCatalog(
      {
        providers: {
          'claude-code': [
            { id: 'claude-opus-5', label: 'Opus 5', hint: '1M' },
            { label: 'sem id' },
            'nem objeto é',
            { id: '   ' },
          ],
        },
      },
      warn,
    );

    assert.deepEqual(
      catalog[0]?.models.map((model) => model.id),
      ['claude-opus-5'],
    );
    assert.equal(messages.length, 3, 'cada descarte precisa aparecer no log');
  });

  test('rótulo ausente cai no próprio id em vez de descartar o modelo', () => {
    const catalog = normalizeCatalog(
      { providers: { 'codex-cli': [{ id: 'gpt-5.6-sol' }] } },
      silent(),
    );

    assert.deepEqual(catalog[0]?.models[0], {
      id: 'gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      hint: '',
    });
  });

  test('arquivo sem `providers` é ignorado com aviso, e não vira exceção', () => {
    const { warn, messages } = collected();

    assert.deepEqual(normalizeCatalog({ modelos: [] }, warn), []);
    assert.deepEqual(normalizeCatalog('nem é objeto', warn), []);
    // `undefined` é o arquivo ausente: estado normal, sem aviso.
    assert.deepEqual(normalizeCatalog(undefined, warn), []);
    assert.equal(messages.length, 2);
  });

  test('id repetido no mesmo provedor fica com o primeiro', () => {
    const catalog = normalizeCatalog(
      {
        providers: {
          'claude-code': [
            { id: 'claude-opus-5', label: 'Primeiro' },
            { id: 'claude-opus-5', label: 'Segundo' },
          ],
        },
      },
      silent(),
    );

    assert.equal(catalog[0]?.models.length, 1);
    assert.equal(catalog[0]?.models[0]?.label, 'Primeiro');
  });

  test('a lista de um provedor tem teto', () => {
    const models = Array.from({ length: MAX_MODELS_PER_PROVIDER + 10 }, (_, index) => ({
      id: `modelo-${String(index)}`,
    }));
    const catalog = normalizeCatalog({ providers: { 'kimi-cli': models } }, silent());

    assert.equal(catalog[0]?.models.length, MAX_MODELS_PER_PROVIDER);
  });

  test('o arquivo do usuário substitui na posição e acrescenta no fim', () => {
    const merged = merge(
      [
        {
          providerId: 'claude-code',
          models: [
            { id: 'claude-opus-5', label: 'Opus 5', hint: '1M' },
            { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: '200K' },
          ],
        },
      ],
      [
        {
          providerId: 'claude-code',
          models: [
            { id: 'claude-opus-5', label: 'Opus 5 (meu rótulo)', hint: 'o de sempre' },
            { id: 'claude-modelo-novo', label: 'Modelo novo', hint: 'saiu hoje' },
          ],
        },
      ],
    );

    assert.deepEqual(
      merged[0]?.models.map((model) => [model.id, model.label]),
      [
        ['claude-opus-5', 'Opus 5 (meu rótulo)'],
        ['claude-haiku-4-5', 'Haiku 4.5'],
        ['claude-modelo-novo', 'Modelo novo'],
      ],
    );
  });

  test('o usuário pode declarar um provedor que o arquivo embutido não tem', () => {
    const merged = merge(
      [{ providerId: 'claude-code', models: [{ id: 'claude-opus-5', label: 'Opus 5', hint: '' }] }],
      [{ providerId: 'meu-cli', models: [{ id: 'meu-modelo', label: 'Meu modelo', hint: '' }] }],
    );

    assert.deepEqual(
      merged.map((entry) => entry.providerId),
      ['claude-code', 'meu-cli'],
    );
  });
});
