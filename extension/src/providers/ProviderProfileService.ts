import type { Logger } from '../logger';
import { PrometheonError } from '../utils/errors';
import type { ProviderProfileStore } from './ProviderProfileStore';
import type {
  ProviderAdapter,
  ProviderId,
  ProviderProfile,
  ProviderProfileStatus,
} from './types';

export class UnknownProviderError extends PrometheonError {
  constructor(providerId: string) {
    super(`Unknown provider: ${providerId}`, 'provider.unknown');
  }
}

export class ProfileNotFoundError extends PrometheonError {
  constructor(profileId: string) {
    super(`Provider profile not found: ${profileId}`, 'provider.profile-not-found');
  }
}

/**
 * Gerencia contas locais dos CLIs. Cada perfil tem diretório próprio, e trocar
 * de conta é sempre explícito: não existe fallback automático de um perfil para
 * outro — se a conta escolhida não está autenticada, a operação falha dizendo
 * qual perfil precisa de login.
 */
export class ProviderProfileService {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  constructor(
    private readonly store: ProviderProfileStore,
    private readonly logger: Logger,
  ) {}

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  get providers(): readonly ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  adapterFor(providerId: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (adapter === undefined) {
      throw new UnknownProviderError(providerId);
    }
    return adapter;
  }

  list(): Promise<readonly ProviderProfile[]> {
    return this.store.list() as Promise<readonly ProviderProfile[]>;
  }

  async require(profileId: string): Promise<ProviderProfile> {
    const profile = await this.store.find(profileId);
    if (profile === undefined) {
      throw new ProfileNotFoundError(profileId);
    }
    return profile;
  }

  /** Cria o perfil e o diretório isolado. O login continua sendo um passo à parte. */
  async create(input: {
    name: string;
    providerId: ProviderId;
    model?: string | undefined;
  }): Promise<ProviderProfile> {
    const adapter = this.adapterFor(input.providerId);
    const id = await this.uniqueId(input.providerId, input.name);
    const now = Date.now();
    const profile: ProviderProfile = {
      id,
      name: input.name,
      providerId: input.providerId,
      configDirectory: this.store.directoryFor(input.providerId, id),
      // Vazio significa "o que o CLI já usa": guardar a string vazia faria o
      // adaptador passar `--model ` e o provedor recusar.
      ...(input.model === undefined || input.model === '' ? {} : { model: input.model }),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await adapter.createIsolatedEnvironment(profile);
    await this.store.save(profile);
    this.logger.info(`Perfil ${id} criado para ${adapter.displayName}.`);
    return profile;
  }

  /**
   * Remove o perfil da lista. O diretório com as credenciais é preservado — o
   * usuário decide apagá-lo, e nunca fazemos isso por conta própria.
   */
  async remove(profileId: string): Promise<ProviderProfile> {
    const profile = await this.require(profileId);
    await this.store.remove(profileId);
    this.logger.info(`Perfil ${profileId} removido da lista (diretório preservado).`);
    return profile;
  }

  async login(profileId: string): Promise<void> {
    const profile = await this.require(profileId);
    await this.adapterFor(profile.providerId).login(profile);
  }

  async logout(profileId: string): Promise<void> {
    const profile = await this.require(profileId);
    await this.adapterFor(profile.providerId).logout(profile);
  }

  /** Instalação e autenticação de um perfil, prontos para a interface. */
  async status(profile: ProviderProfile): Promise<ProviderProfileStatus> {
    const adapter = this.adapterFor(profile.providerId);
    const installation = await adapter.detectInstallation(profile);
    const auth = installation.installed
      ? await adapter.getAuthStatus(profile)
      : { authenticated: false, message: installation.detail ?? 'CLI not installed.' };
    return { profile, providerName: adapter.displayName, installation, auth };
  }

  async statuses(): Promise<readonly ProviderProfileStatus[]> {
    const profiles = await this.list();
    return Promise.all(profiles.map((profile) => this.status(profile)));
  }

  /** Identificador estável derivado do nome, sem colidir com um já existente. */
  private async uniqueId(providerId: ProviderId, name: string): Promise<string> {
    const base = slug(name) === '' ? providerId : slug(name);
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

/** Vira nome de diretório: só minúsculas, dígitos e hífen. */
function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
