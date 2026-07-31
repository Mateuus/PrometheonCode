/**
 * Verificações de saúde (`Docs/06`).
 *
 * `ready` valida dependências **sem consulta cara**: `SELECT 1` no MySQL, `PING`
 * no Redis e uma verificação do transporte de e-mail. Nada aqui toca tabela de
 * negócio — um health check que faz `COUNT(*)` derruba o banco justamente
 * quando o orquestrador aumenta a frequência das sondagens.
 *
 * A distinção entre `down` e `degraded` também é deliberada: sem MySQL ou sem
 * Redis a API não atende, então o processo deve sair do balanceador. Sem SMTP
 * ela atende quase tudo — só o cadastro fica manco — então o estado é
 * `degraded` e o tráfego continua.
 */

import type { Database } from '@prometheon/database';

import type { MailService } from '../../mail/types.js';
import type { RedisClient } from '../../plugins/redis.js';

export type CheckStatus = 'ok' | 'degraded' | 'down';

/** Mutável porque este objeto vai direto para o serializador da resposta. */
export interface DependencyCheck {
  name: 'mysql' | 'redis' | 'smtp';
  status: CheckStatus;
  latencyMs: number | null;
  detail: string | null;
}

export interface ReadinessReport {
  status: CheckStatus;
  checks: DependencyCheck[];
  checkedAt: string;
}

/** Uma dependência lenta é uma dependência quebrada, do ponto de vista do LB. */
const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error(`${label} did not answer in ${String(CHECK_TIMEOUT_MS)}ms`)); },
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function truncate(value: string): string {
  return value.length > 255 ? `${value.slice(0, 252)}...` : value;
}

export interface HealthDeps {
  readonly db: Database;
  readonly redis: RedisClient;
  readonly mailer: MailService;
}

export async function checkReadiness(deps: HealthDeps): Promise<ReadinessReport> {
  const checks = await Promise.all([
    check('mysql', async () => {
      await withTimeout(deps.db.query('SELECT 1'), 'mysql');

      return null;
    }),
    check('redis', async () => {
      const pong = await withTimeout(deps.redis.ping(), 'redis');

      return pong;
    }),
    check(
      'smtp',
      async () => {
        const result = await withTimeout(deps.mailer.verify(), 'smtp');

        if (!result.ok) {
          throw new Error(result.detail ?? 'transport unavailable');
        }

        return result.detail;
      },
      // Falta de e-mail não tira a API do ar.
      'degraded',
    ),
  ]);

  const worst = checks.some((item) => item.status === 'down')
    ? 'down'
    : checks.some((item) => item.status === 'degraded')
      ? 'degraded'
      : 'ok';

  return { status: worst, checks, checkedAt: new Date().toISOString() };
}

async function check(
  name: DependencyCheck['name'],
  probe: () => Promise<string | null>,
  failureStatus: CheckStatus = 'down',
): Promise<DependencyCheck> {
  const started = process.hrtime.bigint();

  try {
    const detail = await probe();
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    return {
      name,
      status: 'ok',
      latencyMs: Math.round(latencyMs * 100) / 100,
      detail: detail === null ? null : truncate(detail),
    };
  } catch (error) {
    return {
      name,
      status: failureStatus,
      latencyMs: null,
      detail: truncate(error instanceof Error ? error.message : String(error)),
    };
  }
}
