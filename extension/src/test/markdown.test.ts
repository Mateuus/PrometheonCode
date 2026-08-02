import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

suite('Markdown da conversa', () => {
  let renderMarkdown: (source: string) => DocumentFragment;

  suiteSetup(async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    (globalThis as { document?: Document }).document = dom.window.document;
    ({ renderMarkdown } = await import('../views/webview/markdown.js'));
  });

  const html = (source: string): string => {
    const host = document.createElement('div');
    host.append(renderMarkdown(source));
    return host.innerHTML;
  };

  test('negrito, itálico e código inline viram elementos', () => {
    assert.match(html('um **texto** forte'), /<strong>texto<\/strong>/);
    assert.match(html('um *texto* leve'), /<em>texto<\/em>/);
    assert.match(html('use `npm run verify`'), /<code class="md-inline-code">npm run verify<\/code>/);
  });

  test('a marcação dentro de código é código, não ênfase', () => {
    // Um `**` citado numa explicação sobre Markdown não pode virar negrito.
    assert.match(html('escreva `**assim**`'), /<code[^>]*>\*\*assim\*\*<\/code>/);
  });

  test('bloco de código preserva o texto e a linguagem', () => {
    const out = html('```ts\nconst a = 1;\n```');
    assert.match(out, /<pre class="md-code"><code data-language="ts">const a = 1;<\/code><\/pre>/);
  });

  test('bloco sem fechamento vale até o fim, para o streaming não mostrar cru', () => {
    assert.match(html('```\nlinha um\nlinha dois'), /<pre class="md-code">/);
  });

  test('listas e títulos viram estrutura', () => {
    assert.match(html('- um\n- dois'), /<ul class="md-list"><li>um<\/li><li>dois<\/li><\/ul>/);
    assert.match(html('1. um\n2. dois'), /<ol class="md-list">/);
    assert.match(html('## Título'), /<h4 class="md-heading">Título<\/h4>/);
  });

  test('o conteúdo nunca vira marcação executável', () => {
    const out = html('<img src=x onerror=alert(1)> e <b>negrito</b>');
    assert.ok(!out.includes('<img'), out);
    assert.ok(!out.includes('<b>'), out);
    assert.match(out, /&lt;img/);
  });

  test('link só passa com http ou https', () => {
    assert.match(html('[abrir](https://exemplo.com)'), /<a href="https:\/\/exemplo\.com/);
    const perigoso = html('[clique](javascript:alert(1))');
    assert.ok(!perigoso.includes('<a'), perigoso);
    assert.match(perigoso, /clique/);
  });

  test('esquema disfarçado não vira link', () => {
    // A checagem é na URL interpretada, e não no texto: maiúsculas, espaço à
    // frente e caractere de controle no meio são normalizados pelo navegador
    // antes de ele seguir o endereço, e é aí que uma comparação de prefixo
    // erra.
    for (const alvo of [
      '[a](JavaScript:alert(1))',
      '[a]( javascript:alert(1))',
      '[a](java	script:alert(1))',
      '[a](data:text/html;base64,PHNjcmlwdD4=)',
      '[a](vbscript:msgbox)',
      '[a](/caminho/relativo)',
    ]) {
      assert.ok(!html(alvo).includes('<a'), alvo);
    }
  });

  test('emoji atravessa intacto', () => {
    assert.match(html('pronto 🔎 achei'), /pronto 🔎 achei/);
  });
});

suite('Markdown — bloco indentado', () => {
  let renderMarkdown: (source: string) => DocumentFragment;

  suiteSetup(async () => {
    ({ renderMarkdown } = await import('../views/webview/markdown.js'));
  });

  const html = (source: string): string => {
    const host = document.createElement('div');
    host.append(renderMarkdown(source));
    return host.innerHTML;
  };

  test('quatro espaços viram bloco de código, como nas cercas', () => {
    // É o formato que os modelos usam sem pedir licença; sem isto o JSON de
    // exemplo caía no meio do texto como parágrafo.
    const out = html('Config:\n\n    {\n      "type": "http"\n    }\n\ndepois');
    assert.match(out, /<pre class="md-code"><code>\{\n {2}"type": "http"\n\}<\/code><\/pre>/);
    assert.match(out, /<p>depois<\/p>/);
  });

  test('linha em branco no meio do exemplo não corta o bloco', () => {
    const out = html('x\n\n    um\n\n    dois\n');
    assert.equal((out.match(/<pre/g) ?? []).length, 1, out);
  });

  test('item de lista indentado continua lista, e não vira código', () => {
    const out = html('- um\n    - dois');
    assert.ok(!out.includes('<pre'), out);
  });

  test('trecho indentado colado num parágrafo continua o parágrafo', () => {
    const out = html('uma frase\n    ainda a frase');
    assert.ok(!out.includes('<pre'), out);
  });
});
