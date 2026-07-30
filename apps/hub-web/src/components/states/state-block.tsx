import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type StateBlockTone = 'neutral' | 'accent' | 'alert' | 'danger';

const iconToneClasses: Record<StateBlockTone, string> = {
  neutral: 'text-muted bg-surface-raised',
  accent: 'text-accent bg-accent-soft',
  alert: 'text-alert bg-alert/10',
  danger: 'text-danger bg-danger/10',
};

/**
 * Forma visual comum aos estados de tela.
 *
 * Todos os sete estados do `Docs/05` saem daqui, então eles têm a mesma
 * silhueta e o usuário aprende a ler um só. Ícone sempre presente: o estado não
 * se distingue pela cor apenas.
 */
export function StateBlock({
  icon: Icon,
  tone = 'neutral',
  title,
  description,
  actions,
  detail,
  role = 'status',
  className,
}: {
  icon: LucideIcon;
  tone?: StateBlockTone;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Linha técnica opcional, como o request ID de um erro. */
  detail?: string;
  role?: 'status' | 'alert';
  className?: string;
}) {
  return (
    <div
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-[var(--radius-prom)] border border-dashed border-line bg-surface px-6 py-10 text-center',
        className,
      )}
    >
      <span
        className={cn(
          'flex size-10 items-center justify-center rounded-full',
          iconToneClasses[tone],
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="max-w-md">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        {detail ? (
          <p className="mt-2 font-mono text-xs text-muted break-all">{detail}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
