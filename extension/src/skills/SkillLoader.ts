import { dirname } from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import { estimateTokens, MAX_SKILL_CONTENT_CHARS, parseSkillFile } from './frontmatter';
import { SKILL_SUPPORT_DIRS, type SkillRegistry } from './SkillRegistry';

const decoder = new TextDecoder();

/** Acima disso, o turno comprimido troca o corpo por um marcador de recarga. */
export const PRUNE_THRESHOLD_CHARS = 5_000;

export interface LoadedSkill {
  readonly name: string;
  readonly title: string;
  /** Corpo do `SKILL.md`, sem o frontmatter. É o nível 2. */
  readonly body: string;
  /** Arquivos de apoio disponíveis, para o modelo escolher o que pedir. */
  readonly references: readonly string[];
  readonly tokens: number;
}

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`No skill named "${name}" is available here.`);
    this.name = 'SkillNotFoundError';
  }
}

/**
 * Carga sob demanda do corpo de uma skill e dos seus arquivos de apoio.
 *
 * O registry entrega o nível 1 (nome e gatilho). Este é quem paga o contexto:
 * nível 2 é o corpo, e só quando o modelo invoca a skill; nível 3 são os
 * arquivos de `references/`, e só quando o corpo aponta e o modelo pede.
 */
export class SkillLoader {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly logger: Logger,
  ) {}

  /** Nível 2. Falha quando a skill não existe — nunca devolve corpo vazio. */
  async load(name: string): Promise<LoadedSkill> {
    const skill = await this.registry.find(name);
    if (skill === undefined) {
      throw new SkillNotFoundError(name);
    }
    const file = vscode.Uri.file(skill.path);
    const raw = decoder.decode(await vscode.workspace.fs.readFile(file));
    const { body } = parseSkillFile(raw);

    this.logger.debug(`Skill ${skill.name}: corpo carregado (${skill.supportFiles.length} apoios).`);
    return {
      name: skill.name,
      title: skill.title,
      body,
      // A varredura já listou os apoios; reler o diretório aqui daria duas
      // respostas para a mesma pergunta, que é como elas começam a divergir.
      references: skill.supportFiles,
      tokens: estimateTokens(body),
    };
  }

  /**
   * Nível 3. `file` é relativo à pasta da skill e não pode sair dela: a webview
   * pede skills pelo nome, e um caminho vindo de fora não vira leitura
   * arbitrária de disco.
   */
  async loadReference(name: string, file: string): Promise<string> {
    const skill = await this.registry.find(name);
    if (skill === undefined) {
      throw new SkillNotFoundError(name);
    }
    const root = vscode.Uri.file(dirname(skill.path));
    const target = resolveInside(root, file);
    if (target === null) {
      throw new Error(`"${file}" is not a support file of the skill "${name}".`);
    }

    const raw = decoder.decode(await vscode.workspace.fs.readFile(target));
    if (raw.length > MAX_SKILL_CONTENT_CHARS) {
      throw new Error(`"${file}" is too large to load into the context.`);
    }
    return raw;
  }

}

/**
 * Resolve um caminho relativo dentro da pasta da skill.
 *
 * Um nível de profundidade, e só dentro da allowlist de subpastas — é a regra
 * de referência do VS Code e, aqui, também a defesa contra `../`.
 */
export function resolveInside(root: vscode.Uri, relative: string): vscode.Uri | null {
  const segments = relative.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.length !== 2 || segments.some((segment) => segment === '..')) {
    return null;
  }
  const [directory, file] = segments;
  if (directory === undefined || file === undefined || !SKILL_SUPPORT_DIRS.has(directory)) {
    return null;
  }
  return vscode.Uri.joinPath(root, directory, file);
}

/**
 * Marcador que substitui uma skill grande na compactação do turno.
 *
 * Sem isto o agente "acha" que ainda tem o procedimento e improvisa — o pior
 * modo de falha num sistema que existe para tornar o processo previsível. O
 * caminho vai no marcador pela mesma razão que vai no índice: é por ele que a
 * skill volta, com a ferramenta de leitura que o agente já tem.
 */
export function prunedMarker(name: string, version: string | null, path: string): string {
  const suffix = version === null ? '' : `@${version}`;
  return `[SKILL_PRUNED: ${name}${suffix}; read it again at ${path}]`;
}
