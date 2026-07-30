#!/usr/bin/env node
// Varredura de credenciais no diff. Roda no CI (pr-validation.yml) e localmente
// via `npm run scan:secrets`.
//
// Uso:
//   node scripts/scan-secrets.mjs                       # diff contra a base local
//   node scripts/scan-secrets.mjs --base SHA --head SHA  # intervalo explícito
//   node scripts/scan-secrets.mjs --staged              # apenas o que está em stage
//
// Para suprimir um falso positivo, adicione `secret-scan:ignore` como comentário
// na mesma linha. Use com parcimônia e explique o motivo na descrição do PR.

import { execFileSync } from "node:child_process";
import process from "node:process";

const IGNORE_MARKER = "secret-scan:ignore";

/** Padrões de credencial. `entropy` exige alta variedade de caracteres. */
const RULES = [
  {
    id: "anthropic-api-key",
    label: "Chave de API da Anthropic",
    pattern: /sk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: "openai-api-key",
    label: "Chave de API da OpenAI",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: "google-api-key",
    label: "Chave de API do Google",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "github-token",
    label: "Token do GitHub",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  {
    id: "aws-access-key",
    label: "Access key da AWS",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  },
  {
    id: "slack-token",
    label: "Token do Slack",
    pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/,
  },
  {
    id: "azure-devops-pat",
    label: "PAT do Azure DevOps / Marketplace",
    pattern: /\b(?:VSCE_PAT|AZURE_DEVOPS_PAT)\s*[:=]\s*['"]?[A-Za-z0-9]{40,}/i,
  },
  {
    id: "private-key",
    label: "Chave privada",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: "jwt",
    label: "JWT com payload",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    id: "connection-string",
    label: "String de conexão com senha embutida",
    pattern: /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]{4,}@/i,
  },
  {
    id: "generic-secret-assignment",
    label: "Atribuição de segredo em texto puro",
    // Senha inventada em teste é o padrão do ofício, não vazamento. As regras de
    // chave de provedor (sk-ant, ghp_, AKIA…) continuam valendo nos testes: se
    // alguém colar uma credencial de verdade lá, ela é apontada.
    skipInTests: true,
    pattern:
      /\b(?:api[_-]?key|secret|passwd|password|token|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/i,
    entropy: 3.0,
  },
  {
    id: "authorization-header",
    label: "Cabeçalho Authorization com credencial",
    pattern: /\bAuthorization\s*[:=]\s*['"]?(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]{20,}/i,
  },
];

/** Placeholders comuns em exemplo e documentação — não são segredos. */
const PLACEHOLDERS = [
  /^x+$/i,
  /^\.+$/,
  /^<.*>$/,
  /^\$\{?[A-Z0-9_]+\}?$/,
  /^(?:your|my|the)[-_]?/i,
  /example|placeholder|dummy|sample|redacted|changeme|todo|fake|test[-_]?only|xxxx|000000|aaaa/i,
  // Chave pontuada de tradução ou de configuração: `auth.error.shortPassword`.
  // Não é senha, e aparece com frequência em campo chamado `password`.
  /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,}$/,
];

/** Arquivos de teste e fixtures, onde valor inventado é esperado. */
const TEST_PATH = /(^|\/)(?:src\/)?(?:test|tests|__tests__|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

const EXEMPT_PATHS = [
  /(^|\/)\.env\.example$/,
  /(^|\/)scripts\/scan-secrets\.mjs$/,
  /(^|\/)SECURITY\.md$/,
];

function git(args, { quiet = false } = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  });
}

function parseArgs(argv) {
  const options = { base: null, head: null, staged: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") options.base = argv[++i];
    else if (arg === "--head") options.head = argv[++i];
    else if (arg === "--staged") options.staged = true;
  }
  return options;
}

function hasCommits() {
  try {
    git(["rev-parse", "--verify", "HEAD"], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function resolveDiffArgs({ base, head, staged }) {
  if (staged) return ["diff", "--cached", "--unified=0", "--no-color"];
  if (base && head) return ["diff", "--unified=0", "--no-color", `${base}...${head}`];

  // Repositório recém-criado: só existe o índice para comparar.
  if (!hasCommits()) {
    return ["diff", "--cached", "--unified=0", "--no-color", "--no-renames"];
  }

  // Uso local: compara com a base mais provável.
  for (const ref of ["origin/main", "main"]) {
    try {
      const mergeBase = git(["merge-base", "HEAD", ref], { quiet: true }).trim();
      if (mergeBase) {
        return ["diff", "--unified=0", "--no-color", `${mergeBase}...HEAD`];
      }
    } catch {
      // Ref inexistente — tenta a próxima.
    }
  }
  return ["diff", "--unified=0", "--no-color", "HEAD"];
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksLikePlaceholder(match) {
  const value = match.replace(/^[^'":=]*[:=]\s*/, "").replace(/^['"]|['"]$/g, "");
  return PLACEHOLDERS.some((pattern) => pattern.test(value));
}

/** Extrai as linhas adicionadas de um diff unificado. */
function addedLines(diff) {
  const result = [];
  let file = null;
  let lineNumber = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      lineNumber = match ? Number(match[1]) : 0;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file) result.push({ file, line: lineNumber, text: raw.slice(1) });
      lineNumber += 1;
    }
  }
  return result;
}

function scan(lines) {
  const findings = [];
  for (const entry of lines) {
    if (EXEMPT_PATHS.some((pattern) => pattern.test(entry.file))) continue;
    if (entry.text.includes(IGNORE_MARKER)) continue;

    const isTest = TEST_PATH.test(entry.file);
    for (const rule of RULES) {
      if (rule.skipInTests && isTest) continue;
      const match = rule.pattern.exec(entry.text);
      if (!match) continue;
      if (looksLikePlaceholder(match[0])) continue;
      if (rule.entropy && shannonEntropy(match[0]) < rule.entropy) continue;

      findings.push({
        ...entry,
        rule: rule.id,
        label: rule.label,
        // Nunca imprime o valor completo — só o suficiente para localizar.
        excerpt: `${match[0].slice(0, 12)}…(${match[0].length} caracteres)`,
      });
      break;
    }
  }
  return findings;
}

const isCi = process.env.GITHUB_ACTIONS === "true";
const diffArgs = resolveDiffArgs(parseArgs(process.argv.slice(2)));

let diff;
try {
  diff = git(diffArgs);
} catch (error) {
  console.error(`Não foi possível calcular o diff: ${error.message}`);
  process.exit(2);
}

const lines = addedLines(diff);
const findings = scan(lines);

console.log(`Varredura de segredos: ${lines.length} linhas adicionadas analisadas.`);

if (findings.length === 0) {
  console.log("Nenhuma credencial detectada.");
  process.exit(0);
}

for (const finding of findings) {
  const message = `Possível credencial (${finding.label}): ${finding.excerpt}`;
  if (isCi) {
    console.log(`::error file=${finding.file},line=${finding.line}::${message}`);
  } else {
    console.error(`${finding.file}:${finding.line}  ${message}`);
  }
}

console.error(
  [
    "",
    `${findings.length} achado(s). Se algum segredo real foi exposto:`,
    "  1. rotacione a credencial no provedor imediatamente;",
    "  2. remova o valor do código (use vscode.SecretStorage ou variável de ambiente);",
    "  3. só então limpe o histórico do Git.",
    "",
    `Falso positivo? Adicione o comentário \`${IGNORE_MARKER}\` na linha e explique no PR.`,
  ].join("\n"),
);
process.exit(1);
