import {
  MAX_CONCURRENT_SESSIONS,
  type AccountSummary,
  type AgentProfile,
  type AgentProfileSummary,
  type CustomAgentRole,
  type EffortLevel,
} from '../core/types';
import type { Logger } from '../logger';
import type { ProviderProfileService } from '../providers/ProviderProfileService';
import { PrometheonError } from '../utils/errors';
import type { AgentProfileStore } from './AgentProfileStore';

/** Agente criado ou editado sem apontar para nenhuma conta. */
export class AgentProfileBindingRequiredError extends PrometheonError {
  constructor(agentName: string) {
    super(
      `The agent profile "${agentName}" needs a provider profile. Pick the account it must use and try again.`,
      'agent-profile.binding-required',
    );
  }
}

/** O binding aponta para um Provider Profile que não existe mais. */
export class AgentProfileBindingUnknownError extends PrometheonError {
  constructor(agentName: string, providerProfileId: string) {
    super(
      `The agent profile "${agentName}" points to the provider profile "${providerProfileId}", which does not exist. Bind it to an existing account — Prometheon never falls back to another one.`,
      'agent-profile.binding-unknown',
    );
  }
}

export class AgentProfileNotFoundError extends PrometheonError {
  constructor(id: string) {
    super(`Agent profile not found: ${id}`, 'agent-profile.not-found');
  }
}

export class InvalidAgentProfileError extends PrometheonError {
  constructor(message: string) {
    super(message, 'agent-profile.invalid');
  }
}

/** O que a interface envia para criar ou editar um agente. */
export interface AgentProfileInput {
  readonly name: string;
  readonly providerProfileId: string;
  readonly role: AgentProfile['role'];
  readonly customRoleId?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly effort?: EffortLevel;
  readonly autonomyMode: AgentProfile['autonomyMode'];
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly skills: readonly string[];
  readonly maxConcurrentSessions: number;
  readonly contextStrategy: AgentProfile['contextStrategy'];
  readonly enabled: boolean;
  /** Onde guardar: `.prometheon/agents/` do projeto, ou só esta máquina. */
  readonly scope?: AgentProfile['scope'];
}

/**
 * CRUD dos Agent Profiles. A regra que este serviço existe para garantir é a do
 * documento (§4.9, §15): um agente só existe vinculado a um Provider Profile, e
 * um binding quebrado nunca é resolvido caindo em outra conta.
 */
export class AgentProfileService {
  constructor(
    private readonly store: AgentProfileStore,
    private readonly providers: ProviderProfileService,
    private readonly logger: Logger,
  ) {}

  list(): Promise<readonly AgentProfile[]> {
    return this.store.list();
  }

  async require(id: string): Promise<AgentProfile> {
    const profile = await this.store.find(id);
    if (profile === undefined) {
      throw new AgentProfileNotFoundError(id);
    }
    return profile;
  }

  /** Arquivo de prompt do agente, criado do template quando falta. */
  async ensurePromptFile(id: string): Promise<import('vscode').Uri> {
    const profile = await this.require(id);
    return this.store.ensurePromptFile(profile);
  }

  async create(input: AgentProfileInput): Promise<AgentProfile> {
    const validated = await this.validate(input);
    const id = await this.uniqueId(validated.name);
    const profile: AgentProfile = {
      id,
      ...validated,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    };
    await this.store.save(profile);
    this.logger.info(`Agent Profile ${id} criado (provider ${profile.providerProfileId}).`);
    return profile;
  }

  async update(id: string, input: AgentProfileInput): Promise<AgentProfile> {
    const current = await this.require(id);
    const validated = await this.validate(input);
    // Sem escopo no pedido, o agente fica onde estava: uma edição de nome não
    // pode mudar de lugar o que a equipe já compartilhou.
    const scope = input.scope ?? current.scope;
    const profile: AgentProfile = { id, ...validated, ...(scope === undefined ? {} : { scope }) };
    await this.store.save(profile);
    this.logger.info(`Agent Profile ${id} atualizado.`);
    return profile;
  }

  /**
   * Aponta um agente para uma conta, sem passar pela validação de edição.
   *
   * É o caminho de quem ainda não tem conta nenhuma: a equipe embutida na
   * primeira execução, e os agentes que vieram do repositório. Validar aqui
   * exigiria um formulário inteiro preenchido para trocar um campo que a
   * própria extensão sabe qual é.
   */
  async bind(id: string, providerProfileId: string): Promise<AgentProfile> {
    const current = await this.require(id);
    const profile: AgentProfile = { ...current, providerProfileId };
    await this.store.save(profile);
    return profile;
  }

  async setEnabled(id: string, enabled: boolean): Promise<AgentProfile> {
    const current = await this.require(id);
    const profile: AgentProfile = { ...current, enabled };
    await this.store.save(profile);
    return profile;
  }

  async remove(id: string): Promise<AgentProfile> {
    const profile = await this.require(id);
    await this.store.remove(id);
    this.logger.info(`Agent Profile ${id} removido.`);
    return profile;
  }

  /**
   * Resolve o binding de cada agente contra as contas e os papéis conhecidos.
   * Nada é corrigido automaticamente: um vínculo quebrado vira aviso na
   * interface, nunca uma troca silenciosa de conta ou de papel.
   */
  async summaries(
    accounts: readonly AccountSummary[],
    roles: readonly CustomAgentRole[] = [],
  ): Promise<readonly AgentProfileSummary[]> {
    return resolveAgentProfiles(await this.list(), accounts, roles);
  }

  /**
   * Confere o binding e os limites antes de gravar. A fronteira da webview já
   * valida o formato; aqui vale a regra de negócio, que também protege quem
   * chamar o serviço por outro caminho.
   */
  private async validate(input: AgentProfileInput): Promise<Omit<AgentProfile, 'id'>> {
    const name = input.name.trim();
    if (name === '') {
      throw new InvalidAgentProfileError('Give the agent profile a name.');
    }
    if (input.providerProfileId.trim() === '') {
      throw new AgentProfileBindingRequiredError(name);
    }
    if (
      !Number.isInteger(input.maxConcurrentSessions) ||
      input.maxConcurrentSessions < 1 ||
      input.maxConcurrentSessions > MAX_CONCURRENT_SESSIONS
    ) {
      throw new InvalidAgentProfileError(
        `Max concurrent sessions must be between 1 and ${MAX_CONCURRENT_SESSIONS}.`,
      );
    }

    const bound = (await this.providers.list()).find(
      (profile) => profile.id === input.providerProfileId,
    );
    if (bound === undefined) {
      throw new AgentProfileBindingUnknownError(name, input.providerProfileId);
    }

    const model = input.model?.trim();
    const systemPrompt = input.systemPrompt?.trim();
    const customRoleId = input.role === 'custom' ? input.customRoleId?.trim() : undefined;
    return {
      name,
      providerProfileId: bound.id,
      role: input.role,
      // Só faz sentido junto de `role: 'custom'`; guardá-lo em outro papel
      // deixaria um vínculo invisível esperando para confundir depois.
      ...(customRoleId === undefined || customRoleId === '' ? {} : { customRoleId }),
      ...(model === undefined || model === '' ? {} : { model }),
      ...(systemPrompt === undefined || systemPrompt === '' ? {} : { systemPrompt }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      autonomyMode: input.autonomyMode,
      allowedTools: uniqueTools(input.allowedTools),
      deniedTools: uniqueTools(input.deniedTools),
      skills: uniqueTools(input.skills),
      maxConcurrentSessions: input.maxConcurrentSessions,
      contextStrategy: input.contextStrategy,
      enabled: input.enabled,
    };
  }

  /** Identificador estável derivado do nome, sem colidir com um já existente. */
  private async uniqueId(name: string): Promise<string> {
    const base = slug(name) === '' ? 'agent' : slug(name);
    const taken = new Set((await this.list()).map((profile) => profile.id));
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
}

/**
 * Função pura: junta agente e conta para a interface mostrar
 * `Agent → Provider → Account`. Exportada para poder ser testada sem disco.
 */
export function resolveAgentProfiles(
  profiles: readonly AgentProfile[],
  accounts: readonly AccountSummary[],
  roles: readonly CustomAgentRole[] = [],
): readonly AgentProfileSummary[] {
  return profiles.map((profile) => {
    const customRole =
      profile.customRoleId === undefined
        ? null
        : (roles.find((role) => role.id === profile.customRoleId) ?? null);
    const account = accounts.find((item) => item.profileId === profile.providerProfileId);
    if (account === undefined) {
      return {
        profile,
        providerName: null,
        accountName: null,
        accountAuthenticated: false,
        customRole,
        warning: `No account matches "${profile.providerProfileId}". Bind this agent to an existing account — Prometheon never picks another one for you.`,
      };
    }
    const authenticated = account.authenticated;
    // O papel perdido é avisado antes da conta desconectada: sem papel o agente
    // não sabe o que é, e entrar em sessão assim é o pior dos dois casos.
    const warning =
      profile.customRoleId !== undefined && customRole === null
        ? `The role "${profile.customRoleId}" does not exist here. Pick another one — Prometheon never falls back to a different role.`
        : authenticated
          ? undefined
          : `"${account.name}" is not signed in. Sign in to that account before running this agent.`;
    return {
      profile,
      providerName: account.providerName,
      accountName: account.name,
      accountAuthenticated: authenticated,
      customRole,
      ...(warning === undefined ? {} : { warning }),
    };
  });
}

/** Ferramenta repetida não muda a política; mantém a ordem da primeira. */
function uniqueTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool)) {
      return false;
    }
    seen.add(tool);
    return true;
  });
}

/** Vira identificador: só minúsculas, dígitos e hífen. */
function slug(value: string): string {
  // NFD separa o acento da letra; o passo seguinte descarta tudo que não for
  // ASCII, então "Revisão" vira "revisao" e não "reviso".
  return value
    .normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
