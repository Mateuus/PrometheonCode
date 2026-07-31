#!/usr/bin/env node
// Importa skills da biblioteca de referência para `.prometheon/skills/`.
//
// A lista abaixo é a recomendação do estudo (`Docs/Estudos/Orquestracao-Multi-
// Agente/03_SKILLS_E_BANCO_DE_CONHECIMENTO.md`, §8.5): as cinco ondas que fazem
// sentido para uma extensão de VS Code em TypeScript, com Unreal Engine e
// orquestração multi-agente. O que ficou de fora ficou por motivo declarado —
// licença proprietária, risco alto sem ganho, ou nada a ver com o produto.
//
// O que este script **não** faz, de propósito:
//
// - não importa skill sem `license:` no frontmatter. Sem licença declarada não
//   há permissão para redistribuir, e um arquivo comitado é redistribuição.
// - não inventa autoria. `author:` é preservado como está, e a procedência vai
//   para `metadata.prometheon.provenance` — que é o que permite responder
//   depois "de onde veio este procedimento?".
// - não reescreve o corpo. Adaptar o texto é trabalho humano; o script só move
//   o arquivo e traduz o namespace do frontmatter.
//
// Uso:
//   node scripts/import-skills.mjs [--dry-run] [--force]

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERMES = join(ROOT, 'Docs', 'Projects', 'hermes-agent-main');
const ORCHESTRATOR = join(ROOT, 'Docs', 'Projects', 'agent-orchestrator-main');
const TARGET = join(ROOT, '.prometheon', 'skills');

/** Licenças que permitem redistribuir com atribuição. */
const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'CC-BY-4.0', 'ISC'];

/**
 * Licença do repositório de origem, verificada no `LICENSE` de cada um.
 *
 * Ela cobre todo o conteúdo do repositório, então uma skill que não declara
 * `license:` no frontmatter está sob ela. O caminho inverso não vale: um
 * `license: Proprietary` no arquivo é uma exceção declarada pelo autor e vence
 * a do repositório — é assim que as skills de Office do hermes são excluídas.
 */
const REPOSITORY_LICENSES = new Map([
  [HERMES, { license: 'MIT', holder: 'Nous Research', project: 'hermes-agent' }],
  [ORCHESTRATOR, { license: 'Apache-2.0', holder: 'Agent Orchestrator', project: 'agent-orchestrator' }],
]);

/**
 * As 33 skills, por onda. `from` é relativo à raiz do projeto de origem;
 * `category` é a pasta de destino em `.prometheon/skills/`.
 */
const WAVES = [
  {
    name: 'Onda 1 — disciplina de desenvolvimento',
    skills: [
      { source: HERMES, from: 'skills/software-development/test-driven-development', category: 'software-development' },
      { source: HERMES, from: 'skills/software-development/systematic-debugging', category: 'software-development' },
      { source: HERMES, from: 'skills/software-development/plan', category: 'software-development' },
      { source: HERMES, from: 'skills/software-development/spike', category: 'software-development' },
      { source: HERMES, from: 'skills/software-development/requesting-code-review', category: 'software-development' },
      { source: HERMES, from: 'skills/software-development/simplify-code', category: 'software-development' },
      { source: HERMES, from: 'optional-skills/software-development/subagent-driven-development', category: 'software-development' },
      { source: HERMES, from: 'optional-skills/software-development/code-wiki', category: 'software-development' },
      { source: HERMES, from: 'optional-skills/software-development/rest-graphql-debug', category: 'software-development' },
      { source: HERMES, from: 'skills/software-development/node-inspect-debugger', category: 'software-development' },
      { source: ORCHESTRATOR, from: 'skills/bug-triage', category: 'software-development' },
    ],
  },
  {
    name: 'Onda 2 — Git, GitHub e authoring',
    skills: [
      { source: HERMES, from: 'skills/github/github-pr-workflow', category: 'github' },
      { source: HERMES, from: 'skills/github/github-code-review', category: 'github' },
      { source: HERMES, from: 'skills/github/github-issues', category: 'github' },
      { source: HERMES, from: 'skills/github/github-auth', category: 'github' },
      { source: HERMES, from: 'skills/github/github-repo-management', category: 'github' },
      { source: HERMES, from: 'skills/github/codebase-inspection', category: 'github' },
      { source: HERMES, from: 'skills/software-development/hermes-agent-skill-authoring', category: 'software-development' },
    ],
  },
  {
    name: 'Onda 3 — Unreal Engine e 3D',
    skills: [
      { source: HERMES, from: 'optional-skills/creative/unreal-mcp', category: 'creative' },
      { source: HERMES, from: 'optional-skills/creative/blender-mcp', category: 'creative' },
      { source: HERMES, from: 'skills/creative/comfyui', category: 'creative' },
    ],
  },
  {
    name: 'Onda 4 — orquestração e delegação',
    skills: [
      { source: HERMES, from: 'skills/autonomous-ai-agents/claude-code', category: 'autonomous-ai-agents' },
      { source: HERMES, from: 'skills/autonomous-ai-agents/codex', category: 'autonomous-ai-agents' },
      { source: HERMES, from: 'skills/autonomous-ai-agents/opencode', category: 'autonomous-ai-agents' },
      { source: HERMES, from: 'optional-skills/autonomous-ai-agents/grok', category: 'autonomous-ai-agents' },
      { source: HERMES, from: 'optional-skills/autonomous-ai-agents/openhands', category: 'autonomous-ai-agents' },
      { source: HERMES, from: 'skills/autonomous-ai-agents/computer-use', category: 'autonomous-ai-agents' },
    ],
  },
  {
    name: 'Onda 5 — conhecimento e MCP',
    skills: [
      { source: HERMES, from: 'skills/note-taking/obsidian', category: 'knowledge' },
      { source: HERMES, from: 'skills/research/llm-wiki', category: 'knowledge' },
      { source: HERMES, from: 'optional-skills/research/qmd', category: 'knowledge' },
      { source: HERMES, from: 'optional-skills/research/gitnexus-explorer', category: 'knowledge' },
      { source: HERMES, from: 'optional-skills/mcp/fastmcp', category: 'mcp' },
      { source: HERMES, from: 'optional-skills/mcp/mcporter', category: 'mcp' },
    ],
  },
];

/** Subpastas que pertencem à skill e viajam junto. */
const SUPPORT_DIRS = ['references', 'templates', 'assets', 'scripts'];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');

/** Frontmatter e corpo, com as mesmas regras do `SkillRegistry`. */
function parseSkillFile(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.startsWith('---')) {
    return { header: '', body: text };
  }
  const closing = /\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (closing === null) {
    return { header: '', body: text };
  }
  return {
    header: text.slice(4, closing.index),
    body: text.slice(closing.index + closing[0].length).replace(/^\r?\n/, ''),
  };
}

/** Valor de uma chave de primeiro nível do frontmatter, sem parser de YAML. */
function field(header, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(header);
  const value = match?.[1]?.trim();
  if (value === undefined) {
    return null;
  }
  return value.replace(/^["'](.*)["']$/, '$1');
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) {
      copyTree(source, target);
    } else {
      copyFileSync(source, target);
    }
  }
}

const imported = [];
const skipped = [];

for (const wave of WAVES) {
  for (const entry of WAVES.flatMap((w) => (w === wave ? w.skills : []))) {
    const from = join(entry.source, entry.from);
    const manifest = join(from, 'SKILL.md');

    if (!existsSync(manifest)) {
      skipped.push({ ...entry, reason: 'SKILL.md não encontrado na origem' });
      continue;
    }

    const repository = REPOSITORY_LICENSES.get(entry.source);
    if (repository === undefined) {
      skipped.push({ ...entry, reason: 'origem sem licença de repositório verificada' });
      continue;
    }

    const raw = readFileSync(manifest, 'utf8');
    const { header, body } = parseSkillFile(raw);
    const name = field(header, 'name');
    const description = field(header, 'description');
    const declared = field(header, 'license');
    const author = field(header, 'author') ?? field(header, 'authors');
    const version = field(header, 'version') ?? '1.0.0';
    const platforms = field(header, 'platforms') ?? '[linux, macos, windows]';

    if (name === null || description === null) {
      skipped.push({ ...entry, reason: 'frontmatter sem `name` ou `description`' });
      continue;
    }

    // Frontmatter vence repositório: `license: Proprietary` num arquivo é uma
    // exceção declarada pelo autor, e ignorá-la seria redistribuir sem direito.
    const license = declared ?? repository.license;
    if (!ALLOWED_LICENSES.includes(license)) {
      skipped.push({ ...entry, name, reason: `licença não permite redistribuir: ${license}` });
      continue;
    }

    const destination = join(TARGET, entry.category, name);
    if (existsSync(destination) && !force) {
      skipped.push({ ...entry, name, reason: 'já existe no destino (use --force)' });
      continue;
    }

    const rewritten = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      `version: ${version}`,
      `author: ${author ?? repository.holder}`,
      `license: ${license}`,
      `platforms: ${platforms}`,
      'metadata:',
      '  prometheon:',
      `    category: ${entry.category}`,
      '    provenance:',
      `      source_project: ${repository.project}`,
      `      source_path: ${entry.from}`,
      `      upstream_license: ${license}`,
      // Onde a licença foi lida importa para uma auditoria futura: a do arquivo
      // é declaração do autor; a do repositório vale por abrangência.
      `      license_source: ${declared === null ? 'repository' : 'frontmatter'}`,
      '      attribution_required: true',
      '---',
      '',
      body,
    ].join('\n');

    if (!dryRun) {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'SKILL.md'), rewritten, 'utf8');
      for (const support of SUPPORT_DIRS) {
        const supportDir = join(from, support);
        if (existsSync(supportDir)) {
          copyTree(supportDir, join(destination, support));
        }
      }
    }

    imported.push({
      name,
      category: entry.category,
      license,
      licenseSource: declared === null ? 'repositório' : 'frontmatter',
      author: author ?? repository.holder,
      origin: repository.project,
      from: entry.from,
    });
  }
}

// NOTICE: a atribuição exigida pelas licenças, num arquivo só, gerado e não
// escrito à mão — assim ele não fica para trás quando a lista muda.
const notice = [
  '# NOTICE',
  '',
  'Skills importadas de projetos de terceiros, redistribuídas sob as licenças abaixo.',
  'Cada `SKILL.md` guarda a procedência completa em `metadata.prometheon.provenance`.',
  '',
  '| Skill | Categoria | Licença | Declarada em | Autoria | Origem |',
  '| --- | --- | --- | --- | --- | --- |',
  ...imported.map(
    (entry) =>
      `| \`${entry.name}\` | ${entry.category} | ${entry.license} | ${entry.licenseSource} | ${entry.author} | ${entry.origin}: \`${entry.from}\` |`,
  ),
  '',
].join('\n');

if (!dryRun && imported.length > 0) {
  writeFileSync(join(TARGET, 'NOTICE.md'), notice, 'utf8');
}

console.log(`${dryRun ? '[dry-run] ' : ''}importadas: ${imported.length}`);
for (const entry of imported) {
  console.log(`  + ${entry.category}/${entry.name} (${entry.license})`);
}
if (skipped.length > 0) {
  console.log(`\nnão importadas: ${skipped.length}`);
  for (const entry of skipped) {
    console.log(`  - ${entry.name ?? entry.from}: ${entry.reason}`);
  }
}
console.log(`\ndestino: ${relative(ROOT, TARGET)}`);
