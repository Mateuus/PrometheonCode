#!/usr/bin/env node
// Validações do manifest da extensão que o ESLint e o tsc não cobrem.
// Roda no CI (job "Lint & Types") e localmente via `npm run check-manifest`.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(repoRoot, "extension");
const manifestPath = join(extensionRoot, "package.json");

const errors = [];
const warnings = [];

const error = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

/** @type {any} */
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (cause) {
  console.error(`Não foi possível ler ${manifestPath}: ${cause.message}`);
  process.exit(2);
}

// --- Campos obrigatórios -----------------------------------------------------

for (const field of [
  "name",
  "displayName",
  "description",
  "version",
  "publisher",
  "license",
  "engines",
  "main",
  "categories",
]) {
  if (manifest[field] === undefined) {
    error(`Campo obrigatório ausente no manifest: "${field}".`);
  }
}

if (manifest.version && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(manifest.version)) {
  error(`Versão "${manifest.version}" não é semver válido (x.y.z).`);
}

if (manifest.publisher === "prometheon") {
  warn(
    'O campo "publisher" ainda é o provisório ("prometheon"). ' +
      "Troque pelo ID real antes de publicar no Marketplace.",
  );
}

if (manifest.description && manifest.description.length > 200) {
  warn("A descrição tem mais de 200 caracteres — o Marketplace trunca o texto.");
}

// --- Engines -----------------------------------------------------------------

const engineVsCode = manifest.engines?.vscode;
const typesVsCode = manifest.devDependencies?.["@types/vscode"];

if (!engineVsCode) {
  error('engines.vscode não está definido.');
} else if (typesVsCode) {
  const normalize = (range) => range.replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".");
  if (normalize(engineVsCode) !== normalize(typesVsCode)) {
    error(
      `engines.vscode (${engineVsCode}) e @types/vscode (${typesVsCode}) precisam apontar ` +
        "para a mesma versão base — subir só um dos dois quebra a compatibilidade declarada.",
    );
  }
}

// --- Arquivos referenciados --------------------------------------------------

const referencedFiles = [];
if (manifest.icon) referencedFiles.push(manifest.icon);
for (const container of Object.values(manifest.contributes?.viewsContainers ?? {})) {
  for (const entry of container) if (entry.icon) referencedFiles.push(entry.icon);
}
for (const views of Object.values(manifest.contributes?.views ?? {})) {
  for (const view of views) if (typeof view.icon === "string") referencedFiles.push(view.icon);
}

for (const file of new Set(referencedFiles)) {
  if (!existsSync(join(extensionRoot, file))) {
    error(`Arquivo referenciado no manifest não existe: extension/${file}`);
  }
}

if (!manifest.icon) {
  warn(
    'O manifest não define "icon". O Marketplace exige um PNG (recomendado 256×256) ' +
      "para publicar a extensão.",
  );
}

// --- Comandos ----------------------------------------------------------------

const commands = manifest.contributes?.commands ?? [];
const commandIds = new Set();

for (const command of commands) {
  if (!command.command) {
    error("Há um comando sem a propriedade obrigatória \"command\".");
    continue;
  }
  if (commandIds.has(command.command)) {
    error(`Comando duplicado no manifest: ${command.command}`);
  }
  commandIds.add(command.command);

  if (!command.command.startsWith("prometheon.")) {
    error(`O comando "${command.command}" deve usar o prefixo "prometheon.".`);
  }
  if (!command.title) {
    error(`O comando "${command.command}" não tem "title".`);
  }
  if (!command.category) {
    warn(`O comando "${command.command}" não tem "category" — some do agrupamento na paleta.`);
  }
}

// Todo comando citado em menus deve existir em contributes.commands.
for (const [menu, entries] of Object.entries(manifest.contributes?.menus ?? {})) {
  for (const entry of entries) {
    if (entry.command && !commandIds.has(entry.command)) {
      error(`O menu "${menu}" referencia o comando inexistente "${entry.command}".`);
    }
  }
}

// Comandos citados em viewsWelcome também precisam existir.
for (const welcome of manifest.contributes?.viewsWelcome ?? []) {
  for (const match of String(welcome.contents ?? "").matchAll(/command:([\w.]+)/g)) {
    if (!commandIds.has(match[1])) {
      error(`viewsWelcome referencia o comando inexistente "${match[1]}".`);
    }
  }
}

// --- Configurações -----------------------------------------------------------

const properties = manifest.contributes?.configuration?.properties ?? {};
for (const [key, schema] of Object.entries(properties)) {
  if (!key.startsWith("prometheon.")) {
    error(`A configuração "${key}" deve usar o prefixo "prometheon.".`);
  }
  if (!schema.description && !schema.markdownDescription) {
    error(`A configuração "${key}" não tem descrição.`);
  }
  if (schema.default === undefined) {
    warn(`A configuração "${key}" não define "default".`);
  }
}

// --- Scripts esperados -------------------------------------------------------

for (const script of ["compile", "watch", "check-types", "lint", "test", "package", "vsix"]) {
  if (!manifest.scripts?.[script]) {
    error(`Script npm obrigatório ausente no manifest da extensão: "${script}".`);
  }
}

// --- Higiene de dependências -------------------------------------------------

const runtimeDeps = Object.keys(manifest.dependencies ?? {});
if (runtimeDeps.length > 0) {
  warn(
    `A extensão declara dependências de runtime (${runtimeDeps.join(", ")}). ` +
      'O empacotamento usa "--no-dependencies": confirme que o esbuild as inclui no bundle.',
  );
}

// --- Relatório ---------------------------------------------------------------

const isCi = process.env.GITHUB_ACTIONS === "true";

for (const message of warnings) {
  console.log(isCi ? `::warning file=extension/package.json::${message}` : `aviso: ${message}`);
}
for (const message of errors) {
  console.log(isCi ? `::error file=extension/package.json::${message}` : `erro: ${message}`);
}

if (errors.length > 0) {
  console.error(`\nManifest inválido: ${errors.length} erro(s), ${warnings.length} aviso(s).`);
  process.exit(1);
}

console.log(`Manifest da extensão validado (${warnings.length} aviso(s)).`);
