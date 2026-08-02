/**
 * Vagas de execução simultânea.
 *
 * Um orquestrador dispara várias delegações no mesmo turno, e elas chegam
 * juntas. Contar os agentes que já estão na lista não serve como teto: entre
 * ler a lista e entrar nela existe um `await`, e nesse intervalo as outras
 * chamadas leem a mesma lista antiga e todas se acham dentro do limite. Foi
 * assim que um agente de uma vaga só rodou três vezes ao mesmo tempo.
 *
 * Aqui a reserva é **síncrona**: quem chama `tryReserve` já sai com a vaga
 * tomada ou com o motivo da recusa, sem nenhum ponto de espera no meio. O
 * `release` vai no `finally` de quem reservou — vaga que não volta é vaga
 * perdida para sempre.
 *
 * A recusa é final, e não uma fila: esperar em silêncio transformaria "o teto
 * está cheio" em "o Prometheon travou", e quem pediu não teria como saber a
 * diferença.
 */

export interface ReservationRefused {
  readonly ok: false;
  /** Frase pronta para o orquestrador, dizendo o teto e o que fazer. */
  readonly reason: string;
}

export type Reservation = { readonly ok: true } | ReservationRefused;

export class ConcurrencyGuard {
  private readonly perKey = new Map<string, number>();
  private total = 0;

  /**
   * Toma uma vaga para `key`, ou devolve o motivo da recusa.
   *
   * Não há `await` neste método, e isso é o ponto: em JavaScript, código
   * síncrono não é interrompido, então duas chamadas nunca leem o mesmo
   * contador antes de escrevê-lo.
   */
  tryReserve(key: string, label: string, keyLimit: number, globalLimit: number): Reservation {
    if (this.total >= globalLimit) {
      return {
        ok: false,
        reason: `The machine limit of ${String(globalLimit)} simultaneous agents was reached. Wait for one to finish, or raise prometheon.agents.globalConcurrency.`,
      };
    }

    const used = this.perKey.get(key) ?? 0;
    if (used >= keyLimit) {
      return {
        ok: false,
        reason: `Agent "${label}" runs ${String(keyLimit)} task(s) at a time and is already at that limit. Wait for it to finish, delegate to another agent, or raise Max sessions in its profile.`,
      };
    }

    this.perKey.set(key, used + 1);
    this.total += 1;
    return { ok: true };
  }

  /** Devolve a vaga. Chamar sem ter reservado não faz o contador ficar negativo. */
  release(key: string): void {
    const used = this.perKey.get(key) ?? 0;
    if (used <= 1) {
      this.perKey.delete(key);
    } else {
      this.perKey.set(key, used - 1);
    }
    this.total = Math.max(0, this.total - 1);
  }

  /** Quantos agentes estão ocupados agora, no total. */
  get running(): number {
    return this.total;
  }
}
