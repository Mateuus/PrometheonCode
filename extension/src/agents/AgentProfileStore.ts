import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  AGENT_AUTONOMY_MODES,
  AGENT_ROLES,
  CONTEXT_STRATEGIES,
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
} from '../core/types';
import type { Logger } from '../logger';

/**
 * Agent Profiles ficam em `~/.prometheon/agent-profiles.json`, ao lado de
 * `local-profiles.json` e no mesmo padrão do `ProviderProfileStore`: metadados
 * de configuração, nunca credenciais.
 *
 * O documento (§16) prevê uma fase posterior em que o time compartilha os
 * agentes por `.prometheon/agents.yaml`, deixando só o vínculo com a conta
 * local em cada máquina. Isso **não** está implementado aqui: enquanto o
 * arquivo do projeto não existir, o agente e o seu binding vivem juntos nesta
 * máquina.
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

  async list(): Promise<readonly AgentProfile[]> {
    if (this.profiles === null) {
      this.profiles = await this.read();
    }
    return this.profiles;
  }

  async find(id: string): Promise<AgentProfile | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  async save(profile: AgentProfile): Promise<void> {
    const profiles = [...(await this.list())];
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index === -1) {
      profiles.push(profile);
    } else {
      profiles[index] = profile;
    }
    await this.write(profiles);
  }

  async remove(id: string): Promise<void> {
    const profiles = (await this.list()).filter((profile) => profile.id !== id);
    await this.write(profiles);
  }

  private async read(): Promise<AgentProfile[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file);
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
    this.profiles = [...profiles];
    await vscode.workspace.fs.createDirectory(this.root);
    const content = `${JSON.stringify(profiles, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(content));
    this.logger.info(`Agent Profiles gravados (${profiles.length}).`);
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
  const providerProfileId = text(value['providerProfileId'], 128);
  const role = oneOf<AgentRole>(value['role'], AGENT_ROLES);
  const autonomyMode = oneOf<AgentAutonomyMode>(value['autonomyMode'], AGENT_AUTONOMY_MODES);
  const contextStrategy = oneOf<ContextStrategy>(value['contextStrategy'], CONTEXT_STRATEGIES);
  const allowedTools = toolList(value['allowedTools']);
  const deniedTools = toolList(value['deniedTools']);
  const maxConcurrentSessions = value['maxConcurrentSessions'];

  if (
    id === null ||
    name === null ||
    providerProfileId === null ||
    role === null ||
    autonomyMode === null ||
    contextStrategy === null ||
    allowedTools === null ||
    deniedTools === null ||
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
  if (model === null || systemPrompt === null) {
    return null;
  }

  return {
    id,
    name,
    providerProfileId,
    role,
    ...(model === undefined ? {} : { model }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    autonomyMode,
    allowedTools,
    deniedTools,
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
