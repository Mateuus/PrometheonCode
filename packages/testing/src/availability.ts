import { getConfig } from '@prometheon/config';

export interface ServiceStatus {
  readonly mysql: boolean;
  readonly redis: boolean;
  /** Motivo pronto para exibir quando algo está fora. */
  readonly detail: string;
}

/** Uma checagem por processo: reabrir conexão a cada teste é desperdício. */
let cached: Promise<ServiceStatus> | undefined;

/**
 * Diz se as dependências externas estão acessíveis.
 *
 * Suíte que precisa de banco deve **pular** quando ele não responde, em vez de
 * falhar: um desenvolvedor sem acesso à rede do servidor não pode ficar com o
 * pipeline vermelho por um motivo que não é dele. O que não pode acontecer é
 * pular em silêncio — daí o `detail`, que sempre explica o motivo.
 */
export async function servicesAvailable(): Promise<ServiceStatus> {
  cached ??= probe();
  return cached;
}

async function probe(): Promise<ServiceStatus> {
  const config = getConfig();
  const problems: string[] = [];

  let mysql = false;
  try {
    const { createConnection } = await import('mysql2/promise');
    const connection = await createConnection({
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      password: config.database.password,
      connectTimeout: 5000,
    });
    await connection.query('SELECT 1');
    await connection.end();
    mysql = true;
  } catch (error) {
    problems.push(`MySQL indisponível (${message(error)})`);
  }

  let redis = false;
  try {
    const { Redis } = await import('ioredis');
    const url =
      config.redis.url !== undefined && config.redis.url !== ''
        ? config.redis.url
        : `redis://${config.redis.host ?? '127.0.0.1'}:${config.redis.port}/${config.redis.db}`;
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
    });
    await client.connect();
    await client.ping();
    client.disconnect();
    redis = true;
  } catch (error) {
    problems.push(`Redis indisponível (${message(error)})`);
  }

  return {
    mysql,
    redis,
    detail: problems.length === 0 ? 'MySQL e Redis acessíveis' : problems.join('; '),
  };
}

/** Texto para o `skip` do runner, para o motivo aparecer no relatório. */
export function describeUnavailable(status: ServiceStatus, needs: 'mysql' | 'redis' | 'both'): string {
  const missing =
    needs === 'both'
      ? !status.mysql || !status.redis
      : needs === 'mysql'
        ? !status.mysql
        : !status.redis;
  return missing ? `pulado: ${status.detail}` : '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
