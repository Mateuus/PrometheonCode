import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  AGENT_AUTONOMY_MODES,
  AGENT_ROLES,
  CONTEXT_STRATEGIES,
  EFFORT_LEVELS,
  MAX_CONCURRENT_SESSIONS,
  MAX_MODEL_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_TOOLS_PER_LIST,
  MAX_TOOL_NAME_LENGTH,
  type AgentAutonomyMode,
  type AgentProfile,
  type AgentRole,
  type ContextStrategy,
  type EffortLevel,
} from '../core/types';
import type { Logger } from '../logger';
import { stripFrontmatter } from './AgentRoleStore';
import { BUILTIN_AGENTS } from './builtinAgents';

/**
 * Agent Profiles em dois lugares, e a divisão é o ponto.
 *
 * O agente — nome, papel, modelo, skills, prompt — descreve **como o trabalho é
 * feito neste projeto**, e por isso mora em `.prometheon/agents/agents.json`,
 * que vai para o git: quem clona o repositório recebe a equipe pronta.
 *
 * O que **não** pode ir junto é o vínculo com a conta (`providerProfileId`).
 * Ele aponta para um login desta máquina; versionado, mandaria o colega para
 * uma conta que não é dele — ou para nenhuma. Esse vínculo fica em
 * `~/.prometheon/agent-profiles.json`, junto dos agentes que existem só aqui.
 *
 * Na leitura, projeto vence máquina para o mesmo id, e o binding local é
 * costurado por cima. Um agente do projeto sem conta escolhida aparece na
 * interface pedindo uma — que é exatamente o primeiro passo de quem acabou de
 * clonar o repositório.
 */
export class AgentProfileStore {
  private profiles: AgentProfile[] | null = null;

  constructor(private readonly logger: Logger) {}

  get root(): vscode.Uri {
    return vscode.Uri.file(join(homedir(), '.prometheon'));
  }

  get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'agent-profiles.json');
  }

  /** Pasta do projeto, quando há uma aberta. Sem workspace só existe a máquina. */
  get projectRoot(): vscode.Uri | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder === undefined
      ? null
      : vscode.Uri.joinPath(folder.uri, '.prometheon', 'agents');
  }

  get projectFile(): vscode.Uri | null {
    const root = this.projectRoot;
    return root === null ? null : vscode.Uri.joinPath(root, 'agents.json');
  }

  /**
   * Pasta dos prompts, um `<id>.md` por agente. O do projeto tem precedência:
   * é o manual que a equipe combinou, e ele acompanha o agente no git.
   */
  get promptDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'agent-prompts');
  }

  get projectPromptDir(): vscode.Uri | null {
    const root = this.projectRoot;
    return root === null ? null : vscode.Uri.joinPath(root, 'prompts');
  }

  async list(): Promise<readonly AgentProfile[]> {
    if (this.profiles === null) {
      this.profiles = await this.readAll();
    }
    // O prompt em arquivo é relido a cada listagem: ele muda no editor — pela
    // pessoa ou por um agente — fora do ciclo de gravação do JSON, e um cache
    // aqui congelaria o manual que o run deveria seguir.
    return Promise.all(
      this.profiles.map(async (profile) => {
        const filePrompt = await this.readPromptFile(profile.id);
        return filePrompt === null
          ? profile
          : { ...profile, systemPrompt: filePrompt, promptFile: true };
      }),
    );
  }

  /**
   * Corpo útil de `agent-prompts/<id>.md`, sem o frontmatter. `null` quando o
   * arquivo não existe ou está vazio — aí vale o texto inline do perfil.
   */
  private async readPromptFile(id: string): Promise<string | null> {
    // O do projeto primeiro: é o manual que a equipe combinou, e ele vence o
    // que existir só nesta máquina.
    const candidates = [this.projectPromptDir, this.promptDir].filter(
      (dir): dir is vscode.Uri => dir !== null,
    );
    let raw: string | null = null;
    for (const dir of candidates) {
      try {
        raw = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, `${id}.md`)),
        );
        break;
      } catch {
        // Não existe neste escopo; tenta o próximo.
      }
    }
    if (raw === null) {
      return null;
    }
    const body = stripFrontmatter(raw).trim();
    if (body === '') {
      return null;
    }
    if (body.length > MAX_SYSTEM_PROMPT_LENGTH) {
      this.logger.warn(
        `Prompt do agente ${id} excede ${MAX_SYSTEM_PROMPT_LENGTH} caracteres e foi truncado.`,
      );
      return body.slice(0, MAX_SYSTEM_PROMPT_LENGTH);
    }
    return body;
  }

  /**
   * Garante o arquivo de prompt do agente — criado do template quando falta,
   * jamais sobrescrito — e devolve o caminho para abrir no editor.
   */
  async ensurePromptFile(profile: AgentProfile): Promise<vscode.Uri> {
    // O prompt segue o agente: o do projeto nasce versionado, ao lado da
    // definição dele, e o da máquina continua no perfil local.
    const dir =
      profile.scope === 'project' && this.projectPromptDir !== null
        ? this.projectPromptDir
        : this.promptDir;
    const file = vscode.Uri.joinPath(dir, `${profile.id}.md`);
    try {
      await vscode.workspace.fs.stat(file);
      return file;
    } catch {
      // Não existe: é o caminho normal da criação.
    }
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(
      file,
      new TextEncoder().encode(agentPromptTemplate(profile)),
    );
    this.logger.info(`Prompt do agente ${profile.id} criado em ${file.fsPath}.`);
    return file;
  }

  async find(id: string): Promise<AgentProfile | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  async save(profile: AgentProfile): Promise<void> {
    // Editar um embutido o traz para o disco: a partir daí é um agente como
    // outro qualquer, e o padrão da extensão deixa de valer para ele.
    const saved = profile.scope === 'builtin' ? { ...profile, scope: 'machine' as const } : profile;
    const profiles = [...(await this.list())];
    const index = profiles.findIndex((item) => item.id === saved.id);
    if (index === -1) {
      profiles.push(saved);
    } else {
      profiles[index] = saved;
    }
    await this.write(profiles);
  }

  async remove(id: string): Promise<void> {
    const profiles = (await this.list()).filter((profile) => profile.id !== id);
    await this.write(profiles);
  }

  /**
   * Junta os dois escopos. O agente do projeto vence o de mesmo id na máquina,
   * mas herda dela o vínculo com a conta — que é a única coisa que o projeto
   * não tem como saber.
   */
  private async readAll(): Promise<AgentProfile[]> {
    const machine = await this.read(this.file);
    const project = await this.read(this.projectFile);
    const bindings = await this.readBindings();
    const saved = [...project, ...machine];

    // Os embutidos entram por último e só onde não há nada gravado: assim uma
    // versão nova da extensão nunca desfaz o que alguém editou, e quem editou
    // um padrão passa a ver a versão dele no lugar.
    const builtin = BUILTIN_AGENTS.filter(
      (agent) => !saved.some((profile) => profile.id === agent.id),
    ).map((agent) => ({
      ...agent,
      providerProfileId: bindings.get(agent.id) ?? agent.providerProfileId,
    }));

    if (project.length === 0) {
      return [...machine, ...builtin];
    }

    // A conta vem da máquina: primeiro o vínculo escolhido aqui para um agente
    // do projeto, depois o que já existia num agente local de mesmo id.
    for (const profile of machine) {
      if (!bindings.has(profile.id)) {
        bindings.set(profile.id, profile.providerProfileId);
      }
    }
    const shared = project.map((profile) => ({
      ...profile,
      scope: 'project' as const,
      providerProfileId: bindings.get(profile.id) ?? profile.providerProfileId,
    }));
    const ids = new Set(shared.map((profile) => profile.id));
    return [...shared, ...machine.filter((profile) => !ids.has(profile.id)), ...builtin];
  }

  private async read(target: vscode.Uri | null): Promise<AgentProfile[]> {
    if (target === null) {
      return [];
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed)) {
        this.logger.warn('agent-profiles.json não contém uma lista; ignorado.');
        return [];
      }
      const profiles = parsed
        .map((entry) => normalizeAgentProfile(entry))
        .filter((profile): profile is AgentProfile => profile !== null);
      if (profiles.length !== parsed.length) {
        this.logger.warn(
          `agent-profiles.json tinha ${parsed.length - profiles.length} entrada(s) inválida(s), descartada(s).`,
        );
      }
      return dropDuplicateIds(profiles);
    } catch {
      // Sem arquivo é o estado normal na primeira execução.
      return [];
    }
  }

  private async write(profiles: readonly AgentProfile[]): Promise<void> {
    // `promptFile` é adorno de runtime — se fosse para o JSON, uma cópia do
    // arquivo apagado continuaria dizendo que ele existe.
    const clean = profiles.map((profile) => {
      const { promptFile: _promptFile, ...rest } = profile;
      return rest;
    });
    this.profiles = [...clean];
    // O embutido intocado não vai para disco: gravá-lo congelaria hoje o padrão
    // que a próxima versão da extensão deveria poder melhorar.
    const persisted = clean.filter((item) => item.scope !== 'builtin');

    const projectFile = this.projectFile;
    const shared =
      projectFile === null ? [] : persisted.filter((item) => item.scope === 'project');
    const local = persisted.filter((item) => shared.every((entry) => entry.id !== item.id));

    await vscode.workspace.fs.createDirectory(this.root);
    await this.writeJson(
      this.file,
      local.map(({ scope: _scope, ...rest }) => rest),
    );

    if (projectFile !== null && shared.length > 0) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectFile, '..'));
      // O agente compartilhado vai sem a conta: ela é desta máquina, e
      // versioná-la mandaria o colega para um login que não é dele.
      await this.writeJson(
        projectFile,
        shared.map(({ providerProfileId: _account, scope: _scope, ...rest }) => rest),
      );
      await this.writeJson(
        this.bindingsFile,
        Object.fromEntries(shared.map((item) => [item.id, item.providerProfileId])),
      );
    }

    this.logger.info(
      `Agent Profiles gravados (${String(local.length)} nesta máquina, ${String(shared.length)} no projeto).`,
    );
  }

  /** Vínculos conta↔agente dos agentes que vieram do projeto. */
  get bindingsFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'agent-bindings.json');
  }

  private async writeJson(target: vscode.Uri, value: unknown): Promise<void> {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  }

  /** Conta escolhida nesta máquina para cada agente do projeto. */
  private async readBindings(): Promise<Map<string, string>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.bindingsFile);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(parsed)) {
        return new Map();
      }
      return new Map(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } catch {
      return new Map();
    }
  }
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

/** Lista de ferramentas: strings curtas, sem vazio e sem repetição. */
function toolList(value: unknown): readonly string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_TOOLS_PER_LIST) {
    return null;
  }
  const tools: string[] = [];
  for (const entry of value) {
    const tool = text(entry, MAX_TOOL_NAME_LENGTH);
    if (tool === null) {
      return null;
    }
    if (!tools.includes(tool)) {
      tools.push(tool);
    }
  }
  return tools;
}

/**
 * Validação de runtime do arquivo em disco: ele pode ter sido editado à mão, e
 * um agente malformado não pode virar execução com a conta errada. Nada é
 * normalizado em silêncio — a entrada inteira é descartada.
 */
export function normalizeAgentProfile(value: unknown): AgentProfile | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = text(value['id'], 128);
  const name = text(value['name'], MAX_PROFILE_NAME_LENGTH);
  // Vazio é válido: o agente que vem do projeto não traz conta, porque ela é de
  // cada máquina. Ele aparece na interface pedindo uma — que é o primeiro passo
  // de quem acabou de clonar o repositório.
  const providerProfileId = text(value['providerProfileId'], 128) ?? '';
  const role = oneOf<AgentRole>(value['role'], AGENT_ROLES);
  const autonomyMode = oneOf<AgentAutonomyMode>(value['autonomyMode'], AGENT_AUTONOMY_MODES);
  const contextStrategy = oneOf<ContextStrategy>(value['contextStrategy'], CONTEXT_STRATEGIES);
  const allowedTools = toolList(value['allowedTools']);
  const deniedTools = toolList(value['deniedTools']);
  // Perfil gravado antes das skills existirem é válido: a lista nasce vazia.
  const skills = toolList(value['skills']);
  const maxConcurrentSessions = value['maxConcurrentSessions'];

  if (
    id === null ||
    name === null ||
    role === null ||
    autonomyMode === null ||
    contextStrategy === null ||
    allowedTools === null ||
    deniedTools === null ||
    skills === null ||
    typeof value['enabled'] !== 'boolean' ||
    typeof maxConcurrentSessions !== 'number' ||
    !Number.isInteger(maxConcurrentSessions) ||
    maxConcurrentSessions < 1 ||
    maxConcurrentSessions > MAX_CONCURRENT_SESSIONS
  ) {
    return null;
  }

  // Opcionais: ausentes tudo bem, presentes precisam ser utilizáveis.
  const model = value['model'] === undefined ? undefined : text(value['model'], MAX_MODEL_LENGTH);
  const systemPrompt =
    value['systemPrompt'] === undefined
      ? undefined
      : text(value['systemPrompt'], MAX_SYSTEM_PROMPT_LENGTH);
  const customRoleId =
    value['customRoleId'] === undefined ? undefined : text(value['customRoleId'], 96);
  const effort =
    value['effort'] === undefined ? undefined : oneOf<EffortLevel>(value['effort'], EFFORT_LEVELS);
  if (model === null || systemPrompt === null || customRoleId === null || effort === null) {
    return null;
  }

  return {
    id,
    name,
    providerProfileId,
    role,
    // O vínculo só sobrevive junto do papel `custom`; em qualquer outro ele
    // seria um ponteiro invisível que ninguém consegue ver nem corrigir.
    ...(customRoleId === undefined || role !== 'custom' ? {} : { customRoleId }),
    ...(model === undefined ? {} : { model }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(effort === undefined ? {} : { effort }),
    autonomyMode,
    allowedTools,
    deniedTools,
    skills,
    maxConcurrentSessions,
    contextStrategy,
    enabled: value['enabled'],
  };
}

/** Dois agentes com o mesmo id tornariam o binding ambíguo: fica o primeiro. */
function dropDuplicateIds(profiles: readonly AgentProfile[]): AgentProfile[] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    if (seen.has(profile.id)) {
      return false;
    }
    seen.add(profile.id);
    return true;
  });
}

/**
 * Esqueleto do prompt de um agente — o mesmo formato do prompt de função:
 * limites duros e critério de parada, que é o que separa manual de desejo.
 */
function agentPromptTemplate(profile: AgentProfile): string {
  return `---
agent: ${profile.id}
name: ${profile.name}
---

# Missão
${profile.name}: o que este agente entrega, em uma frase.

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
