// Backoff exponencial com jitter e teto (`Docs/08`).
//
// Exponencial sozinho sincroniza as retentativas: mil clientes que falharam no
// mesmo segundo voltam juntos no segundo seguinte e derrubam de novo o serviço
// que estava se recuperando. O jitter espalha essa volta.
//
// O padrão daqui é o jitter "equal": metade do degrau é fixa e metade é
// sorteada. Diferente do jitter "full", ele nunca devolve um atraso perto de
// zero — o que importa quando a falha foi justamente excesso de chamadas.

export type JitterMode = 'none' | 'equal' | 'full';

export interface BackoffOptions {
  /** Primeiro degrau, em milissegundos. */
  readonly baseMs: number;
  /** Teto do degrau, antes do jitter. */
  readonly maxMs: number;
  /** Multiplicador entre degraus. */
  readonly factor?: number;
  readonly jitter?: JitterMode;
  /** Fonte de aleatoriedade; existe para o teste ser determinístico. */
  readonly random?: () => number;
}

/**
 * Atraso da tentativa `attempt` (1 é a primeira retentativa).
 *
 * @returns milissegundos, sempre inteiro e não negativo.
 */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 'equal';
  const random = options.random ?? Math.random;
  const step = Math.max(1, Math.trunc(attempt));

  const raw = options.baseMs * Math.pow(factor, step - 1);
  const capped = Math.min(raw, options.maxMs);

  switch (jitter) {
    case 'none':
      return Math.max(0, Math.round(capped));
    case 'full':
      return Math.max(0, Math.round(capped * random()));
    case 'equal':
      return Math.max(0, Math.round(capped / 2 + (capped / 2) * random()));
  }
}

/** Instante em que a próxima tentativa fica disponível. */
export function nextAttemptAt(
  attempt: number,
  options: BackoffOptions,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() + backoffDelay(attempt, options));
}
