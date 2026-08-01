import { randomBytes } from 'node:crypto';
import { getConfig } from '@prometheon/config';

export interface DisposableDatabase {
  readonly name: string;
  /** Configuração de conexão apontando para o banco temporário. */
  readonly connection: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
  };
  /** Derruba o banco. Seguro chamar mais de uma vez. */
  drop(): Promise<void>;
}

/** Nome que deixa claro de onde veio e que é descartável. */
function temporaryName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

/**
 * Cria um banco temporário para uma suíte de teste.
 *
 * O nome é sempre sorteado, então duas suítes em paralelo não disputam o mesmo
 * banco. O `drop()` recusa qualquer nome que não tenha o prefixo esperado — a
 * proteção existe porque um erro aqui apagaria `prometheon_dev`, e o custo de
 * conferir é uma linha.
 */
export async function createDisposableDatabase(
  prefix = 'prometheon_test',
): Promise<DisposableDatabase> {
  // Duas checagens em vez de uma regex com dois `[a-z0-9_]*` em volta de
  // `test`: aquela forma era ambígua e fazia o motor voltar atrás em cada
  // repetição de "test". Estas são lineares e dizem a mesma coisa.
  const formaValida = /^prometheon_[a-z0-9_]*$/i.test(prefix);

  if (!formaValida || !prefix.toLowerCase().includes('test')) {
    throw new Error(
      `Prefixo de banco de teste inválido: "${prefix}". Ele precisa começar com "prometheon_" e conter "test".`,
    );
  }

  const config = getConfig();
  const { createConnection } = await import('mysql2/promise');
  const name = temporaryName(prefix);

  const admin = await createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    connectTimeout: 8000,
  });
  await admin.query(
    `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  await admin.end();

  let dropped = false;
  return {
    name,
    connection: {
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      password: config.database.password,
      database: name,
    },
    async drop() {
      if (dropped) {
        return;
      }
      dropped = true;
      const connection = await createConnection({
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        connectTimeout: 8000,
      });
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await connection.end();
    },
  };
}
