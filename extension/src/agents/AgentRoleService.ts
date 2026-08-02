import {
  AGENT_ROLES,
  MAX_CUSTOM_ROLES,
  MAX_ROLE_DESCRIPTION_LENGTH,
  MAX_ROLE_LABEL_LENGTH,
  MAX_SKILLS_PER_ROLE,
  type AgentRoleScope,
  type CustomAgentRole,
  type CustomAgentRoleDraft,
} from '../core/types';
import type { HubClient } from '../hub/types';
import type { Logger } from '../logger';
import { PrometheonError } from '../utils/errors';
import { roleId, type AgentRoleStore } from './AgentRoleStore';

export class CustomRoleNotFoundError extends PrometheonError {
  constructor(id: string) {
    super(`Custom role not found: ${id}`, 'agent-role.not-found');
  }
}

export class InvalidCustomRoleError extends PrometheonError {
  constructor(message: string) {
    super(message, 'agent-role.invalid');
  }
}

/** Papel de projeto pedido sem pasta aberta — não há onde gravá-lo. */
export class NoProjectForRoleError extends PrometheonError {
  constructor() {
    super(
      'Open a folder before saving a project role. Without a workspace there is no .prometheon/ to share it through.',
      'agent-role.no-project',
    );
  }
}

/** O escopo `hub` só é editável quando há Hub conectado e autenticado. */
export class HubRoleUnavailableError extends PrometheonError {
  constructor() {
    super(
      'Connect the Hub before saving a team role. Until then, save it in the project or on this machine.',
      'agent-role.hub-unavailable',
    );
  }
}

/**
 * Papéis nomeados: os que a equipe cria além dos sete embutidos.
 *
 * Junta três origens numa lista só. Quando o mesmo id aparece em mais de uma,
 * vence a mais compartilhada — projeto, depois Hub, depois máquina —, porque é
 * a que o time enxerga. O escopo perdedor **não** é apagado: continua no seu
 * arquivo, e a interface mostra de onde veio o que está valendo.
 */
export class AgentRoleService {
  /** Última leitura do Hub. Só é atualizada por `refreshFromHub`. */
  private hubRoles: readonly CustomAgentRole[] = [];

  constructor(
    private readonly store: AgentRoleStore,
    private readonly hub: HubClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Arquivo de prompt de uma função de projeto ou máquina, criado do template
   * quando falta. Funções de equipe ficam de fora: a fonte delas é o Hub, e um
   * arquivo local fingindo ser a fonte mentiria para o time inteiro.
   */
  async ensurePromptFile(role: CustomAgentRole): Promise<import('vscode').Uri> {
    if (role.scope === 'hub') {
      throw new PrometheonError(
        'Team role prompts sync through the Hub; the file editor arrives in a next phase.',
        'roles.hub-prompt-unsupported',
      );
    }
    return this.store.ensurePromptFile(role.scope, role);
  }

  async list(): Promise<readonly CustomAgentRole[]> {
    const [project, machine] = await Promise.all([
      this.store.readProject(),
      this.store.readMachine(),
    ]);
    return mergeByPrecedence([project, this.hubRoles, machine]);
  }

  async find(id: string): Promise<CustomAgentRole | undefined> {
    return (await this.list()).find((role) => role.id === id);
  }

  async require(id: string): Promise<CustomAgentRole> {
    const role = await this.find(id);
    if (role === undefined) {
      throw new CustomRoleNotFoundError(id);
    }
    return role;
  }

  async create(draft: CustomAgentRoleDraft): Promise<CustomAgentRole> {
    const validated = this.validate(draft);
    const taken = new Set((await this.list()).map((role) => role.id));
    const role: CustomAgentRole = { id: uniqueId(validated.label, taken), ...validated };
    await this.save(role, null);
    this.logger.info(`Papel ${role.id} criado no escopo ${role.scope}.`);
    return role;
  }

  async update(id: string, draft: CustomAgentRoleDraft): Promise<CustomAgentRole> {
    const current = await this.require(id);
    const validated = this.validate(draft);
    const role: CustomAgentRole = { id, ...validated };
    // Mudar o escopo é mover: sem remover da origem, o papel antigo continuaria
    // valendo pela precedência e a edição pareceria não ter surtido efeito.
    await this.save(role, current.scope === role.scope ? null : current.scope);
    this.logger.info(`Papel ${id} atualizado no escopo ${role.scope}.`);
    return role;
  }

  async remove(id: string): Promise<CustomAgentRole> {
    const role = await this.require(id);
    await this.removeFrom(role.scope, id);
    this.logger.info(`Papel ${id} removido do escopo ${role.scope}.`);
    return role;
  }

  /**
   * Relê os papéis da organização. Falha de rede não derruba a lista: o que já
   * estava em memória continua valendo, e o erro fica no log.
   */
  async refreshFromHub(): Promise<void> {
    if (!this.hub.isAuthenticated()) {
      this.hubRoles = [];
      return;
    }
    try {
      this.hubRoles = await this.hub.listAgentRoles();
    } catch (error) {
      this.logger.warn(`Não foi possível ler os papéis do Hub: ${String(error)}`);
    }
  }

  private async save(role: CustomAgentRole, removeFromScope: AgentRoleScope | null): Promise<void> {
    if (removeFromScope !== null) {
      await this.removeFrom(removeFromScope, role.id);
    }
    switch (role.scope) {
      case 'project': {
        const current = await this.store.readProject();
        await this.store.writeProject(replace(current, role));
        return;
      }
      case 'hub': {
        if (!this.hub.isAuthenticated()) {
          throw new HubRoleUnavailableError();
        }
        this.hubRoles = await this.hub.saveAgentRoles(replace(this.hubRoles, role));
        return;
      }
      case 'machine': {
        const current = await this.store.readMachine();
        await this.store.writeMachine(replace(current, role));
        return;
      }
    }
  }

  private async removeFrom(scope: AgentRoleScope, id: string): Promise<void> {
    switch (scope) {
      case 'project': {
        const current = await this.store.readProject();
        await this.store.writeProject(current.filter((role) => role.id !== id));
        return;
      }
      case 'hub': {
        if (!this.hub.isAuthenticated()) {
          throw new HubRoleUnavailableError();
        }
        this.hubRoles = await this.hub.saveAgentRoles(this.hubRoles.filter((role) => role.id !== id));
        return;
      }
      case 'machine': {
        const current = await this.store.readMachine();
        await this.store.writeMachine(current.filter((role) => role.id !== id));
        return;
      }
    }
  }

  /**
   * Confere o que a fronteira da webview não garante: rótulo e descrição
   * presentes, papel-base conhecido, e escopo com destino real.
   */
  private validate(draft: CustomAgentRoleDraft): Omit<CustomAgentRole, 'id'> {
    const label = draft.label.trim();
    const description = draft.description.trim();
    if (label === '' || label.length > MAX_ROLE_LABEL_LENGTH) {
      throw new InvalidCustomRoleError('Give the role a name.');
    }
    if (description === '' || description.length > MAX_ROLE_DESCRIPTION_LENGTH) {
      throw new InvalidCustomRoleError('Describe in one line what this role does.');
    }
    if (!AGENT_ROLES.includes(draft.basedOn) || draft.basedOn === 'custom') {
      throw new InvalidCustomRoleError('Pick which built-in role this one is based on.');
    }
    if (draft.skills.length > MAX_SKILLS_PER_ROLE) {
      throw new InvalidCustomRoleError(`A role carries at most ${MAX_SKILLS_PER_ROLE} skills.`);
    }
    if (draft.scope === 'project' && this.store.projectFile === null) {
      throw new NoProjectForRoleError();
    }
    if (draft.scope === 'hub' && !this.hub.isAuthenticated()) {
      throw new HubRoleUnavailableError();
    }

    const systemPrompt = draft.systemPrompt?.trim();
    return {
      label,
      description,
      basedOn: draft.basedOn,
      skills: unique(draft.skills),
      ...(systemPrompt === undefined || systemPrompt === '' ? {} : { systemPrompt }),
      scope: draft.scope,
    };
  }
}

/** Primeira ocorrência vence: as listas chegam da mais compartilhada à menos. */
export function mergeByPrecedence(
  sources: readonly (readonly CustomAgentRole[])[],
): readonly CustomAgentRole[] {
  const merged: CustomAgentRole[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const role of source) {
      if (!seen.has(role.id)) {
        seen.add(role.id);
        merged.push(role);
      }
    }
  }
  return merged.slice(0, MAX_CUSTOM_ROLES).sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

function replace(
  roles: readonly CustomAgentRole[],
  role: CustomAgentRole,
): readonly CustomAgentRole[] {
  const index = roles.findIndex((candidate) => candidate.id === role.id);
  if (index === -1) {
    return [...roles, role];
  }
  const next = [...roles];
  next[index] = role;
  return next;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/** Identificador estável derivado do rótulo, sem colidir com um já existente. */
function uniqueId(label: string, taken: ReadonlySet<string>): string {
  const base = roleId(label) === '' ? 'role' : roleId(label);
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
