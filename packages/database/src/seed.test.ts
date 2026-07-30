// Idempotência do seed contra um MySQL de verdade.
//
// Precisa de banco: cria um descartável, migra, roda o seed duas vezes e
// confere que a segunda execução não criou nem duplicou nada. Sem MySQL, a
// suíte inteira é pulada com o motivo no console.

import { count, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SYSTEM_ROLES } from './permissions.js';
import {
  organizationMembers,
  organizations,
  plans,
  rolePermissions,
  roles,
  users,
} from './schema/index.js';
import { seedDatabase } from './seed.js';
import { createDisposableDatabase, probeDatabase, type DisposableDatabase } from './test-support.js';

const probe = await probeDatabase();
if (!probe.reachable) {
  console.warn(
    `[seed] MySQL inacessível — suíte pulada. Motivo: ${probe.reason ?? 'desconhecido'}`,
  );
}

describe.skipIf(!probe.reachable)('seedDatabase', () => {
  let temporary: DisposableDatabase;

  beforeAll(async () => {
    temporary = await createDisposableDatabase('prometheon_seed_test');
  }, 180_000);

  afterAll(async () => {
    await temporary?.drop();
  }, 60_000);

  it('cria plano, papéis, organização e owner na primeira execução', async () => {
    const result = await seedDatabase(temporary.db);

    expect(result.created.length).toBeGreaterThan(0);
    expect(Object.keys(result.roleIds).sort()).toEqual(
      SYSTEM_ROLES.map((role) => role.slug).sort(),
    );
    expect(result.organizationId).toHaveLength(26);
    expect(result.ownerUserId).toHaveLength(26);
  });

  it('não duplica nada na segunda execução', async () => {
    const before = await snapshot(temporary);
    const result = await seedDatabase(temporary.db);
    const after = await snapshot(temporary);

    expect(result.created).toEqual([]);
    expect(after).toEqual(before);
  });

  it('deixa exatamente os seis papéis do sistema com as permissões do Docs/09', async () => {
    const systemRoles = await temporary.db.select().from(roles).where(isNull(roles.organizationId));
    expect(systemRoles).toHaveLength(SYSTEM_ROLES.length);

    for (const definition of SYSTEM_ROLES) {
      const role = systemRoles.find((candidate) => candidate.slug === definition.slug);
      expect(role, `papel ${definition.slug} ausente`).toBeDefined();
      const granted = await temporary.db
        .select({ permission: rolePermissions.permission })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, role!.id));
      expect(granted.map((row) => row.permission).sort()).toEqual([...definition.permissions].sort());
    }
  });

  it('vincula o owner à organização de exemplo', async () => {
    const [organization] = await temporary.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, 'prometheon-demo'))
      .limit(1);
    expect(organization).toBeDefined();

    const members = await temporary.db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organization!.id));
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(organization!.ownerUserId);

    // O seed nunca grava senha: quem define é o fluxo de registro da API.
    const [owner] = await temporary.db
      .select()
      .from(users)
      .where(eq(users.id, organization!.ownerUserId!))
      .limit(1);
    expect(owner?.passwordHash ?? null).toBeNull();
  });
});

/** Contagem de todas as tabelas que o seed toca. */
async function snapshot(temporary: DisposableDatabase): Promise<Record<string, number>> {
  const tables = {
    plans,
    roles,
    rolePermissions,
    users,
    organizations,
    organizationMembers,
  } as const;

  const result: Record<string, number> = {};
  for (const [name, table] of Object.entries(tables)) {
    const [row] = await temporary.db.select({ value: count() }).from(table);
    result[name] = row?.value ?? 0;
  }
  return result;
}
