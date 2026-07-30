#!/usr/bin/env node
// Diagnóstico do ambiente de desenvolvimento do Prometheon.
//
//   npm run doctor            relatório legível
//   npm run doctor -- --json  saída para máquina
//
// Não instala nada, não altera arquivos e não lê credenciais.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");
const isWindows = process.platform === "win32";

const results = [];

const record = (entry) => {
  results.push(entry);
  return entry;
};

/** Localiza um executável no PATH sem executá-lo. */
function which(command) {
  const finder = isWindows ? "where" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", shell: false });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? null;
}

/** Executa `<command> <args>` e devolve a primeira linha da saída. */
function version(command, args = ["--version"]) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: isWindows, // CLIs instaladas via npm em Windows são .cmd
    });
    return output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  } catch {
    return null;
  }
}

function parseMajor(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  return match ? Number(match[1]) : null;
}

// --- Ferramentas obrigatórias ------------------------------------------------

function checkTool({ name, command, args, minMajor, required, install, note }) {
  const path = which(command);
  if (!path) {
    return record({
      name,
      status: required ? "error" : "skip",
      detail: "não encontrado no PATH",
      install,
      note,
    });
  }

  const raw = version(command, args);
  const major = parseMajor(raw);
  if (minMajor && major !== null && major < minMajor) {
    return record({
      name,
      status: "error",
      detail: `${raw} — mínimo exigido: ${minMajor}`,
      install,
      note,
    });
  }
  return record({ name, status: "ok", detail: raw ?? "instalado", note });
}

// Ambiente base
checkTool({
  name: "Node.js",
  command: "node",
  minMajor: 20,
  required: true,
  install: "https://nodejs.org (LTS 20 ou superior)",
});
checkTool({ name: "npm", command: "npm", minMajor: 10, required: true });
checkTool({
  name: "Git",
  command: "git",
  minMajor: 2,
  required: true,
  install: "https://git-scm.com",
});
checkTool({
  name: "VS Code CLI",
  command: "code",
  required: false,
  install: "VS Code → Command Palette → Shell Command: Install 'code' command in PATH",
  note: "Opcional: usado para instalar o .vsix pela linha de comando.",
});

// CLIs de agentes de IA — todas opcionais.
checkTool({
  name: "Claude Code (claude)",
  command: "claude",
  required: false,
  install: "npm install -g @anthropic-ai/claude-code",
  note: "Autentique fora do Prometheon, com o fluxo oficial da CLI.",
});
checkTool({
  name: "Codex CLI (codex)",
  command: "codex",
  required: false,
  install: "npm install -g @openai/codex",
});
checkTool({
  name: "Gemini CLI (gemini)",
  command: "gemini",
  required: false,
  install: "npm install -g @google/gemini-cli",
});
checkTool({
  name: "Kimi (kimi)",
  command: "kimi",
  required: false,
  install: "consulte a documentação oficial da Moonshot AI",
  note: "Pacote de distribuição ainda não fixado neste repositório.",
});
checkTool({
  name: "Graphify (graphify)",
  command: "graphify",
  required: false,
  install: "integração planejada — versão ainda não fixada neste repositório",
  note: "Sem o Graphify, a base de conhecimento funciona como Markdown puro.",
});

// --- Estado do repositório ---------------------------------------------------

const extensionRoot = join(repoRoot, "extension");

record(
  existsSync(join(extensionRoot, "node_modules"))
    ? { name: "Dependências da extensão", status: "ok", detail: "extension/node_modules presente" }
    : {
        name: "Dependências da extensão",
        status: "error",
        detail: "extension/node_modules ausente",
        install: "npm run install:all",
      },
);

record(
  existsSync(join(extensionRoot, "dist", "extension.js"))
    ? { name: "Build da extensão", status: "ok", detail: "extension/dist/extension.js presente" }
    : {
        name: "Build da extensão",
        status: "warn",
        detail: "extension/dist/extension.js ausente",
        install: "npm run compile",
      },
);

try {
  const manifest = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
  record({
    name: "Manifest da extensão",
    status: "ok",
    detail: `${manifest.displayName} ${manifest.version} (VS Code ${manifest.engines?.vscode})`,
  });
} catch (cause) {
  record({ name: "Manifest da extensão", status: "error", detail: cause.message });
}

const insideGitRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: repoRoot,
  encoding: "utf8",
}).stdout?.trim() === "true";

record(
  insideGitRepo
    ? { name: "Repositório Git", status: "ok", detail: "detectado" }
    : {
        name: "Repositório Git",
        status: "warn",
        detail: "esta pasta não é um repositório Git",
        install: "git init",
      },
);

record({
  name: "Plataforma",
  status: "ok",
  detail: `${process.platform} ${process.arch} — Node ${process.version}`,
});

// --- Relatório ---------------------------------------------------------------

if (asJson) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  const icons = { ok: "✔", warn: "!", error: "✖", skip: "–" };
  const width = Math.max(...results.map((entry) => entry.name.length));

  console.log("\nPrometheon — diagnóstico do ambiente\n");
  for (const entry of results) {
    console.log(`  ${icons[entry.status]} ${entry.name.padEnd(width)}  ${entry.detail}`);
    if (entry.status !== "ok") {
      if (entry.install) console.log(`      instalar: ${entry.install}`);
      if (entry.note) console.log(`      nota: ${entry.note}`);
    }
  }

  const errors = results.filter((entry) => entry.status === "error");
  const warns = results.filter((entry) => entry.status === "warn");
  const skips = results.filter((entry) => entry.status === "skip");

  console.log(
    `\n  ${results.length - errors.length - warns.length - skips.length} ok, ` +
      `${warns.length} aviso(s), ${skips.length} opcional(is) ausente(s), ${errors.length} erro(s).`,
  );

  if (errors.length === 0) {
    console.log("\n  Ambiente pronto. Abra a raiz do repositório no VS Code e pressione F5.\n");
  } else {
    console.log("\n  Resolva os itens marcados com ✖ antes de continuar.\n");
  }
}

process.exit(results.some((entry) => entry.status === "error") ? 1 : 0);
