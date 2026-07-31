import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  AGENT_AUTONOMY_MODES,
  EMPTY_SKILL_CATALOG,
  SKILL_RISK_LEVELS,
  type AgentAutonomyMode,
  type SkillCatalogStatus,
  type SkillProblem,
  type SkillRiskLevel,
  type SkillScope,
  type SkillSummary,
} from '../core/types';
import type { Logger } from '../logger';
import type { WorkspaceService } from '../workspace/WorkspaceService';
import {
  estimateTokens,
  extractTitle,
  isValidSkillName,
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_DESCRIPTION_LENGTH,
  parseSkillFile,
} from './frontmatter';

const decoder = new TextDecoder();

/** Subdiretórios que pertencem a uma skill e nunca são varridos como skill. */
export const SKILL_SUPPORT_DIRS: ReadonlySet<string> = new Set([
  'references',
  'templates',
  'assets',
  'scripts',
]);

/** Profundidade máxima da varredura a partir da raiz: `<categoria>/<nome>/`. */
const MAX_SCAN_DEPTH = 3;

/**
 * Pastas lidas além das nossas. São somente-leitura: o Prometheon nunca grava
 * nelas, mas uma skill escrita para o Claude Code funciona aqui sem cópia.
 */
export const COMPATIBLE_PROJECT_ROOTS: readonly string[] = [
  '.claude/skills',
  '.github/skills',
  '.agents/skills',
];
export const COMPATIBLE_HOME_ROOTS: readonly string[] = ['.claude/skills', '.agents/skills'];

interface ScanRoot {
  readonly uri: vscode.Uri;
  readonly scope: SkillScope;
}

/**
 * Catálogo de skills desta máquina.
 *
 * Varre as raízes na ordem de precedência e guarda o resultado até alguém
 * pedir para reler. O corpo do `SKILL.md` **não** entra aqui: o registry é o
 * nível 1 do progressive disclosure — nome, gatilho e governança. Quem carrega
 * o corpo é o `SkillLoader`, quando o agente pede.
 */
export class SkillRegistry {
  private catalog: SkillCatalogStatus | null = null;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly logger: Logger,
  ) {}

  /** Raízes na ordem em que vencem, da mais compartilhada à de compatibilidade. */
  roots(): readonly ScanRoot[] {
    const roots: ScanRoot[] = [];
    const projectDir = this.workspace.prometheonDir;
    if (projectDir !== null) {
      roots.push({ uri: vscode.Uri.joinPath(projectDir, 'skills'), scope: 'project' });
    }
    roots.push({
      uri: vscode.Uri.file(join(homedir(), '.prometheon', 'skills')),
      scope: 'machine',
    });

    const folder = this.workspace.folder;
    if (folder !== undefined) {
      for (const relative of COMPATIBLE_PROJECT_ROOTS) {
        roots.push({
          uri: vscode.Uri.joinPath(folder.uri, ...relative.split('/')),
          scope: 'compatible',
        });
      }
    }
    for (const relative of COMPATIBLE_HOME_ROOTS) {
      roots.push({
        uri: vscode.Uri.file(join(homedir(), ...relative.split('/'))),
        scope: 'compatible',
      });
    }
    return roots;
  }

  async status(): Promise<SkillCatalogStatus> {
    if (this.catalog === null) {
      this.catalog = await this.scan();
    }
    return this.catalog;
  }

  /** Descarta o cache. A próxima leitura varre o disco de novo. */
  invalidate(): void {
    this.catalog = null;
  }

  async find(name: string): Promise<SkillSummary | undefined> {
    return (await this.status()).skills.find((skill) => skill.name === name);
  }

  private async scan(): Promise<SkillCatalogStatus> {
    const skills: SkillSummary[] = [];
    const problems: SkillProblem[] = [];
    const roots: string[] = [];
    const seen = new Set<string>();

    for (const root of this.roots()) {
      if (!(await exists(root.uri))) {
        continue;
      }
      roots.push(root.uri.fsPath);
      for (const found of await this.scanRoot(root, problems)) {
        // Precedência: a primeira raiz que declara um nome é a que vale. As
        // demais continuam no disco, mas não competem pelo mesmo identificador.
        if (!seen.has(found.name)) {
          seen.add(found.name);
          skills.push(found);
        }
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (skills.length === 0 && problems.length === 0) {
      return { ...EMPTY_SKILL_CATALOG, roots };
    }
    this.logger.info(`Catálogo de skills: ${skills.length} lidas, ${problems.length} com problema.`);
    return { skills, problems, roots };
  }

  /** Varredura recursiva rasa: qualquer pasta com `SKILL.md` é uma skill. */
  private async scanRoot(
    root: ScanRoot,
    problems: SkillProblem[],
    directory: vscode.Uri = root.uri,
    depth = 0,
  ): Promise<readonly SkillSummary[]> {
    if (depth > MAX_SCAN_DEPTH) {
      return [];
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch (error) {
      problems.push({ path: directory.fsPath, detail: String(error) });
      return [];
    }

    const manifest = entries.find(
      ([name, type]) => name === 'SKILL.md' && type === vscode.FileType.File,
    );
    if (manifest !== undefined) {
      const skill = await this.readSkill(vscode.Uri.joinPath(directory, 'SKILL.md'), root.scope);
      if ('detail' in skill) {
        problems.push(skill);
        return [];
      }
      return [skill];
    }

    const found: SkillSummary[] = [];
    for (const [name, type] of entries) {
      // `references/`, `scripts/` e companhia pertencem à skill de cima. Varrer
      // dentro delas transformaria um exemplo arquivado em skill ativa.
      if (type !== vscode.FileType.Directory || SKILL_SUPPORT_DIRS.has(name)) {
        continue;
      }
      found.push(
        ...(await this.scanRoot(root, problems, vscode.Uri.joinPath(directory, name), depth + 1)),
      );
    }
    return found;
  }

  /**
   * Arquivos de `references/`, `scripts/`, `templates/` e `assets/`.
   *
   * Só um nível: é a regra de referência do VS Code, e é o que o loader aceita
   * resolver. Uma pasta aninhada aqui seria listada e não abriria.
   */
  private async listSupportFiles(root: vscode.Uri): Promise<readonly string[]> {
    const found: string[] = [];
    for (const directory of SKILL_SUPPORT_DIRS) {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, directory));
      } catch {
        // Skill sem `references/` é o caso comum, não um erro.
        continue;
      }
      for (const [entry, type] of entries) {
        if (type === vscode.FileType.File) {
          found.push(`${directory}/${entry}`);
        }
      }
    }
    return found.sort((a, b) => a.localeCompare(b, 'en'));
  }

  private async readSkill(
    file: vscode.Uri,
    scope: SkillScope,
  ): Promise<SkillSummary | SkillProblem> {
    let raw: string;
    try {
      raw = decoder.decode(await vscode.workspace.fs.readFile(file));
    } catch (error) {
      return { path: file.fsPath, detail: `Could not read the file: ${String(error)}` };
    }
    if (raw.length > MAX_SKILL_CONTENT_CHARS) {
      return {
        path: file.fsPath,
        detail: `SKILL.md is longer than ${String(MAX_SKILL_CONTENT_CHARS)} characters. Move the bulk into references/.`,
      };
    }

    const { frontmatter, body } = parseSkillFile(raw);
    const segments = file.path.split('/');
    const folder = segments[segments.length - 2] ?? '';
    const name = text(frontmatter['name']);
    const description = text(frontmatter['description']);

    if (name === null) {
      return { path: file.fsPath, detail: 'The frontmatter has no `name`.' };
    }
    if (!isValidSkillName(name)) {
      return {
        path: file.fsPath,
        detail: `"${name}" is not a valid skill name. Use lowercase letters, digits and hyphens, up to 64 characters.`,
      };
    }
    // A regra dos três hosts. Sem ela, `skill.load("x")` acharia uma pasta e o
    // índice anunciaria outra — e a divergência só apareceria na execução.
    if (name !== folder) {
      return {
        path: file.fsPath,
        detail: `The frontmatter says "${name}" but the folder is "${folder}". They must match.`,
      };
    }
    if (description === null) {
      return { path: file.fsPath, detail: 'The frontmatter has no `description`.' };
    }
    if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      return {
        path: file.fsPath,
        detail: `The description is longer than ${String(MAX_SKILL_DESCRIPTION_LENGTH)} characters.`,
      };
    }

    const extension = prometheonMetadata(frontmatter);
    const risk = isRecord(extension['risk']) ? extension['risk'] : {};
    // Uma skill que manipula segredo nunca roda sozinha, diga o que disser o
    // `autonomy_ceiling` — a regra de segredos do repositório vem antes.
    const handlesSecrets = risk['handles_secrets'] === true;
    const declaredCeiling = oneOf(extension['autonomy_ceiling'], AGENT_AUTONOMY_MODES);
    const platforms = stringList(frontmatter['platforms']);

    return {
      name,
      title: extractTitle(body, name),
      description,
      category: text(extension['category']) ?? (segments[segments.length - 3] ?? 'general'),
      scope,
      riskLevel: oneOf<SkillRiskLevel>(risk['level'], SKILL_RISK_LEVELS) ?? 'low',
      version: text(frontmatter['version']),
      license: text(frontmatter['license']),
      author: text(frontmatter['author']),
      platforms,
      requiresMcp: stringList(isRecord(extension['mcp']) ? extension['mcp']['requires'] : []),
      autonomyCeiling: handlesSecrets ? 'manual' : (declaredCeiling ?? 'auto'),
      bodyTokensEstimate: estimateTokens(body),
      supportFiles: await this.listSupportFiles(vscode.Uri.joinPath(file, '..')),
      path: file.fsPath,
      supported: platforms.length === 0 || platforms.includes(currentPlatform()),
    };
  }
}

/** `metadata.prometheon`, com `metadata.hermes` aceito na leitura de importados. */
function prometheonMetadata(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const metadata = isRecord(frontmatter['metadata']) ? frontmatter['metadata'] : {};
  const ours = isRecord(metadata['prometheon']) ? metadata['prometheon'] : null;
  const theirs = isRecord(metadata['hermes']) ? metadata['hermes'] : {};
  return ours ?? theirs;
}

/** O nome que `platforms:` usa para este sistema. */
export function currentPlatform(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => text(entry))
    .filter((entry): entry is string => entry !== null)
    .slice(0, 32);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

/** Reexportado para o adapter não precisar conhecer o módulo de tipos. */
export type { AgentAutonomyMode };
