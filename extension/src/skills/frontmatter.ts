import { parse } from 'yaml';

/**
 * Leitura do frontmatter de um `SKILL.md`.
 *
 * As regras aqui não são invenção nossa: elas reproduzem o comportamento
 * verificado nos dois projetos de referência (`Docs/Estudos/Orquestracao-Multi-
 * Agente/03_SKILLS_E_BANCO_DE_CONHECIMENTO.md`, §2.2), porque um `SKILL.md`
 * escrito para o Claude Code ou para o hermes precisa ser lido igual aqui.
 */

/** Limite do corte no índice do prompt: 57 caracteres úteis mais reticências. */
export const SKILL_PROMPT_DESC_LIMIT = 60;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_CONTENT_CHARS = 100_000;

export interface ParsedSkillFile {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/**
 * Separa frontmatter e corpo.
 *
 * Um arquivo sem frontmatter válido devolve metadados vazios e o corpo inteiro
 * — não é erro. YAML malformado também não derruba a skill: cai num parser
 * ingênuo `chave: valor`, e o que não for entendido fica de fora.
 */
export function parseSkillFile(raw: string): ParsedSkillFile {
  // Editores gráficos do Windows gravam um BOM ao salvar como UTF-8. Deixado no
  // lugar, ele quebra o teste do `---` e o frontmatter inteiro seria descartado
  // em silêncio — o arquivo pareceria certo e a skill não teria metadado nenhum.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  if (!text.startsWith('---')) {
    return { frontmatter: {}, body: text };
  }
  // O fechamento tolera espaço à direita, como o parser de referência.
  const closing = /\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (closing === null || closing.index === undefined) {
    return { frontmatter: {}, body: text };
  }

  const header = text.slice(3, closing.index);
  // A linha em branco depois do fechamento é convenção do formato, não conteúdo:
  // mantê-la faria o corpo começar com um `\n` que atrapalha título e contagem.
  const body = text.slice(closing.index + closing[0].length).replace(/^\r?\n/, '');
  return { frontmatter: parseHeader(header), body };
}

function parseHeader(header: string): Record<string, unknown> {
  try {
    const parsed: unknown = parse(header);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Cai no modo tolerante logo abaixo.
  }
  return parseNaive(header);
}

/**
 * Último recurso: uma linha, um `chave: valor`. Serve para a skill continuar
 * descobrível quando o YAML tem um erro de indentação — com metadados parciais,
 * que é melhor do que nenhum.
 */
function parseNaive(header: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0 || line.startsWith(' ') || line.startsWith('#')) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== '' && value !== '') {
      result[key] = stripQuotes(value);
    }
  }
  return result;
}

function stripQuotes(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

/**
 * O que o modelo realmente lê no índice do system prompt. Existe para o linter
 * e a interface mostrarem o corte exato ao autor — o truncamento é literal, e
 * uma descrição cujo gatilho fica depois do limite é uma skill que não ativa.
 */
export function promptDescription(description: string): string {
  return description.length > SKILL_PROMPT_DESC_LIMIT
    ? `${description.slice(0, SKILL_PROMPT_DESC_LIMIT - 3)}...`
    : description;
}

/**
 * Estimativa de tokens de um texto. Não precisa ser exata: serve para orçar o
 * contexto antes de carregar, e errar para mais é o lado seguro.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Primeiro `# Título` do corpo. Sem ele, quem nomeia a skill é o `name`. */
export function extractTitle(body: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading?.[1]?.trim() ?? fallback;
}

/** `^[a-z0-9][a-z0-9-]*$`, até 64 — a regra que os três hosts compartilham. */
export function isValidSkillName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH && /^[a-z0-9][a-z0-9-]*$/.test(name);
}
