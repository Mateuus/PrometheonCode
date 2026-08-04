import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

suite('Realce de sintaxe', () => {
  let highlight: (code: string, language: string) => DocumentFragment;
  let familyOf: (language: string) => string;

  suiteSetup(async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    (globalThis as { document?: Document }).document = dom.window.document;
    ({ highlight, familyOf } = await import('../views/webview/highlight.js'));
  });

  const html = (code: string, language: string): string => {
    const host = document.createElement('div');
    host.append(highlight(code, language));
    return host.innerHTML;
  };

  test('cada apelido cai na família certa', () => {
    assert.equal(familyOf('TypeScript'), 'c-like');
    assert.equal(familyOf('c++'), 'c-like');
    assert.equal(familyOf('ps1'), 'shell');
    assert.equal(familyOf('toml'), 'data');
    assert.equal(familyOf('inventada'), 'plain');
  });

  test('C-like separa palavra-chave, texto, número e função', () => {
    const out = html('const total = soma(1, "dois"); // fim', 'ts');
    assert.match(out, /<span class="tok-keyword">const<\/span>/);
    assert.match(out, /<span class="tok-function">soma<\/span>/);
    assert.match(out, /<span class="tok-string">"dois"<\/span>/);
    assert.match(out, /<span class="tok-number">1<\/span>/);
    assert.match(out, /<span class="tok-comment">\/\/ fim<\/span>/);
  });

  test('o que está dentro de um comentário não é pintado por outra regra', () => {
    // A ordem das regras é o que garante isso: comentário e texto vêm antes.
    const out = html('// const x = 1;', 'ts');
    assert.equal((out.match(/tok-keyword/g) ?? []).length, 0, out);
    assert.match(out, /<span class="tok-comment">\/\/ const x = 1;<\/span>/);
  });

  test('cifrão dentro de texto não vira variável no shell', () => {
    const out = html("echo '$HOME'", 'bash');
    assert.equal((out.match(/tok-variable/g) ?? []).length, 0, out);
  });

  test('shell destaca comando, opção e variável', () => {
    const out = html('codex exec --json -c $CODEX_HOME # roda', 'bash');
    assert.match(out, /<span class="tok-function">codex<\/span>/);
    assert.match(out, /<span class="tok-operator">--json<\/span>/);
    assert.match(out, /<span class="tok-variable">\$CODEX_HOME<\/span>/);
    assert.match(out, /<span class="tok-comment"># roda<\/span>/);
  });

  test('TOML destaca seção e chave', () => {
    const out = html('[mcp_servers.prometheon]\nenabled = true\nport = 3333', 'toml');
    assert.match(out, /<span class="tok-type">\[mcp_servers\.prometheon\]<\/span>/);
    assert.match(out, /<span class="tok-property">enabled<\/span>/);
    assert.match(out, /<span class="tok-keyword">true<\/span>/);
    assert.match(out, /<span class="tok-number">3333<\/span>/);
  });

  test('o código sai inteiro, sem perder nem duplicar caractere', () => {
    // Um tokenizador que erra o avanço come ou repete texto, e o usuário lê
    // código errado sem desconfiar.
    for (const [code, lang] of [
      ['const a = "x"; /* nota */ f(a);', 'ts'],
      ['def f(x):\n    return x  # ok', 'python'],
      ['ls -la | grep "a b" && echo $PWD', 'sh'],
      ['{ "a": 1, "b": [true, null] }', 'json'],
      ['<div class="x">texto</div>', 'html'],
      ['linha sem linguagem 42', ''],
    ] as const) {
      const host = document.createElement('div');
      host.append(highlight(code, lang));
      assert.equal(host.textContent, code, `${lang}: ${host.textContent ?? ''}`);
    }
  });

  test('conteúdo perigoso continua virando texto', () => {
    const out = html('<script>alert(1)</script>', 'ts');
    assert.ok(!out.includes('<script>'), out);
    assert.match(out, /&lt;script&gt;/);
  });
});
