import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse, stringify } from 'yaml';
import {
  AGENT_ROLES,
  MAX_CUSTOM_ROLES,
  MAX_ROLE_DESCRIPTION_LENGTH,
  MAX_ROLE_LABEL_LENGTH,
  MAX_SKILLS_PER_ROLE,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  type AgentRole,
  type AgentRoleScope,
  type CustomAgentRole,
} from '../core/types';
import type { Logger } from '../logger';
import type { WorkspaceService } from '../workspace/WorkspaceService';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Onde cada escopo guarda os papéis, a partir da raiz que lhe corresponde. */
export const PROJECT_ROLES_PATH = ['agents', 'roles.yaml'] as const;
export const MACHINE_ROLES_FILE = 'roles.json';

const PROJECT_FILE_HEADER = `# Papéis de agente deste projeto.
#
# Este arquivo é versionado: quem clonar o repositório recebe os mesmos papéis.
# É configuração, nunca credencial — segredos vivem apenas no cofre do VS Code.
`;

/**
 * Persistência dos papéis nomeados.
 *
 * Dois escopos, dois formatos, pela mesma razão que o resto do produto separa
 * o que é da equipe do que é da máquina:
 *
 * - **projeto** — `.prometheon/agents/roles.yaml`, YAML comentado e comitado,
 *   editável à mão como o `prometheon.yaml`;
 * - **máquina** — `~/.prometheon/roles.json`, ao lado de `agent-profiles.json`,
 *   fora de qualquer repositório.
 *
 * O escopo `hub` não passa por aqui: ele chega pela rede, no `AgentRoleService`.
 */
export class AgentRoleStore {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly logger: Logger,
  ) {}

  get machineRoot(): vscode.Uri {
    return vscode.Uri.file(join(homedir(), '.prometheon'));
  }

  get machineFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.machineRoot, MACHINE_ROLES_FILE);
  }

  /** Nulo quando não há pasta aberta: sem workspace não existe papel de projeto. */
  get projectFile(): vscode.Uri | null {
    const dir = this.workspace.prometheonDir;
    return dir === null ? null : vscode.Uri.joinPath(dir, ...PROJECT_ROLES_PATH);
  }

  async readProject(): Promise<readonly CustomAgentRole[]> {
    const file = this.projectFile;
    if (file === null) {
      return [];
    }
    return this.read(file, 'project', (text) => parse(text));
  }

  async readMachine(): Promise<readonly CustomAgentRole[]> {
    return this.read(this.machineFile, 'machine', (text) => JSON.parse(text));
  }

  async writeProject(roles: readonly CustomAgentRole[]): Promise<void> {
    const file = this.projectFile;
    if (file === null) {
      throw new Error('No folder is open, so there is no project to save the role in.');
    }
    const body = stringify(
      { version: 1, roles: roles.map(toSerializable) },
      { lineWidth: 100, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' },
    );
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
    await vscode.workspace.fs.writeFile(file, encoder.encode(`${PROJECT_FILE_HEADER}\n${body}`));
    this.logger.info(`Papéis de projeto gravados (${roles.length}).`);
  }

  async writeMachine(roles: readonly CustomAgentRole[]): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.machineRoot);
    const content = `${JSON.stringify(roles.map(toSerializable), null, 2)}\n`;
    await vscode.workspace.fs.writeFile(this.machineFile, encoder.encode(content));
    this.logger.info(`Papéis desta máquina gravados (${roles.length}).`);
  }

  private async read(
    file: vscode.Uri,
    scope: AgentRoleScope,
    decode: (text: string) => unknown,
  ): Promise<readonly CustomAgentRole[]> {
    let parsed: unknown;
    try {
      parsed = decode(decoder.decode(await vscode.workspace.fs.readFile(file)));
    } catch (error) {
      // Arquivo ausente é o estado normal; ilegível vira aviso e lista vazia,
      // porque um papel malformado não pode virar execução com o papel errado.
      if (!(error instanceof vscode.FileSystemError)) {
        this.logger.warn(`Não foi possível ler ${file.fsPath}: ${String(error)}`);
      }
      return [];
    }
    const roles = normalizeRoleList(parsed, scope, (message) => this.logger.warn(message));
    if (scope === 'hub') {
      return roles;
    }
    // O prompt em arquivo vence o texto inline: `prompts/<id>.md` é editável
    // no editor de verdade e, no escopo de projeto, revisável em PR — mudar o
    // comportamento de um agente do time sem review é mudar código sem review.
    return Promise.all(
      roles.map(async (role) => {
        const filePrompt = await this.readPromptFile(scope, role.id);
        return filePrompt === null
          ? role
          : { ...role, systemPrompt: filePrompt, promptFile: true };
      }),
    );
  }

  /** Pasta dos prompts em arquivo, por escopo. `hub` não tem: a fonte é a API. */
  promptDir(scope: 'project' | 'machine'): vscode.Uri | null {
    if (scope === 'machine') {
      return vscode.Uri.joinPath(this.machineRoot, 'agents', 'prompts');
    }
    const dir = this.workspace.prometheonDir;
    return dir === null ? null : vscode.Uri.joinPath(dir, 'agents', 'prompts');
  }

  /**
   * Conteúdo útil de `prompts/<id>.md`: o corpo, sem o frontmatter. `null`
   * quando o arquivo não existe ou não tem nada além do cabeçalho.
   */
  private async readPromptFile(
    scope: 'project' | 'machine',
    id: string,
  ): Promise<string | null> {
    const dir = this.promptDir(scope);
    if (dir === null) {
      return null;
    }
    let raw: string;
    try {
      raw = decoder.decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, `${id}.md`)),
      );
    } catch {
      return null;
    }
    const body = stripFrontmatter(raw).trim();
    if (body === '') {
      return null;
    }
    if (body.length > MAX_SYSTEM_PROMPT_LENGTH) {
      this.logger.warn(
        `Prompt da função ${id} excede ${MAX_SYSTEM_PROMPT_LENGTH} caracteres e foi truncado.`,
      );
      return body.slice(0, MAX_SYSTEM_PROMPT_LENGTH);
    }
    return body;
  }

  /**
   * Garante o arquivo de prompt da função — criado do template quando falta,
   * jamais sobrescrito — e devolve o caminho para abrir no editor.
   */
  async ensurePromptFile(
    scope: 'project' | 'machine',
    role: CustomAgentRole,
  ): Promise<vscode.Uri> {
    const dir = this.promptDir(scope);
    if (dir === null) {
      throw new Error('No folder is open, so there is no project to keep the prompt in.');
    }
    const file = vscode.Uri.joinPath(dir, `${role.id}.md`);
    try {
      await vscode.workspace.fs.stat(file);
      return file;
    } catch {
      // Não existe: é o caminho normal da criação.
    }
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, encoder.encode(promptTemplate(role)));
    this.logger.info(`Prompt da função ${role.id} criado em ${file.fsPath}.`);
    return file;
  }
}

/** Corta o frontmatter YAML (`--- ... ---`) do início, se houver. */
export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match === null ? raw : raw.slice(match[0].length);
}

/**
 * Esqueleto do prompt de uma função. As seções forçam o que um bom prompt tem
 * e um vago não tem: limites duros e critério de parada.
 */
function promptTemplate(role: CustomAgentRole): string {
  return `---
role: ${role.id}
extends: ${role.basedOn}
---

# Missão
${role.label}: o que este agente entrega, em uma frase.

## Sempre
- Regras positivas que valem em toda sessão.

## Nunca
- Limites duros — o que não fazer nem quando pedido.

## Contexto do projeto
- Onde olhar primeiro: pastas, docs, convenções.

## Definição de pronto
- Como provar que terminou: testes, build, evidência.
`;
}

/** O que vai para disco. `scope` fica de fora: quem diz é o arquivo. */
function toSerializable(role: CustomAgentRole): Record<string, unknown> {
  return {
    id: role.id,
    label: role.label,
    description: role.description,
    basedOn: role.basedOn,
    skills: [...role.skills],
    ...(role.systemPrompt === undefined ? {} : { systemPrompt: role.systemPrompt }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > maxLength ? null : trimmed;
}

/**
 * Aceita tanto `{ version, roles: [...] }` quanto a lista solta — o segundo
 * formato é o do arquivo da máquina, e alguém que edite o YAML à mão tende a
 * escrever um dos dois.
 */
export function normalizeRoleList(
  raw: unknown,
  scope: AgentRoleScope,
  warn: (message: string) => void,
): readonly CustomAgentRole[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw['roles'] : undefined;
  if (!Array.isArray(list)) {
    if (raw !== undefined && raw !== null) {
      warn(`Lista de papéis inválida no escopo ${scope}; ignorada.`);
    }
    return [];
  }

  const roles: CustomAgentRole[] = [];
  const seen = new Set<string>();
  for (const entry of list.slice(0, MAX_CUSTOM_ROLES)) {
    const role = normalizeCustomRole(entry, scope);
    if (role === null) {
      warn(`Papel inválido no escopo ${scope}; entrada descartada.`);
      continue;
    }
    // Dois papéis com o mesmo id tornariam o vínculo do agente ambíguo.
    if (!seen.has(role.id)) {
      seen.add(role.id);
      roles.push(role);
    }
  }
  return roles;
}

/**
 * Validação de runtime de um papel vindo de disco ou da rede. Nada é
 * normalizado em silêncio: a entrada inteira é descartada.
 */
export function normalizeCustomRole(value: unknown, scope: AgentRoleScope): CustomAgentRole | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = roleId(text(value['id'], 96) ?? '');
  const label = text(value['label'], MAX_ROLE_LABEL_LENGTH);
  const description = text(value['description'], MAX_ROLE_DESCRIPTION_LENGTH);
  const basedOn = AGENT_ROLES.find((candidate) => candidate === value['basedOn']) ?? null;
  const skills = skillList(value['skills']);
  if (id === '' || label === null || description === null || basedOn === null || skills === null) {
    return null;
  }

  const raw = value['systemPrompt'];
  const systemPrompt = raw === undefined || raw === null ? undefined : text(raw, MAX_SYSTEM_PROMPT_LENGTH);
  if (systemPrompt === null) {
    return null;
  }

  return {
    id,
    label,
    description,
    basedOn: basedOn as AgentRole,
    skills,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    scope,
  };
}

function skillList(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_SKILLS_PER_ROLE) {
    return null;
  }
  const skills: string[] = [];
  for (const entry of value) {
    const name = text(entry, MAX_TOOL_NAME_LENGTH);
    if (name === null) {
      return null;
    }
    if (!skills.includes(name)) {
      skills.push(name);
    }
  }
  return skills;
}

/** Identificador de papel: minúsculas, dígitos e hífen, como o de skill. */
export function roleId(value: string): string {
  // NFD separa o acento da letra e o passo seguinte descarta o que não for
  // ASCII, então "Revisão" vira "revisao" e não "reviso".
  return value
    .normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
