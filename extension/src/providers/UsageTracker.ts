import type { LocalStateStore } from '../storage/LocalStateStore';

/** Tokens de uma execução, como o adaptador reportou. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
}

/** Uso acumulado de um perfil, em janelas úteis para a interface. */
export interface ProfileUsage {
  readonly profileId: string;
  readonly today: TokenUsage;
  readonly last7Days: TokenUsage;
  readonly total: TokenUsage;
  readonly runs: number;
  readonly lastRunAt: number | null;
}

interface UsageEntry {
  readonly profileId: string;
  /** Dia em UTC (`YYYY-MM-DD`), para somar sem depender do fuso na leitura. */
  readonly day: string;
  readonly input: number;
  readonly output: number;
  readonly runs: number;
  readonly lastRunAt: number;
}

/** Além disso o histórico não ajuda ninguém e só engorda o estado local. */
const RETENTION_DAYS = 60;

/**
 * Conta tokens por perfil de provedor. É a única fonte de uso que o Prometheon
 * pode oferecer com honestidade: os limites da assinatura (janela de 5h, semana)
 * vivem na conta do provedor e só o serviço dele sabe informar — ler isso
 * exigiria o token do usuário, o que este projeto não faz.
 */
export class UsageTracker {
  constructor(private readonly store: LocalStateStore) {}

  async record(profileId: string, usage: TokenUsage, when = Date.now()): Promise<void> {
    if (usage.input === 0 && usage.output === 0) {
      return;
    }
    const day = dayKey(when);
    const entries = [...this.store.getUsageEntries()];
    const index = entries.findIndex((entry) => entry.profileId === profileId && entry.day === day);
    const current = index === -1 ? null : entries[index];

    const merged: UsageEntry = {
      profileId,
      day,
      input: (current?.input ?? 0) + usage.input,
      output: (current?.output ?? 0) + usage.output,
      runs: (current?.runs ?? 0) + 1,
      lastRunAt: when,
    };
    if (index === -1) {
      entries.push(merged);
    } else {
      entries[index] = merged;
    }

    await this.store.setUsageEntries(prune(entries, when));
  }

  /** Uso de um perfil. Perfil sem execução nenhuma volta zerado, não ausente. */
  usageFor(profileId: string, now = Date.now()): ProfileUsage {
    const entries = this.store
      .getUsageEntries()
      .filter((entry) => entry.profileId === profileId);

    const today = dayKey(now);
    const weekStart = dayKey(now - 6 * DAY_MS);

    const sum = (predicate: (entry: UsageEntry) => boolean): TokenUsage =>
      entries.filter(predicate).reduce(
        (total, entry) => ({
          input: total.input + entry.input,
          output: total.output + entry.output,
        }),
        { input: 0, output: 0 },
      );

    return {
      profileId,
      today: sum((entry) => entry.day === today),
      last7Days: sum((entry) => entry.day >= weekStart),
      total: sum(() => true),
      runs: entries.reduce((total, entry) => total + entry.runs, 0),
      lastRunAt: entries.reduce<number | null>(
        (latest, entry) => (latest === null || entry.lastRunAt > latest ? entry.lastRunAt : latest),
        null,
      ),
    };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function prune(entries: readonly UsageEntry[], now: number): UsageEntry[] {
  const oldest = dayKey(now - RETENTION_DAYS * DAY_MS);
  return entries.filter((entry) => entry.day >= oldest);
}

export type { UsageEntry };
