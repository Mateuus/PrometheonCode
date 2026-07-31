import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type StatTone = 'neutral' | 'accent' | 'activity' | 'running' | 'alert';

const toneClasses: Record<StatTone, string> = {
  neutral: 'text-muted bg-surface-raised',
  accent: 'text-accent bg-accent-soft',
  activity: 'text-activity bg-activity/10',
  running: 'text-running bg-running/10',
  alert: 'text-alert bg-alert/10',
};

/**
 * Número do painel.
 *
 * O ícone e o rótulo carregam o significado; o tom só reforça. Trocar todas as
 * cores por cinza não deve tirar o sentido de nenhum cartão — é o teste que o
 * `Docs/05` pede ao proibir status só por cor.
 */
export function Stat({
  label,
  value,
  icon,
  tone = 'neutral',
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: StatTone;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-prom)] border border-line bg-surface p-4',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-7 items-center justify-center rounded-[6px] [&_svg]:size-3.5',
            toneClasses[tone],
          )}
        >
          {icon}
        </span>
        <span className="text-xs font-medium text-muted">{label}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/** Barra de uso com rótulo textual — a leitura não depende do comprimento. */
export function UsageBar({
  label,
  valueLabel,
  ratio,
}: {
  label: string;
  valueLabel: string;
  /** `null` quando o plano não impõe limite. */
  ratio: number | null;
}) {
  const percentage = ratio === null ? null : Math.min(100, Math.round(ratio * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-medium text-foreground">{valueLabel}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percentage ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueLabel}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-raised"
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${percentage ?? 100}%`, opacity: percentage === null ? 0.35 : 1 }}
        />
      </div>
    </div>
  );
}
