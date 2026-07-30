/**
 * Autorização de projeto.
 *
 * `app.requirePermission()` resolve a camada da organização. Falta a camada de
 * baixo, que o `Docs/09` coloca logo em seguida na precedência:
 *
 * ```text
 * política da organização → política do projeto → permissão do usuário → …
 * ```
 *
 * Este guarda fecha essa lacuna e, junto com ela, responde à pergunta que a
 * camada de organização não responde: **quem é da organização não é
 * automaticamente do projeto**. `project_members` existe justamente para isso.
 *
 * A regra de acesso, por extenso:
 *
 * | Situação                                                   | Resultado |
 * | ---------------------------------------------------------- | --------- |
 * | membro ativo em `project_members`                           | passa     |
 * | não é membro, papel `owner`/`admin`, projeto `organization`  | passa     |
 * | não é membro, projeto `private`                              | negado    |
 * | não é membro, papel abaixo de `admin`                        | negado    |
 *
 * A exceção de `owner`/`admin` em projeto de visibilidade `organization` existe
 * para que quem responde pelo tenant não fique trancado para fora do próprio
 * tenant. Ela não vale em projeto `private` — lá, "privado" significa privado.
 *
 * Quando `project_members.role_id` está preenchido, ele vale como papel efetivo
 * dentro do projeto e a permissão é exigida **duas vezes**: sob o papel da
 * organização (em `requirePermission`) e sob o papel do projeto (aqui). Assim o
 * papel do projeto só consegue restringir, nunca ampliar — que é a regra de
 * precedência do `Docs/09`.
 */

import { authorize, isRole, type Permission, type Role } from '@prometheon/permissions';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { forbidden, unauthenticated } from '../../shared/errors.js';
import { toPolicyLayer } from '../../shared/policy.js';
import { projectAccessDenied, projectNotFound } from './errors.js';
import { ProjectRepository } from './repository.js';
import type { ProjectRow } from './types.js';

/** Como a rota diz qual projeto está em jogo. */
export type ProjectSource = 'project' | 'conversation' | 'task';

export interface ProjectGuardOptions {
  /** De onde sai o projeto: `:projectId`, `:conversationId` ou `:taskId`. */
  readonly from: ProjectSource;
  /** Recurso registrado na auditoria quando a autorização é negada. */
  readonly resourceType: string;
}

const PARAM_BY_SOURCE: Readonly<Record<ProjectSource, string>> = {
  project: 'projectId',
  conversation: 'conversationId',
  task: 'taskId',
};

async function resolveProject(
  repository: ProjectRepository,
  request: FastifyRequest,
  from: ProjectSource,
): Promise<ProjectRow | undefined> {
  const params = request.params as Record<string, string | undefined>;
  const id = params[PARAM_BY_SOURCE[from]];

  if (typeof id !== 'string' || id === '') {
    return undefined;
  }

  switch (from) {
    case 'project': {
      return repository.findById(id);
    }
    case 'conversation': {
      return repository.findByConversation(id);
    }
    case 'task': {
      return repository.findByTask(id);
    }
  }
}

/**
 * Monta o `preHandler` de uma rota de projeto.
 *
 * O guarda é criado uma vez, no registro da rota, e não a cada requisição: o
 * repositório e o `requirePermission` já ficam prontos.
 */
export function requireProjectPermission(
  app: FastifyInstance,
  permission: Permission,
  options: ProjectGuardOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const repository = new ProjectRepository(app.db);

  return async (request, reply) => {
    // Autentica antes de qualquer consulta: responder 404 a quem não se
    // identificou transformaria a rota num verificador de IDs.
    await app.authenticate(request, reply);

    const project = await resolveProject(repository, request, options.from);

    if (project === undefined) {
      throw projectNotFound();
    }

    // A partir daqui a camada da organização decide — inclusive negando quem
    // não é membro dela, antes de o projeto revelar qualquer coisa.
    await app.requirePermission(permission, {
      resolveOrganizationId: () => project.organizationId,
      resourceType: options.resourceType,
    })(request, reply);

    const auth = request.auth;
    const access = request.access;

    if (auth === undefined || access === undefined) {
      throw unauthenticated();
    }

    const [membership, settings] = await Promise.all([
      repository.findMember(project.id, auth.userId),
      repository.findSettings(project.id),
    ]);

    const origin = requestOrigin(request);
    const deny = async (reason: string, error: () => never): Promise<never> => {
      await recordAudit(app.db, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: `authz.${permission}`,
        resourceType: options.resourceType,
        resourceId: project.id,
        result: 'denied',
        reason,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
      });

      return error();
    };

    const isActiveMember = membership?.status === 'active';
    const isTenantAdministrator = access.role === 'owner' || access.role === 'admin';
    const viaOrganizationRole =
      !isActiveMember && isTenantAdministrator && project.visibility === 'organization';

    if (!isActiveMember && !viaOrganizationRole) {
      await deny('The actor is not a member of this project.', () => {
        throw projectAccessDenied();
      });
    }

    // Papel do projeto, quando houver. `role_id` nulo em `project_members`
    // significa "herda o papel da organização" — é o que a coluna documenta.
    const projectRoleSlug = membership?.roleSlug ?? null;
    const role: Role =
      projectRoleSlug !== null && isRole(projectRoleSlug) ? projectRoleSlug : access.role;

    const projectPolicy = toPolicyLayer(settings?.policy ?? null);
    const decision = authorize({
      permission,
      role,
      ...(projectPolicy === undefined ? {} : { projectPolicy }),
    });

    if (!decision.allowed) {
      await deny(decision.reason, () => {
        throw forbidden(decision.reason, 'PERMISSION_DENIED');
      });
    }

    request.projectAccess = {
      project,
      role,
      organizationRole: access.role,
      permission,
      viaOrganizationRole,
    };
  };
}

/** Contexto de projeto já resolvido; lançar aqui é bug de registro de rota. */
export function projectContext(request: FastifyRequest) {
  const context = request.projectAccess;

  if (context === undefined) {
    throw unauthenticated();
  }

  return context;
}

/**
 * Exige uma **segunda** permissão dentro de uma rota já autorizada.
 *
 * Existe porque nem toda rota tem uma permissão só. `PATCH /tasks/:taskId`
 * muda a tarefa com `task.create`, mas trocar o responsável é `task.assign` —
 * duas permissões diferentes que dependem do corpo da requisição, e o
 * `preHandler` é escolhido antes de o corpo ser lido.
 *
 * A avaliação repete as duas camadas de política, na ordem do `Docs/09`, para
 * que a permissão extra não escape do que a organização ou o projeto negam.
 */
export async function requireAlso(
  app: FastifyInstance,
  request: FastifyRequest,
  permission: Permission,
): Promise<void> {
  const context = projectContext(request);
  const repository = new ProjectRepository(app.db);

  const [organizationPolicyRaw, settings] = await Promise.all([
    repository.findOrganizationPolicy(context.project.organizationId),
    repository.findSettings(context.project.id),
  ]);

  const organizationPolicy = toPolicyLayer(organizationPolicyRaw);
  const projectPolicy = toPolicyLayer(settings?.policy ?? null);
  const decision = authorize({
    permission,
    role: context.role,
    ...(organizationPolicy === undefined ? {} : { organizationPolicy }),
    ...(projectPolicy === undefined ? {} : { projectPolicy }),
  });

  if (!decision.allowed) {
    const auth = request.auth;
    const origin = requestOrigin(request);

    await recordAudit(app.db, {
      organizationId: context.project.organizationId,
      projectId: context.project.id,
      actorType: auth?.kind === 'device' ? 'device' : 'user',
      actorId: auth?.userId ?? null,
      actorLabel: auth?.email ?? null,
      action: `authz.${permission}`,
      resourceType: 'task',
      resourceId: context.project.id,
      result: 'denied',
      reason: decision.reason,
      requestId: request.id,
      ip: origin.ip,
      userAgent: origin.userAgent,
    });

    throw forbidden(decision.reason, 'PERMISSION_DENIED');
  }
}
