// Schema completo do Hub, organizado pelos grupos do `Docs/07`.
//
// ## Por que `EntitySchema` e não decorators
//
// O TypeORM aceita duas formas de declarar entidade: classes com decorators
// (`@Entity`, `@Column`) ou `EntitySchema`, um objeto puro. Aqui é `EntitySchema`,
// por três motivos concretos deste monorepo:
//
// 1. **Decorators exigiriam mexer no compilador de todo mundo.** Os decorators do
//    TypeORM são os legados (`experimentalDecorators` + `emitDecoratorMetadata`),
//    e o `tsconfig.base.json` é herdado por extensão, API, worker e web. Ligar as
//    duas opções na base para atender um pacote muda a semântica de decorator de
//    todos os outros — e `emitDecoratorMetadata` faz o compilador emitir
//    `design:type` para cada propriedade decorada, o que ressuscita o import do
//    tipo em runtime e briga com `verbatimModuleSyntax`.
// 2. **`reflect-metadata` é estado global com ordem de import.** Ele precisa ser
//    importado antes de qualquer entidade, em todo processo — API, worker,
//    scripts, testes. É o tipo de exigência que funciona até o dia em que alguém
//    importa uma entidade de um lugar novo.
// 3. **Mapeamento explícito combina com o resto do projeto.** Cada coluna declara
//    nome físico, tipo, tamanho, nulabilidade e default; nada é inferido do tipo
//    do TypeScript. Como o banco já existe e as entidades precisam refletir o que
//    está lá, o mapeamento explícito é o que se pode conferir linha a linha
//    contra o `information_schema`.
//
// O preço é declarar a interface da linha junto do schema (`User` + `users`), o
// que também é o que dá o tipo de retorno das consultas. Foi julgado barato.
//
// A ordem dos reexports segue a dependência entre os módulos: identidade não
// conhece ninguém, organização conhece identidade, e assim por diante.

import {
  deviceTokens,
  devices,
  refreshTokens,
  userIdentities,
  userSessions,
  users,
} from './identity.js';
import {
  invitations,
  organizationMembers,
  organizations,
  plans,
  rolePermissions,
  roles,
} from './organization.js';
import {
  gitConnections,
  gitRepositories,
  mcpRegistryEntries,
  webhookDeliveries,
} from './integrations.js';
import {
  agentProfiles,
  agentRoleDefinitions,
  projectAgentProfiles,
  projectMembers,
  projectRepositories,
  projectSettings,
  projects,
} from './project.js';
import {
  conversationParticipants,
  conversationSummaries,
  conversations,
  messageAttachments,
  messageContextRefs,
  messageParts,
  messages,
} from './chat.js';
import {
  agentRunEvents,
  agentRuns,
  approvals,
  artifacts,
  reviews,
  taskAssignments,
  taskDependencies,
  tasks,
} from './orchestration.js';
import {
  knowledgeItems,
  knowledgeRelations,
  knowledgeReviews,
  knowledgeSources,
  knowledgeVersions,
  syncCheckpoints,
} from './knowledge.js';
import {
  auditLogs,
  dataExportJobs,
  deletionJobs,
  securityEvents,
} from './governance.js';
import { outboxMessages } from './outbox.js';

export * from './columns.js';
export * from './identity.js';
export * from './organization.js';
export * from './integrations.js';
export * from './project.js';
export * from './chat.js';
export * from './orchestration.js';
export * from './knowledge.js';
export * from './governance.js';
export * from './outbox.js';

/**
 * Todas as entidades, na ordem em que o `DataSource` as registra.
 *
 * Uma tabela ausente daqui simplesmente não existe para o TypeORM: consultas
 * contra ela falham com "entity metadata not found". Por isso a lista é
 * exaustiva e conferida pelo teste de equivalência de schema.
 */
export const ENTITIES = [
  // identidade
  users,
  userIdentities,
  devices,
  deviceTokens,
  userSessions,
  refreshTokens,
  // organização
  plans,
  organizations,
  roles,
  rolePermissions,
  organizationMembers,
  invitations,
  // integrações
  gitConnections,
  gitRepositories,
  webhookDeliveries,
  mcpRegistryEntries,
  // projeto
  projects,
  projectMembers,
  projectRepositories,
  projectSettings,
  agentProfiles,
  agentRoleDefinitions,
  projectAgentProfiles,
  // chat
  conversations,
  conversationParticipants,
  messages,
  messageParts,
  messageAttachments,
  messageContextRefs,
  conversationSummaries,
  // orquestração
  tasks,
  taskDependencies,
  taskAssignments,
  agentRuns,
  agentRunEvents,
  approvals,
  reviews,
  artifacts,
  // conhecimento
  knowledgeItems,
  knowledgeVersions,
  knowledgeSources,
  knowledgeRelations,
  knowledgeReviews,
  syncCheckpoints,
  // governança
  auditLogs,
  securityEvents,
  dataExportJobs,
  deletionJobs,
  // outbox
  outboxMessages,
] as const;
