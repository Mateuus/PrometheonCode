import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../constants';
import { WEBVIEW_STRINGS } from '../i18n/catalog';

/** Idiomas que o produto promete hoje, além do inglês (que é a fonte). */
const LOCALES = ['pt-br', 'es'] as const;

function extensionRoot(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extensão ${EXTENSION_ID} não encontrada`);
  return extension.extensionPath;
}

function readJson(...segments: string[]): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(extensionRoot(), ...segments), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null, `JSON inválido: ${segments.join('/')}`);
  return parsed as Record<string, string>;
}

suite('Localização', () => {
  test('todo texto da webview tem tradução nos idiomas suportados', () => {
    const english = Object.values(WEBVIEW_STRINGS);
    for (const locale of LOCALES) {
      const bundle = readJson('l10n', `bundle.l10n.${locale}.json`);
      const missing = english.filter((text) => bundle[text] === undefined);
      assert.deepEqual(
        missing,
        [],
        `faltam traduções em ${locale} — texto novo na interface exige entrada no bundle`,
      );
    }
  });

  test('nenhuma tradução fica vazia ou igual à chave por engano', () => {
    for (const locale of LOCALES) {
      const bundle = readJson('l10n', `bundle.l10n.${locale}.json`);
      for (const [english, translated] of Object.entries(bundle)) {
        assert.ok(translated.trim() !== '', `tradução vazia em ${locale}: "${english}"`);
      }
    }
  });

  test('os bundles preservam os marcadores de interpolação', () => {
    const placeholders = (text: string): string[] => text.match(/\{[^}]*\}/g)?.sort() ?? [];
    for (const locale of LOCALES) {
      const bundle = readJson('l10n', `bundle.l10n.${locale}.json`);
      for (const [english, translated] of Object.entries(bundle)) {
        assert.deepEqual(
          placeholders(translated),
          placeholders(english),
          `marcadores diferentes em ${locale}: "${english}"`,
        );
      }
    }
  });

  test('o manifest usa chaves de tradução e todas existem nos três arquivos', () => {
    const manifest = readJson('package.json') as unknown as {
      displayName: string;
      description: string;
      l10n: string;
      contributes: {
        commands: { title: string }[];
        configuration: { properties: Record<string, Record<string, unknown>> };
      };
    };

    assert.equal(manifest.l10n, './l10n', 'o manifest precisa apontar a pasta de bundles');

    const used = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        const match = /^%(.+)%$/.exec(value);
        if (match?.[1] !== undefined) {
          used.add(match[1]);
        }
      } else if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(collect);
      }
    };
    collect(manifest);

    assert.ok(used.size >= 12, 'esperava os títulos de comando localizados');
    for (const file of ['package.nls.json', 'package.nls.pt-br.json', 'package.nls.es.json']) {
      const bundle = readJson(file);
      const missing = [...used].filter((key) => bundle[key] === undefined);
      assert.deepEqual(missing, [], `faltam chaves em ${file}`);
    }
  });

  test('os três arquivos do manifest declaram exatamente as mesmas chaves', () => {
    const base = Object.keys(readJson('package.nls.json')).sort();
    for (const locale of LOCALES) {
      assert.deepEqual(
        Object.keys(readJson(`package.nls.${locale}.json`)).sort(),
        base,
        `package.nls.${locale}.json divergiu do inglês`,
      );
    }
  });
});
