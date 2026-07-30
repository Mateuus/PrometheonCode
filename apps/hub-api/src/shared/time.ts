/**
 * Tempo, sempre em UTC (`Docs/03`).
 *
 * O driver do MySQL está configurado com `timezone: 'Z'` e as colunas são
 * `datetime(3)`, então um `Date` do Node atravessa a fronteira sem conversão de
 * fuso. O que este módulo padroniza é a serialização: para fora da API, data é
 * string ISO 8601 com `Z`.
 */

/** Instante atual. Existe para que o teste possa trocar a fonte do relógio. */
export function now(): Date {
  return new Date();
}

/** Serializa em ISO 8601 UTC. */
export function toIso(value: Date): string {
  return value.toISOString();
}

/** Serializa aceitando nulo, que é como o banco devolve coluna opcional. */
export function toIsoOrNull(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

export function addSeconds(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}

/** Segundos que faltam até `target`, nunca negativo. */
export function secondsUntil(target: Date, from: Date = now()): number {
  return Math.max(0, Math.ceil((target.getTime() - from.getTime()) / 1000));
}

export function isExpired(target: Date | null | undefined, at: Date = now()): boolean {
  return target === null || target === undefined || target.getTime() <= at.getTime();
}
