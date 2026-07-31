// Concede (ou tira) a marca de administrador da plataforma.
//
// A marca não tem rota que a escreva, e isso é de propósito: quem administra o
// Hub inteiro vê e muda o plano de qualquer organização, então a concessão fica
// fora do alcance de qualquer sessão — mesmo a de um dono de organização. Ela é
// feita por quem tem acesso ao banco, no servidor.
//
// Uso:
//   pnpm --filter @prometheon/database db:grant-admin fulana@exemplo.com
//   pnpm --filter @prometheon/database db:grant-admin fulana@exemplo.com --revoke

import { resolve } from 'node:path';
import process from 'node:process';

import { createDatabase, type CreateDatabaseOptions, type Database } from './client.js';
import { users } from './entities/index.js';

export interface GrantPlatformAdminResult {
  readonly email: string;
  readonly userId: string;
  readonly isPlatformAdmin: boolean;
  /** Falso quando a conta já estava no estado pedido. */
  readonly changed: boolean;
}

export async function grantPlatformAdmin(
  db: Database,
  email: string,
  grant = true,
): Promise<GrantPlatformAdminResult> {
  const repository = db.getRepository(users);
  const normalized = email.trim().toLowerCase();
  const user = await repository.findOne({ where: { email: normalized } });

  if (user === null) {
    throw new Error(`Nenhuma conta com o e-mail ${normalized}.`);
  }

  if (user.isPlatformAdmin === grant) {
    return { email: normalized, userId: user.id, isPlatformAdmin: grant, changed: false };
  }

  await repository.update({ id: user.id }, { isPlatformAdmin: grant });

  return { email: normalized, userId: user.id, isPlatformAdmin: grant, changed: true };
}

/** Abre a conexão, aplica e fecha. */
export async function runGrantPlatformAdmin(
  email: string,
  grant = true,
  options: CreateDatabaseOptions = {},
): Promise<GrantPlatformAdminResult> {
  const db = await createDatabase({ ...options, connectionLimit: 1 });

  try {
    return await grantPlatformAdmin(db, email, grant);
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const email = args.find((argument) => !argument.startsWith('--'));

  if (email === undefined) {
    throw new Error('Informe o e-mail da conta. Ex.: db:grant-admin fulana@exemplo.com');
  }

  const result = await runGrantPlatformAdmin(email, !revoke);

  console.log(
    result.changed
      ? `${result.email} agora ${result.isPlatformAdmin ? 'administra' : 'não administra'} a plataforma.`
      : `${result.email} já estava assim; nada mudou.`,
  );
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
