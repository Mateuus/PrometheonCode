#!/usr/bin/env node
// Valida os `SKILL.md` de `.prometheon/skills/`.
//
// As regras vêm do estudo (`Docs/Estudos/Orquestracao-Multi-Agente/03_…`, §10.4)
// e do mesmo parser que a extensão usa em runtime — o que quebra aqui quebraria
// lá, e é melhor descobrir no `npm run verify` do que no meio de uma tarefa.
//
// O aviso mais útil é o do corte da descrição: só os 57 primeiros caracteres
// entram no índice do system prompt. Uma skill cujo gatilho fica depois disso
// simplesmente não ativa, e nada na interface denuncia o motivo — por isso o
// linter imprime o texto exato que o modelo vai ler.
//
// Uso:
//   node scripts/lint-skills.mjs [caminho]   (padrão: .prometheon/skills)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repoRoot, process.argv[2] ?? join(".prometheon", "skills"));

/** Espelha `SKILL_SUPPORT_DIRS` do `SkillRegistry`. */
const SUPPORT_DIRS = new Set(["references", "templates", "assets", "scripts"]);

const PROMPT_DESC_LIMIT = 60;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_CONTENT_CHARS = 100_000;
/** Acima disso o corpo deve ser dividido em `references/`. */
const SPLIT_THRESHOLD_CHARS = 20_000;

const errors = [];
const warnings = [];

const error = (file, message) => errors.push({ file, message });
const warn = (file, message) => warnings.push({ file, message });

/**
 * Separa frontmatter e corpo com as mesmas regras do runtime: `---` no byte 0
 * (BOM tolerado), fechamento `\n---\s*\n`, ausência não é erro.
 */
function parseSkillFile(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.startsWith("---")) {
    return { header: null, body: text, hadBom: raw !== text };
  }
  const closing = /\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (closing === null) {
    return { header: null, body: text, hadBom: raw !== text };
  }
  return {
    header: text.slice(4, closing.index),
    body: text.slice(closing.index + closing[0].length).replace(/^\r?\n/, ""),
    hadBom: raw !== text,
  };
}

/** Valor de uma chave de primeiro nível, sem parser de YAML. */
function field(header, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(header);
  const value = match?.[1]?.trim();
  return value === undefined ? null : value.replace(/^["'](.*)["']$/, "$1");
}

/** O que o modelo lê de fato no índice. O corte é literal. */
function promptDescription(description) {
  return description.length > PROMPT_DESC_LIMIT
    ? `${description.slice(0, PROMPT_DESC_LIMIT - 3)}...`
    : description;
}

function findSkills(directory, depth = 0) {
  if (depth > 3) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  if (entries.includes("SKILL.md")) {
    return [directory];
  }
  return entries
    .filter((entry) => !SUPPORT_DIRS.has(entry))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isDirectory())
    .flatMap((path) => findSkills(path, depth + 1));
}

function lintSkill(directory) {
  const manifest = join(directory, "SKILL.md");
  const shown = relative(repoRoot, manifest);
  const raw = readFileSync(manifest, "utf8");

  if (raw.length > MAX_CONTENT_CHARS) {
    error(shown, `SKILL.md tem ${raw.length} caracteres; o teto é ${MAX_CONTENT_CHARS}.`);
  }

  const { header, body, hadBom } = parseSkillFile(raw);

  if (hadBom) {
    // O runtime tolera, mas nem todo host tolera — e o BOM é invisível no
    // editor, então quem for depurar não vê o motivo.
    warn(shown, "o arquivo começa com BOM; salve como UTF-8 sem BOM.");
  }
  if (header === null) {
    error(shown, "sem frontmatter: o arquivo precisa começar com `---` e fechar com `---`.");
    return;
  }

  const folder = basename(directory);
  const name = field(header, "name");
  const description = field(header, "description");

  if (name === null) {
    error(shown, "o frontmatter não tem `name`.");
  } else {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > MAX_NAME_LENGTH) {
      error(shown, `"${name}" não é um nome válido: minúsculas, dígitos e hífen, até ${MAX_NAME_LENGTH}.`);
    }
    // A regra dos três hosts. Sem ela o índice anuncia um nome e a busca por
    // pasta acha outro — e a divergência só aparece na execução.
    if (name !== folder) {
      error(shown, `o frontmatter diz "${name}" mas a pasta é "${folder}"; os dois precisam bater.`);
    }
  }

  if (description === null) {
    error(shown, "o frontmatter não tem `description`.");
  } else {
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      error(shown, `a descrição tem ${description.length} caracteres; o teto é ${MAX_DESCRIPTION_LENGTH}.`);
    } else if (description.length > PROMPT_DESC_LIMIT) {
      warn(
        shown,
        `só isto entra no índice: "${promptDescription(description)}" — ponha o gatilho na frente.`,
      );
    }
  }

  if (field(header, "license") === null) {
    warn(shown, "sem `license:`: uma skill sem licença declarada não é redistribuível.");
  }
  if (field(header, "author") === null) {
    warn(shown, "sem `author:`.");
  }

  // Estrutura do corpo. `## When to Use` é o que faz a skill ativar na hora
  // certa; sem ele o modelo tem o procedimento e não sabe quando aplicá-lo.
  if (!/^#\s+\S/m.test(body)) {
    warn(shown, "o corpo não tem um título `# `.");
  }
  for (const section of ["## When to Use", "## Verification Checklist"]) {
    if (!body.includes(section)) {
      warn(shown, `o corpo não tem \`${section}\`.`);
    }
  }
  if (body.length > SPLIT_THRESHOLD_CHARS) {
    warn(
      shown,
      `o corpo tem ${body.length} caracteres; acima de ${SPLIT_THRESHOLD_CHARS} mova o volume para references/.`,
    );
  }

  // Subdiretórios: allowlist fechada, um nível de profundidade. Uma pasta fora
  // da lista seria varrida como skill; uma referência aninhada não é alcançável.
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (!statSync(path).isDirectory()) {
      continue;
    }
    if (!SUPPORT_DIRS.has(entry)) {
      error(shown, `a pasta "${entry}/" não é um subdiretório de skill válido.`);
      continue;
    }
    for (const child of readdirSync(path)) {
      if (statSync(join(path, child)).isDirectory()) {
        error(shown, `"${entry}/${child}/" está fundo demais: a referência é de um nível só.`);
      }
    }
  }

  // Ponteiro para um arquivo que não existe é pior do que ponteiro nenhum: o
  // modelo tenta abrir, falha, e desiste do procedimento. `*` e `<algo>` são
  // molde na documentação, não caminho — cobrá-los seria ruído.
  for (const match of body.matchAll(/`(references|scripts|templates|assets)\/([^`\s]+)`/g)) {
    const [, directoryName, file] = match;
    if (/[*<>?]/.test(file)) {
      continue;
    }
    if (!existsSync(join(directory, directoryName, file))) {
      warn(shown, `o corpo cita \`${directoryName}/${file}\`, que não existe.`);
    }
  }
}

if (!existsSync(root)) {
  console.log(`Sem skills em ${relative(repoRoot, root)}; nada a validar.`);
  process.exit(0);
}

const skills = findSkills(root);
for (const directory of skills) {
  lintSkill(directory);
}

const isCi = process.env.GITHUB_ACTIONS === "true";

for (const { file, message } of warnings) {
  console.log(isCi ? `::warning file=${file}::${message}` : `aviso  ${file}: ${message}`);
}
for (const { file, message } of errors) {
  console.log(isCi ? `::error file=${file}::${message}` : `erro   ${file}: ${message}`);
}

if (errors.length > 0) {
  console.error(
    `\n${skills.length} skill(s) verificada(s): ${errors.length} erro(s), ${warnings.length} aviso(s).`,
  );
  process.exit(1);
}

console.log(`${skills.length} skill(s) verificada(s), ${warnings.length} aviso(s).`);
