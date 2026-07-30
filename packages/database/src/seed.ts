// Seed de desenvolvimento.
//
// Cria o mínimo para o Hub subir com sentido: um plano gratuito, os seis papéis
// padrão com suas permissões e uma organização de exemplo com um usuário owner.
//
// É idempotente por construção: tudo é localizado por chave natural (`code`,
// `slug`, `email`) antes de escrever, e as permissões de cada papel convergem
// para a lista declarada — as que sobram são removidas, as que faltam entram.
// Rodar duas vezes não duplica nem acumula nada.
//
// A senha do owner NÃO é definida aqui. O hash Argon2id é responsabilidade da
// API; o seed só aceita um hash pronto em `SEED_OWNER_PASSWORD_HASH` para quem
// quiser entrar direto em desenvolvimento. Sem isso, a conta existe e a senha
// se define pelo fluxo de recuperação — nenhuma credencial conhecida vai parar
// no repositório.
//
// Uso: `pnpm --filter @prometheon/database db:seed`

import { and, eq, isNull, notInArray } from 'drizzle-orm';
import process from 'node:process';
import { resolve } from 'node:path';

import { createDatabase, type Database } from './client.js';
import type { CreatePoolOptions } from './client.js';
import { envValue } from './env.js';
import { newId } from './id.js';
import { SYSTEM_ROLES } from './permissions.js';
import {
  organizationMembers,
  organizations,
  plans,
  rolePermissions,
  roles,
  users,
} from './schema/index.js';

/** Plano gratuito de referência. Valores monetários em centavos. */
const FREE_PLAN = {
  code: 'free',
  name: 'Free',
  description: 'Plano gratuito para avaliação e uso individual.',
  priceCents: 0,
  currency: 'USD',
  billingPeriod: 'none',
  maxMembers: 3,
  maxProjects: 2,
  maxAgentRunsPerMonth: 200,
  maxStorageBytes: 1_073_741_824,
  retentionDays: 30,
  isDefault: true,
  isActive: true,
} as const;

const EXAMPLE_ORGANIZATION = {
  slug: 'prometheon-demo',
  name: 'Prometheon Demo',
} as const;

const DEFAULT_OWNER_EMAIL = 'owner@prometheon.local';

export interface SeedResult {
  planId: string;
  roleIds: Record<string, string>;
  organizationId: string;
  ownerUserId: string;
  /** O que foi criado agora; vazio na segunda execução. */
  created: string[];
}

/** Garante o plano gratuito. */
async function seedFreePlan(db: Database, created: string[]): Promise<string> {
  const existing = await db.select().from(plans).where(eq(plans.code, FREE_PLAN.code)).limit(1);
  const current = existing[0];
  if (current) {
    return current.id;
  }
  const id = newId();
  await db.insert(plans).values({ id, ...FREE_PLAN });
  created.push(`plano ${FREE_PLAN.code}`);
  return id;
}

/**
 * Garante os seis papéis do sistema (`organization_id` nulo) e faz as
 * permissões convergirem para a lista do `Docs/09`.
 */
async function seedSystemRoles(db: Database, created: string[]): Promise<Record<string, string>> {
  const existing = await db.select().from(roles).where(isNull(roles.organizationId));
  const bySlug = new Map(existing.map((role) => [role.slug, role]));
  const roleIds: Record<string, string> = {};

  for (const definition of SYSTEM_ROLES) {
    let roleId = bySlug.get(definition.slug)?.id;
    if (!roleId) {
      roleId = newId();
      await db.insert(roles).values({
        id: roleId,
        organizationId: null,
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        isSystem: true,
        priority: definition.priority,
        isDefault: definition.isDefault,
      });
      created.push(`papel ${definition.slug}`);
    }
    roleIds[definition.slug] = roleId;

    // Convergência das permissões: remove o que não está mais na definição e
    // insere o que falta. Nada é reescrito à toa.
    const wanted = [...definition.permissions];
    await db
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, roleId),
          notInArray(rolePermissions.permission, wanted),
        ),
      );
    const present = await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));
    const presentSet = new Set(present.map((row) => row.permission));
    const missing = wanted.filter((permission) => !presentSet.has(permission));
    if (missing.length > 0) {
      await db
        .insert(rolePermissions)
        .values(missing.map((permission) => ({ roleId: roleId, permission })));
      created.push(`permissões de ${definition.slug} (${missing.length})`);
    }
  }

  return roleIds;
}

/** Garante o usuário owner de exemplo. */
async function seedOwnerUser(db: Database, created: string[]): Promise<string> {
  const email = envValue('SEED_OWNER_EMAIL') ?? DEFAULT_OWNER_EMAIL;
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const current = existing[0];
  if (current) {
    return current.id;
  }
  const id = newId();
  await db.insert(users).values({
    id,
    email,
    displayName: 'Prometheon Owner',
    status: 'active',
    emailVerifiedAt: new Date(),
    // Hash Argon2id pronto, quando fornecido. Nunca senha em texto puro.
    passwordHash: envValue('SEED_OWNER_PASSWORD_HASH') ?? null,
  });
  created.push(`usuário ${email}`);
  return id;
}

/** Garante a organização de exemplo e o vínculo do owner. */
async function seedExampleOrganization(
  db: Database,
  input: { planId: string; ownerUserId: string; ownerRoleId: string },
  created: string[],
): Promise<string> {
  const existing = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, EXAMPLE_ORGANIZATION.slug))
    .limit(1);

  let organizationId = existing[0]?.id;
  if (!organizationId) {
    organizationId = newId();
    await db.insert(organizations).values({
      id: organizationId,
      slug: EXAMPLE_ORGANIZATION.slug,
      name: EXAMPLE_ORGANIZATION.name,
      planId: input.planId,
      ownerUserId: input.ownerUserId,
      status: 'active',
      createdBy: input.ownerUserId,
    });
    created.push(`organização ${EXAMPLE_ORGANIZATION.slug}`);
  }

  const membership = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, input.ownerUserId),
      ),
    )
    .limit(1);

  if (!membership[0]) {
    await db.insert(organizationMembers).values({
      id: newId(),
      organizationId,
      userId: input.ownerUserId,
      roleId: input.ownerRoleId,
      status: 'active',
      joinedAt: new Date(),
      createdBy: input.ownerUserId,
    });
    created.push('vínculo do owner na organização de exemplo');
  }

  return organizationId;
}

/** Executa o seed inteiro contra a conexão informada. */
export async function seedDatabase(db: Database): Promise<SeedResult> {
  const created: string[] = [];
  const planId = await seedFreePlan(db, created);
  const roleIds = await seedSystemRoles(db, created);
  const ownerRoleId = roleIds['owner'];
  if (!ownerRoleId) {
    throw new Error('Papel `owner` ausente depois do seed de papéis — schema desatualizado?');
  }
  const ownerUserId = await seedOwnerUser(db, created);
  const organizationId = await seedExampleOrganization(
    db,
    { planId, ownerUserId, ownerRoleId },
    created,
  );

  return { planId, roleIds, organizationId, ownerUserId, created };
}

/** Abre a conexão, roda o seed e fecha. */
export async function runSeed(options: CreatePoolOptions = {}): Promise<SeedResult> {
  const { db, pool } = createDatabase({ ...options, connectionLimit: 1 });
  try {
    return await seedDatabase(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Erro típico de banco ainda não migrado.
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') {
      throw new Error(`Tabelas ausentes: rode as migrations antes do seed. (${message})`, {
        cause: error,
      });
    }
    throw new Error(`Falha no seed: ${message}`, { cause: error });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const result = await runSeed();
  if (result.created.length === 0) {
    console.log('Seed já aplicado: nada foi criado.');
  } else {
    console.log(`Seed aplicado (${result.created.length} item(ns)):`);
    for (const item of result.created) {
      console.log(`  + ${item}`);
    }
  }
  console.log(`  organização: ${result.organizationId}`);
  console.log(`  owner:       ${result.ownerUserId}`);
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
