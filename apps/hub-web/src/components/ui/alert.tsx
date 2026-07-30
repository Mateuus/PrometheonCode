import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CircleAlert, Info } from 'lucide-react';
import { cn } from '@/lib/cn';

export type AlertTone = 'info' | 'alert' | 'danger';

const toneClasses: Record<AlertTone, string> = {
  info: 'border-line bg-surface-raised text-foreground',
  alert: 'border-alert/50 bg-alert/10 text-foreground',
  danger: 'border-danger/40 bg-danger/10 text-foreground',
};

const toneIcons: Record<AlertTone, LucideIcon> = {
  info: Info,
  alert: AlertTriangle,
  danger: CircleAlert,
};

const toneIconClasses: Record<AlertTone, string> = {
  info: 'text-activity',
  alert: 'text-alert',
  danger: 'text-danger',
};

/**
 * Aviso em bloco. O ícone acompanha o tom para que o recado não dependa da cor,
 * e o `role` muda com a gravidade para o leitor de tela anunciar na hora certa.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: AlertTone;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = toneIcons[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-[var(--radius-prom)] border px-4 py-3 text-sm',
        toneClasses[tone],
        className,
      )}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', toneIconClasses[tone])} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-1 text-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
