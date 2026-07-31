// Métricas do worker (`Docs/11`).
//
// Registro em memória, exposto pelo endpoint de health em JSON e em texto no
// formato do Prometheus. Não há dependência de OpenTelemetry aqui de propósito:
// o coletor entra quando o `otel-collector` do compose existir, e o formato
// texto já serve de ponte até lá.
//
// Os nomes que o `Docs/11` lista aparecem tal e qual: `queue_wait_duration`,
// `jobs_failed_total`, `redis_errors_total`, `sync_outbox_pending`. O restante
// é do worker e segue a mesma convenção (`_total` para contador, `_duration`
// para histograma em milissegundos).

export type MetricLabels = Readonly<Record<string, string>>;

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Contagem acumulada por balde, na ordem de `HISTOGRAM_BUCKETS_MS`. */
  buckets: number[];
}

/** Baldes em milissegundos: de "instantâneo" a "isso está travado". */
export const HISTOGRAM_BUCKETS_MS = [
  5, 25, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000,
] as const;

export interface MetricSample {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

export interface HistogramSample {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly buckets: readonly { readonly le: number; readonly count: number }[];
}

export interface MetricsSnapshot {
  readonly counters: readonly MetricSample[];
  readonly gauges: readonly MetricSample[];
  readonly histograms: readonly HistogramSample[];
}

/** Serializa nome + rótulos numa chave estável, com rótulos ordenados. */
function seriesKey(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return name;
  }
  const rendered = entries.map(([key, value]) => `${key}=${value}`).join(',');
  return `${name}{${rendered}}`;
}

interface Series<T> {
  readonly name: string;
  readonly labels: MetricLabels;
  value: T;
}

/**
 * Registro de métricas do processo.
 *
 * Deliberadamente simples: contadores e gauges em `Map`, histogramas com baldes
 * fixos. Nada aqui aloca por observação, o que importa num laço que roda a cada
 * poucas centenas de milissegundos.
 */
export class MetricsRegistry {
  readonly #counters = new Map<string, Series<number>>();
  readonly #gauges = new Map<string, Series<number>>();
  readonly #histograms = new Map<string, Series<HistogramState>>();

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    const key = seriesKey(name, labels);
    const existing = this.#counters.get(key);
    if (existing === undefined) {
      this.#counters.set(key, { name, labels, value: amount });
      return;
    }
    existing.value += amount;
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.#gauges.set(seriesKey(name, labels), { name, labels, value });
  }

  observe(name: string, valueMs: number, labels: MetricLabels = {}): void {
    const key = seriesKey(name, labels);
    let series = this.#histograms.get(key);
    if (series === undefined) {
      series = {
        name,
        labels,
        value: {
          count: 0,
          sum: 0,
          min: Number.POSITIVE_INFINITY,
          max: 0,
          buckets: new Array<number>(HISTOGRAM_BUCKETS_MS.length).fill(0),
        },
      };
      this.#histograms.set(key, series);
    }
    const state = series.value;
    state.count += 1;
    state.sum += valueMs;
    state.min = Math.min(state.min, valueMs);
    state.max = Math.max(state.max, valueMs);
    for (let index = 0; index < HISTOGRAM_BUCKETS_MS.length; index += 1) {
      const upperBound = HISTOGRAM_BUCKETS_MS[index];
      if (upperBound !== undefined && valueMs <= upperBound) {
        state.buckets[index] = (state.buckets[index] ?? 0) + 1;
      }
    }
  }

  /** Valor corrente de um contador; útil em teste e em log de diagnóstico. */
  counterValue(name: string, labels: MetricLabels = {}): number {
    return this.#counters.get(seriesKey(name, labels))?.value ?? 0;
  }

  gaugeValue(name: string, labels: MetricLabels = {}): number | undefined {
    return this.#gauges.get(seriesKey(name, labels))?.value;
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.#counters.values()].map((series) => ({
        name: series.name,
        labels: series.labels,
        value: series.value,
      })),
      gauges: [...this.#gauges.values()].map((series) => ({
        name: series.name,
        labels: series.labels,
        value: series.value,
      })),
      histograms: [...this.#histograms.values()].map((series) => ({
        name: series.name,
        labels: series.labels,
        count: series.value.count,
        sum: series.value.sum,
        min: series.value.count === 0 ? 0 : series.value.min,
        max: series.value.max,
        buckets: HISTOGRAM_BUCKETS_MS.map((le, index) => ({
          le,
          count: series.value.buckets[index] ?? 0,
        })),
      })),
    };
  }

  reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#histograms.clear();
  }
}

/** Rótulos no formato do Prometheus. */
function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== '');
  if (entries.length === 0) {
    return '';
  }
  const rendered = entries
    .map(([key, value]) => `${key}="${value.replace(/(["\\])/g, '\\$1')}"`)
    .join(',');
  return `{${rendered}}`;
}

/** Exposição em texto, no formato que o Prometheus raspa. */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  for (const sample of snapshot.counters) {
    lines.push(`${sample.name}${renderLabels(sample.labels)} ${String(sample.value)}`);
  }
  for (const sample of snapshot.gauges) {
    lines.push(`${sample.name}${renderLabels(sample.labels)} ${String(sample.value)}`);
  }
  for (const sample of snapshot.histograms) {
    for (const bucket of sample.buckets) {
      const labels = renderLabels({ ...sample.labels, le: String(bucket.le) });
      lines.push(`${sample.name}_bucket${labels} ${String(bucket.count)}`);
    }
    const labels = renderLabels(sample.labels);
    lines.push(`${sample.name}_sum${labels} ${String(sample.sum)}`);
    lines.push(`${sample.name}_count${labels} ${String(sample.count)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Nomes usados pelo worker, reunidos para não haver divergência de grafia. */
export const METRIC = {
  /** Espera na fila entre o enfileiramento e o início da execução. */
  queueWaitDuration: 'queue_wait_duration',
  /** Duração da execução do job. */
  jobDuration: 'job_duration',
  jobsProcessedTotal: 'jobs_processed_total',
  jobsFailedTotal: 'jobs_failed_total',
  jobsSkippedTotal: 'jobs_skipped_total',
  jobsDeadLetteredTotal: 'jobs_dead_lettered_total',
  jobsActive: 'jobs_active',
  redisErrorsTotal: 'redis_errors_total',
  /** Mensagens de outbox ainda não publicadas. */
  outboxPending: 'sync_outbox_pending',
  /** Idade da mensagem não publicada mais antiga: denuncia worker parado. */
  outboxLagSeconds: 'sync_outbox_lag_seconds',
  outboxPublishedTotal: 'outbox_published_total',
  outboxDuplicatesTotal: 'outbox_duplicate_skipped_total',
  outboxLockContentionTotal: 'outbox_lock_contention_total',
  outboxFailuresTotal: 'outbox_publish_failures_total',
  outboxDeadLetteredTotal: 'outbox_dead_lettered_total',
  outboxBatchDuration: 'outbox_batch_duration',
} as const;
