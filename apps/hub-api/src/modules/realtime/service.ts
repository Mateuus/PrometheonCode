/**
 * Regras do tempo real: quem pode assinar o quê, e o que o cliente recebe ao
 * retomar.
 *
 * **Autorização vale tanto quanto no REST.** A inscrição passa por
 * `authorize()` de `@prometheon/permissions`, exatamente como uma rota HTTP —
 * `chat.read` é a permissão que todos os seis papéis têm, então exigi-la
 * equivale a "seja membro ativo" sem transformar a decisão num `if` solto. E a
 * conferência não acontece só no `subscribe`: o hub reavalia periodicamente, de
 * modo que **um token de realtime não sobrevive à perda de permissão**.
 *
 * Projeto privado exige associação explícita; projeto de visibilidade
 * `organization` basta ser membro. Projeto de outra organização nunca passa,
 * mesmo que o cliente tenha acesso às duas — a inscrição declara o par.
 */

import { authorize, isRole, type Permission } from '@prometheon/permissions';

import type { AppConfig } from '../../config/index.js';
import type { RedisClient } from '../../plugins/redis.js';
import { isSessionDenied } from '../auth/token-store.js';
import { type RealtimeRepository, type BacklogRecord } from './repository.js';
import { REALTIME_SETTINGS } from './settings.js';
import {
  ulidFloor,
  ulidTimestamp,
  type AuthorizedSubscription,
  type RealtimeEnvelope,
  type RealtimePrincipal,
} from './types.js';

/** Inscrição pedida pelo cliente, antes de qualquer verificação. */
export interface RequestedSubscription {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly eventTypes: readonly string[];
}

export interface DeniedSubscription {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly reason: string;
}

export interface SubscriptionDecision {
  readonly granted: AuthorizedSubscription[];
  readonly denied: DeniedSubscription[];
}

export interface ResumeResult {
  /** Eventos perdidos enquanto o cliente esteve fora, em ordem de cursor. */
  readonly events: RealtimeEnvelope[];
  /**
   * `true` quando a janela expirou: o cliente precisa recarregar por REST antes
   * de confiar no que vier a seguir.
   */
  readonly gap: boolean;
}

export interface RealtimeServiceOptions {
  readonly repository: RealtimeRepository;
  readonly redis: RedisClient;
  readonly config: AppConfig;
}

export class RealtimeService {
  readonly #repository: RealtimeRepository;
  readonly #redis: RedisClient;

  constructor(options: RealtimeServiceOptions) {
    this.#repository = options.repository;
    this.#redis = options.redis;
  }

  get repository(): RealtimeRepository {
    return this.#repository;
  }

  /**
   * A credencial ainda vale?
   *
   * Sessão revogada e dispositivo revogado precisam alcançar uma conexão já
   * estabelecida. A denylist no Redis é a checagem barata da sessão; se ela
   * estiver fora, a conexão continua — o mesmo compromisso que
   * `plugins/auth.ts` faz no REST, e pelo mesmo motivo: indisponibilidade do
   * Redis não pode virar desconexão em massa.
   */
  async principalStillValid(principal: RealtimePrincipal): Promise<boolean> {
    if (principal.sessionId !== null) {
      try {
        if (await isSessionDenied(this.#redis, principal.sessionId)) {
          return false;
        }
      } catch {
        // Denylist indisponível: mantém a conexão. A próxima volta tenta de novo.
      }
    }

    if (principal.kind === 'device' && principal.deviceId !== null) {
      return this.#repository.isDeviceUsable(principal.deviceId);
    }

    return true;
  }

  /** Confere cada inscrição pedida. Nunca lança por inscrição negada. */
  async authorizeSubscriptions(
    principal: RealtimePrincipal,
    requested: readonly RequestedSubscription[],
  ): Promise<SubscriptionDecision> {
    const granted: AuthorizedSubscription[] = [];
    const denied: DeniedSubscription[] = [];
    // Uma conexão costuma pedir vários projetos da mesma organização; resolver a
    // associação uma vez por organização evita repetir a consulta.
    const membershipCache = new Map<string, boolean>();
    const visibleCache = new Map<string, ReadonlySet<string>>();

    for (const subscription of requested) {
      const reason = await this.#denyReason(principal, subscription, membershipCache);

      if (reason !== null) {
        denied.push({
          organizationId: subscription.organizationId,
          projectId: subscription.projectId,
          reason,
        });
        continue;
      }

      if (subscription.projectId !== null) {
        granted.push({
          organizationId: subscription.organizationId,
          projectId: subscription.projectId,
          eventTypes: new Set(subscription.eventTypes),
        });
        continue;
      }

      let visible = visibleCache.get(subscription.organizationId);

      if (visible === undefined) {
        visible = new Set(
          await this.#repository.listAccessibleProjects(
            subscription.organizationId,
            principal.userId,
          ),
        );
        visibleCache.set(subscription.organizationId, visible);
      }

      granted.push({
        organizationId: subscription.organizationId,
        projectId: null,
        eventTypes: new Set(subscription.eventTypes),
        allowedProjectIds: visible,
      });
    }

    return { granted, denied };
  }

  async #denyReason(
    principal: RealtimePrincipal,
    subscription: RequestedSubscription,
    membershipCache: Map<string, boolean>,
  ): Promise<string | null> {
    const cached = membershipCache.get(subscription.organizationId);
    let allowedInOrganization: boolean;

    if (cached === undefined) {
      allowedInOrganization = await this.#canReadOrganization(
        principal.userId,
        subscription.organizationId,
      );
      membershipCache.set(subscription.organizationId, allowedInOrganization);
    } else {
      allowedInOrganization = cached;
    }

    if (!allowedInOrganization) {
      return 'You do not have access to this organization.';
    }

    if (subscription.projectId === null) {
      return null;
    }

    const project = await this.#repository.findProject(subscription.projectId);

    if (project?.organizationId !== subscription.organizationId) {
      // Mesma resposta para "não existe" e "é de outra organização": distinguir
      // as duas transformaria a inscrição num oráculo de existência de projeto.
      return 'You do not have access to this project.';
    }

    if (project.visibility === 'organization') {
      return null;
    }

    const isMember = await this.#repository.isProjectMember(
      subscription.projectId,
      principal.userId,
    );

    return isMember ? null : 'You do not have access to this project.';
  }

  async #canReadOrganization(userId: string, organizationId: string): Promise<boolean> {
    const membership = await this.#repository.findMembership(organizationId, userId);

    if (membership?.status !== 'active') {
      return false;
    }

    if (!isRole(membership.roleSlug)) {
      return false;
    }

    const policy = membership.policy;
    const decision = authorize({
      permission: 'chat.read',
      role: membership.roleSlug,
      ...toPolicyLayer(policy),
    });

    return decision.allowed;
  }

  /**
   * Reconstrói o que o cliente perdeu, ou admite que não dá.
   *
   * São duas perguntas, nesta ordem. **O cursor ainda está na janela?** — o
   * tempo vem embutido no próprio ULID, então isso se responde sem tocar no
   * banco, e um cursor malformado cai no mesmo caminho de um antigo demais.
   * **Cabe o que ele perdeu?** — despejar dez mil eventos numa reconexão é pior
   * para o cliente do que mandá-lo recarregar por REST.
   *
   * Nos dois casos a resposta honesta é `gap: true`. O erro que este método
   * existe para não cometer é o silêncio: entregar um pedaço e deixar o cliente
   * achar que está em dia.
   */
  async resume(
    subscriptions: readonly AuthorizedSubscription[],
    cursor: string | null,
  ): Promise<ResumeResult> {
    if (cursor === null || subscriptions.length === 0) {
      return { events: [], gap: false };
    }

    const organizationIds = [
      ...new Set(subscriptions.map((subscription) => subscription.organizationId)),
    ];
    const since = Date.now() - REALTIME_SETTINGS.resumeWindowMs;
    const cursorAt = ulidTimestamp(cursor);

    if (cursorAt === undefined || cursorAt < since) {
      return { events: [], gap: true };
    }

    const rows = await this.#repository.fetchBacklog({
      organizationIds,
      afterCursor: cursor,
      sinceId: ulidFloor(since),
      // Um a mais que o teto: se vier, a janela estourou por volume.
      limit: REALTIME_SETTINGS.resumeMaxEvents + 1,
    });

    if (rows.length > REALTIME_SETTINGS.resumeMaxEvents) {
      return { events: [], gap: true };
    }

    return { events: rows.map(toEnvelope), gap: false };
  }
}

/** Linha do outbox no mesmo envelope que o `hub-worker` publica. */
export function toEnvelope(record: BacklogRecord): RealtimeEnvelope {
  return {
    id: record.id,
    type: record.eventType,
    version: record.eventVersion,
    organizationId: record.organizationId,
    projectId: record.projectId,
    occurredAt: record.occurredAt.toISOString(),
    cursor: record.id,
    aggregate: {
      type: record.aggregateType,
      id: record.aggregateId,
      sequence: record.aggregateSequence,
    },
    data: record.payload,
  };
}

/**
 * Converte `organizations.policy` no formato de `authorize()`.
 *
 * Mesma leitura defensiva de `plugins/auth.ts`: a coluna é JSON livre, e
 * política malformada não pode virar permissão concedida por acidente.
 */
function toPolicyLayer(policy: Record<string, unknown> | null): {
  organizationPolicy?: { deny?: Permission[]; allow?: Permission[] };
} {
  if (policy === null || typeof policy !== 'object') {
    return {};
  }

  const deny = Array.isArray(policy['deny'])
    ? (policy['deny'] as unknown[]).filter((item): item is Permission => typeof item === 'string')
    : undefined;
  const allow = Array.isArray(policy['allow'])
    ? (policy['allow'] as unknown[]).filter((item): item is Permission => typeof item === 'string')
    : undefined;

  if (deny === undefined && allow === undefined) {
    return {};
  }

  return {
    organizationPolicy: {
      ...(deny === undefined ? {} : { deny }),
      ...(allow === undefined ? {} : { allow }),
    },
  };
}
