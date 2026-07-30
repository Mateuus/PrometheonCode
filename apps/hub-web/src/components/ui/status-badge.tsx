import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
  Radio,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Papel visual de um estado. Cada tom tem cor **e** ícone: o `Docs/05` proíbe
 * comunicar status só por cor, então o ícone não é opcional — quem não passa um
 * recebe o padrão do tom, e nenhum crachá sai sem forma própria.
 */
export type StatusTone =
  | 'neutral'
  | 'accent'
  | 'activity'
  | 'running'
  | 'alert'
  | 'danger'
  | 'success';

const toneClasses: Record<StatusTone, string> = {
  neutral: 'border-line text-muted bg-surface-raised',
  accent: 'border-accent/40 text-accent bg-accent-soft',
  activity: 'border-activity/40 text-activity bg-activity/10',
  running: 'border-running/40 text-running bg-running/10',
  alert: 'border-alert/50 text-alert bg-alert/10',
  danger: 'border-danger/40 text-danger bg-danger/10',
  success: 'border-success/40 text-success bg-success/10',
};

const toneIcons: Record<StatusTone, LucideIcon> = {
  neutral: CircleDashed,
  accent: Sparkles,
  activity: Radio,
  running: Loader2,
  alert: AlertTriangle,
  danger: CircleSlash,
  success: CheckCircle2,
};

export function StatusBadge({
  tone = 'neutral',
  icon,
  children,
  className,
}: {
  tone?: StatusTone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = icon ?? toneIcons[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        toneClasses[tone],
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {children}
    </span>
  );
}

/** Crachá neutro para contagens e rótulos que não são status. */
export function Badge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-line bg-surface-raised px-2 py-0.5 text-xs font-medium text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
