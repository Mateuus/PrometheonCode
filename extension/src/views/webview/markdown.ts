/**
 * Markdown da conversa, renderizado em nós do DOM.
 *
 * O agente escreve em Markdown porque é assim que um modelo escreve: `**` para
 * dar ênfase, crases para código, hífens para listar. Mostrar isso cru faz o
 * leitor decodificar pontuação no lugar de ler — e um trecho de código sem
 * bloco se mistura ao texto.
 *
 * Nada aqui monta HTML a partir de texto. Cada elemento é criado por
 * `createElement` e todo conteúdo entra por `textContent`: é a mesma garantia
 * de antes, que a resposta de um agente jamais vira marcação executável na
 * webview. Links só passam com `http`/`https` — um `javascript:` escrito por
 * quem responde não pode virar um clique.
 */

import { highlight } from './highlight';

/** Converte o texto do agente numa árvore pronta para inserir. */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let at = 0;
  /**
   * A linha anterior estava em branco (ou não havia linha).
   *
   * É o que separa um bloco de código indentado da continuação de um item de
   * lista: os dois começam com espaços, e só o primeiro nasce depois de uma
   * linha vazia.
   */
  let blockEnded = true;

  while (at < lines.length) {
    const line = lines[at] ?? '';

    if (line.trim() === '') {
      blockEnded = true;
      at += 1;
      continue;
    }

    // Bloco de código: tudo entre as cercas é literal, inclusive o que
    // pareceria marcação. Sem fechamento, vale até o fim — quem está lendo uma
    // resposta em streaming vê o bloco crescer, e não o texto cru.
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !/^\s*```\s*$/.test(lines[at] ?? '')) {
        body.push(lines[at] ?? '');
        at += 1;
      }
      at += 1;
      fragment.append(codeBlock(body.join('\n'), fence[1] ?? ''));
      continue;
    }

    // Bloco indentado, o Markdown clássico: quatro espaços (ou um tab) valem
    // por cercas. Modelos usam muito, e sem isto um JSON de exemplo caía no
    // meio do texto como parágrafo — que foi o que aconteceu.
    if (isIndentedCode(line) && blockEnded) {
      const body: string[] = [];
      while (at < lines.length) {
        const current = lines[at] ?? '';
        // Uma linha em branco só encerra o bloco se o que vem depois já não é
        // código: exemplos costumam ter linhas vazias no meio.
        if (current.trim() === '') {
          if (!isIndentedCode(lines[at + 1] ?? '')) {
            break;
          }
          body.push('');
          at += 1;
          continue;
        }
        if (!isIndentedCode(current)) {
          break;
        }
        body.push(current.replace(/^(?: {4}|\t)/, ''));
        at += 1;
      }
      fragment.append(codeBlock(body.join('\n'), ''));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length;
      const element = document.createElement(`h${String(Math.min(level + 2, 6))}`);
      element.className = 'md-heading';
      element.append(inline(heading[2] ?? ''));
      fragment.append(element);
      at += 1;
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      fragment.append(document.createElement('hr'));
      at += 1;
      continue;
    }

    if (isListItem(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'md-list';
      while (at < lines.length && isListItem(lines[at] ?? '')) {
        const item = document.createElement('li');
        item.append(inline((lines[at] ?? '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')));
        list.append(item);
        at += 1;
      }
      fragment.append(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const body: string[] = [];
      while (at < lines.length && /^\s*>\s?/.test(lines[at] ?? '')) {
        body.push((lines[at] ?? '').replace(/^\s*>\s?/, ''));
        at += 1;
      }
      quote.append(inline(body.join('\n')));
      fragment.append(quote);
      continue;
    }

    // Parágrafo: segue até a linha em branco ou até algo que comece outro bloco.
    const paragraph: string[] = [];
    while (at < lines.length) {
      const current = lines[at] ?? '';
      if (current.trim() === '' || startsBlock(current)) {
        break;
      }
      paragraph.push(current);
      at += 1;
    }
    const element = document.createElement('p');
    element.append(inline(paragraph.join('\n')));
    fragment.append(element);
    // Um trecho indentado logo abaixo de um parágrafo é continuação dele, não
    // um bloco de código novo.
    blockEnded = false;
  }

  return fragment;
}

/** Linha de código indentado: quatro espaços ou um tab, e não um item de lista. */
function isIndentedCode(line: string): boolean {
  // A indentação interna do exemplo conta como conteúdo, não como fim do
  // bloco: a segunda linha de um JSON já vem com seis espaços.
  return /^(?: {4}|\t)\s*\S/.test(line) && !isListItem(line);
}

function startsBlock(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    isListItem(line) ||
    /^\s*(?:[-*_]\s*){3,}$/.test(line)
  );
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

function codeBlock(code: string, language: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'md-code';
  const element = document.createElement('code');
  if (language !== '') {
    element.dataset['language'] = language;
  }
  // Sem linguagem declarada o realce genérico ainda separa comentário, texto e
  // número — que é o que mais ajuda a ler um trecho solto.
  element.append(highlight(code, language));
  pre.append(element);
  return pre;
}

/**
 * Marcação dentro de uma linha.
 *
 * O código entre crases é resolvido primeiro e sai da disputa: um `**` dentro
 * de um trecho de código é código, não ênfase.
 */
function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern =
    /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;

  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > last) {
      fragment.append(document.createTextNode(text.slice(last, at)));
    }
    last = at + match[0].length;

    const [, , code, strong, strongAlt, struck, emphasis, linkText, linkHref, bareUrl] = match;

    if (code !== undefined) {
      fragment.append(element('code', code, 'md-inline-code'));
    } else if (strong !== undefined || strongAlt !== undefined) {
      fragment.append(element('strong', strong ?? strongAlt ?? ''));
    } else if (struck !== undefined) {
      fragment.append(element('s', struck));
    } else if (emphasis !== undefined) {
      fragment.append(element('em', emphasis));
    } else if (linkText !== undefined && linkHref !== undefined) {
      fragment.append(link(linkHref, linkText));
    } else if (bareUrl !== undefined) {
      fragment.append(link(bareUrl, bareUrl));
    }
  }

  if (last < text.length) {
    fragment.append(document.createTextNode(text.slice(last)));
  }
  return fragment;
}

function element(tag: string, content: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  node.textContent = content;
  return node;
}

/**
 * Só `http` e `https` viram link; o resto fica como texto, à vista.
 *
 * A checagem é feita na URL já interpretada, e não com uma expressão sobre o
 * texto: quem decide qual é o esquema é o mesmo parser que o navegador usa ao
 * seguir o link. Uma comparação de prefixo julga uma string que o navegador
 * ainda vai normalizar — e é entre esses dois passos que moram os disfarces.
 */
function link(href: string, label: string): Node {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    // Sem base, o que não é absoluto não é endereço: fica texto.
    return document.createTextNode(label);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return document.createTextNode(label);
  }

  const anchor = document.createElement('a');
  anchor.href = parsed.href;
  anchor.textContent = label;
  anchor.rel = 'noreferrer';
  return anchor;
}
