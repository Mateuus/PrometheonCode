import * as assert from 'node:assert/strict';
import { DEFAULT_HUB_URL } from '../constants';
import { parseHubUrl, resolveHubUrl } from '../hub/HubClient';

suite('URL do Hub', () => {
  test('configuração vazia resolve para o Hub oficial', () => {
    for (const configured of ['', '   ', '\t']) {
      assert.equal(resolveHubUrl(configured), DEFAULT_HUB_URL);
    }
  });

  test('configuração preenchida vence o padrão', () => {
    assert.equal(resolveHubUrl(' https://hub.interno.example '), 'https://hub.interno.example');
  });

  test('o Hub oficial passa na própria validação', () => {
    // Se o padrão embutido não validar, todo clique em "entrar" nasce morto.
    const parsed = parseHubUrl(resolveHubUrl(''));
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.hostname, 'api.prometheoncode.xyz');
  });

  test('HTTP remoto é recusado; localhost pode', () => {
    assert.throws(
      () => parseHubUrl('http://hub.example.com'),
      (error: unknown) => (error as { code?: string }).code === 'hub.invalid-url',
    );
    assert.equal(parseHubUrl('http://127.0.0.1:3551').hostname, '127.0.0.1');
  });

  test('credenciais embutidas na URL são recusadas', () => {
    assert.throws(
      () => parseHubUrl('https://user:senha@hub.example.com'),
      (error: unknown) => (error as { code?: string }).code === 'hub.invalid-url',
    );
  });
});
