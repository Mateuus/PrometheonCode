// Papéis padrão e permissões granulares do `Docs/09`.
//
// PROVISÓRIO: `packages/permissions` é o lugar definitivo desta lista — ele
// ainda não existe. Enquanto isso o seed precisa da definição para popular
// `roles` e `role_permissions`, então ela mora aqui, isolada em um arquivo só,
// para ser movida sem arrastar nada junto.
//
// A distribuição por papel é decisão nossa: o documento lista os seis papéis e
// as quinze permissões, mas não diz quem recebe o quê. O critério usado:
//
// - `owner` é o único que pode mexer na organização inteira;
// - `admin` administra tudo dentro dela, menos a própria organização;
// - `maintainer` manda no trabalho técnico, mas não em pessoas;
// - `developer` executa;
// - `reviewer` lê, comenta e decide sobre conhecimento;
// - `viewer` só observa.

/** Permissões granulares, exatamente como no `Docs/09`. */
export const PERMISSIONS = [
  'organization.manage',
  'members.invite',
  'project.create',
  'project.configure',
  'chat.read',
  'chat.write',
  'task.create',
  'task.assign',
  'agent.observe',
  'agent.message',
  'agent.start_remote',
  'knowledge.propose',
  'knowledge.review',
  'knowledge.approve',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface SystemRoleDefinition {
  slug: string;
  name: string;
  description: string;
  /** Maior vence em comparação de privilégio. */
  priority: number;
  /** Papel dado a quem entra na organização sem papel explícito. */
  isDefault: boolean;
  permissions: readonly Permission[];
}

const VIEWER: readonly Permission[] = ['chat.read', 'agent.observe'];

const REVIEWER: readonly Permission[] = [
  ...VIEWER,
  'chat.write',
  'knowledge.propose',
  'knowledge.review',
];

const DEVELOPER: readonly Permission[] = [
  ...VIEWER,
  'chat.write',
  'task.create',
  'agent.message',
  'agent.start_remote',
  'knowledge.propose',
];

const MAINTAINER: readonly Permission[] = [
  ...DEVELOPER,
  'project.create',
  'project.configure',
  'task.assign',
  'knowledge.review',
  'knowledge.approve',
];

const ADMIN: readonly Permission[] = [...MAINTAINER, 'members.invite', 'audit.read'];

const OWNER: readonly Permission[] = [...ADMIN, 'organization.manage'];

/** Os seis papéis padrão do `Docs/09`, do mais privilegiado ao menos. */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    slug: 'owner',
    name: 'Owner',
    description: 'Dono da organização: administra plano, cobrança, posse e exclusão.',
    priority: 60,
    isDefault: false,
    permissions: OWNER,
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Administra membros, projetos e auditoria, mas não a organização em si.',
    priority: 50,
    isDefault: false,
    permissions: ADMIN,
  },
  {
    slug: 'maintainer',
    name: 'Maintainer',
    description: 'Responsável técnico: cria e configura projetos, distribui tarefas e aprova conhecimento.',
    priority: 40,
    isDefault: false,
    permissions: MAINTAINER,
  },
  {
    slug: 'developer',
    name: 'Developer',
    description: 'Trabalha nas tarefas, conversa com os agentes e propõe conhecimento.',
    priority: 30,
    isDefault: true,
    permissions: DEVELOPER,
  },
  {
    slug: 'reviewer',
    name: 'Reviewer',
    description: 'Revisa trabalho e conhecimento proposto, sem executar agentes remotos.',
    priority: 20,
    isDefault: false,
    permissions: REVIEWER,
  },
  {
    slug: 'viewer',
    name: 'Viewer',
    description: 'Somente leitura: acompanha conversas e execuções.',
    priority: 10,
    isDefault: false,
    permissions: VIEWER,
  },
];

/** Papéis indexados pelo slug, para consulta direta. */
export const SYSTEM_ROLE_BY_SLUG = new Map(SYSTEM_ROLES.map((role) => [role.slug, role]));
