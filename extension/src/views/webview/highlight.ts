/**
 * Realce de sintaxe dos blocos de código da conversa.
 *
 * Um bloco monocromático obriga a ler caractere por caractere para saber o que
 * é comentário, o que é string e onde começa o comando. A cor faz esse trabalho
 * antes da leitura.
 *
 * É um tokenizador próprio, e não uma biblioteca: a webview roda sob uma CSP
 * que proíbe carregar qualquer coisa de fora, e empacotar um realçador completo
 * custaria mais peso do que o problema justifica. O objetivo aqui não é
 * gramática exata — é separar comentário, texto, número, palavra-chave e nome
 * de função com confiança suficiente para ajudar a ler.
 *
 * Como todo o resto da webview, nada vira marcação: cada trecho é um `span`
 * criado por `createElement`, com o texto entrando por `textContent`.
 */

export type TokenKind =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'property'
  | 'operator'
  | 'variable';

interface Rule {
  readonly kind: TokenKind;
  readonly pattern: RegExp;
}

/** Famílias de linguagem. O apelido que o modelo escreve na cerca cai numa delas. */
type Family = 'c-like' | 'shell' | 'python' | 'data' | 'markup' | 'plain';

const FAMILIES: Readonly<Record<string, Family>> = {
  ts: 'c-like',
  tsx: 'c-like',
  typescript: 'c-like',
  js: 'c-like',
  jsx: 'c-like',
  javascript: 'c-like',
  json: 'data',
  jsonc: 'data',
  java: 'c-like',
  c: 'c-like',
  h: 'c-like',
  cpp: 'c-like',
  'c++': 'c-like',
  cxx: 'c-like',
  hpp: 'c-like',
  cs: 'c-like',
  csharp: 'c-like',
  go: 'c-like',
  rust: 'c-like',
  rs: 'c-like',
  php: 'c-like',
  swift: 'c-like',
  kotlin: 'c-like',
  scala: 'c-like',
  dart: 'c-like',
  bash: 'shell',
  sh: 'shell',
  shell: 'shell',
  zsh: 'shell',
  console: 'shell',
  powershell: 'shell',
  ps1: 'shell',
  pwsh: 'shell',
  bat: 'shell',
  cmd: 'shell',
  python: 'python',
  py: 'python',
  ruby: 'python',
  rb: 'python',
  toml: 'data',
  ini: 'data',
  yaml: 'data',
  yml: 'data',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'markup',
  scss: 'markup',
  sql: 'c-like',
};

const C_KEYWORDS =
  'abstract|as|async|await|break|case|catch|class|const|constexpr|continue|declare|default|delete|do|else|enum|export|extends|extern|final|finally|fn|for|from|func|function|go|goto|if|impl|implements|import|in|instanceof|interface|internal|is|let|match|mod|mut|namespace|new|null|nullptr|operator|override|package|private|protected|public|pub|readonly|record|return|satisfies|sealed|select|static|struct|super|switch|template|this|throw|throws|trait|try|type|typedef|typeof|union|unsafe|use|using|var|virtual|void|where|while|with|yield|true|false|nil|none|undefined|self';

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None|self|end|do|module|require|puts|attr_accessor';

const SHELL_KEYWORDS =
  'if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|exit|export|local|source|param|begin|process|foreach|switch|try|catch|finally|throw';

/**
 * Ordem importa: o que vem primeiro vence. Comentário e string na frente de
 * tudo — um `#` dentro de uma string não abre comentário, e uma palavra-chave
 * dentro de um comentário não é palavra-chave.
 */
const RULES: Readonly<Record<Family, readonly Rule[]>> = {
  'c-like': [
    { kind: 'comment', pattern: /\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?:^|\s)--[^\n]*/ },
    { kind: 'string', pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/ },
    { kind: 'number', pattern: /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/ },
    { kind: 'keyword', pattern: new RegExp(`\\b(?:${C_KEYWORDS})\\b`) },
    { kind: 'function', pattern: /\b[A-Za-z_$][\w$]*(?=\s*\()/ },
    { kind: 'type', pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    { kind: 'property', pattern: /(?<=\.)[A-Za-z_$][\w$]*/ },
  ],
  shell: [
    { kind: 'comment', pattern: /#[^\n]*/ },
    { kind: 'string', pattern: /"(?:\\.|[^"\\])*"|'(?:[^'])*'/ },
    // Variável de ambiente nas três convenções que aparecem por aqui.
    { kind: 'variable', pattern: /\$(?:\{[^}\n]*\}|[A-Za-z_][\w]*)|%[A-Za-z_][\w]*%/ },
    // A opção é o que se procura ao ler um comando: ela ganha destaque próprio.
    { kind: 'operator', pattern: /(?<=\s)--?[A-Za-z][\w-]*/ },
    { kind: 'keyword', pattern: new RegExp(`\\b(?:${SHELL_KEYWORDS})\\b`) },
    { kind: 'number', pattern: /\b\d+\b/ },
    // O primeiro nome da linha é o programa que roda.
    { kind: 'function', pattern: /(?<=^|[\n;|&]\s*)[A-Za-z_][\w.-]*/ },
  ],
  python: [
    { kind: 'comment', pattern: /#[^\n]*/ },
    {
      kind: 'string',
      pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/,
    },
    { kind: 'number', pattern: /\b\d[\d_]*(?:\.\d+)?\b/ },
    { kind: 'keyword', pattern: new RegExp(`\\b(?:${PY_KEYWORDS})\\b`) },
    { kind: 'function', pattern: /\b[A-Za-z_][\w]*(?=\s*\()/ },
    { kind: 'type', pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
  ],
  data: [
    { kind: 'comment', pattern: /#[^\n]*|\/\/[^\n]*/ },
    { kind: 'string', pattern: /"(?:\\.|[^"\\\n])*"|'(?:[^'\n])*'/ },
    // Seção de TOML/INI: é o que dá a estrutura do arquivo.
    { kind: 'type', pattern: /^\s*\[[^\]\n]+\]/m },
    { kind: 'property', pattern: /^[ \t]*"?[\w.-]+"?(?=\s*[:=])/m },
    { kind: 'keyword', pattern: /\b(?:true|false|null|yes|no|on|off)\b/ },
    { kind: 'number', pattern: /\b\d[\d_]*(?:\.\d+)?\b/ },
  ],
  markup: [
    { kind: 'comment', pattern: /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\// },
    { kind: 'string', pattern: /"(?:[^"\n])*"|'(?:[^'\n])*'/ },
    { kind: 'type', pattern: /<\/?[A-Za-z][\w:-]*|\/?>/ },
    { kind: 'property', pattern: /[A-Za-z-]+(?=\s*=)|[.#][A-Za-z][\w-]*/ },
    { kind: 'number', pattern: /\b\d+(?:\.\d+)?(?:px|rem|em|%|s|ms)?\b/ },
  ],
  plain: [
    { kind: 'comment', pattern: /#[^\n]*|\/\/[^\n]*/ },
    { kind: 'string', pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
    { kind: 'number', pattern: /\b\d[\d_]*(?:\.\d+)?\b/ },
  ],
};

/** Família da linguagem escrita na cerca; desconhecida vira o conjunto genérico. */
export function familyOf(language: string): Family {
  return FAMILIES[language.trim().toLowerCase()] ?? 'plain';
}

/**
 * Quebra o código em trechos coloridos.
 *
 * Um regex só, com todas as regras alternadas, percorre o texto uma vez: assim
 * cada caractere pertence a um único token, e não há como uma regra pintar por
 * cima do que outra já classificou.
 */
export function highlight(code: string, language: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const rules = RULES[familyOf(language)];
  const combined = new RegExp(rules.map((rule) => `(${rule.pattern.source})`).join('|'), 'gm');

  let last = 0;
  for (const match of code.matchAll(combined)) {
    const at = match.index;
    if (at > last) {
      fragment.append(document.createTextNode(code.slice(last, at)));
    }
    last = at + match[0].length;

    // O grupo que casou diz a regra; grupos internos de uma regra não contam,
    // por isso a busca é pelo primeiro definido a partir do índice conhecido.
    const kind = rules.find((_, index) => match[index + 1] !== undefined)?.kind;
    if (kind === undefined) {
      fragment.append(document.createTextNode(match[0]));
      continue;
    }
    const span = document.createElement('span');
    span.className = `tok-${kind}`;
    span.textContent = match[0];
    fragment.append(span);
  }

  if (last < code.length) {
    fragment.append(document.createTextNode(code.slice(last)));
  }
  return fragment;
}
