'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/cn';
import { useTranslate } from '@/i18n/provider';
import type { FormState } from '@/lib/actions/form-state';

/**
 * Formulário que abre a partir de um botão.
 *
 * É um `<details>` de verdade, não um modal montado à mão: abre e fecha sem
 * JavaScript, o teclado já sabe operá-lo e o leitor de tela anuncia o estado.
 * Um diálogo aqui só acrescentaria armadilha de foco para resolver um problema
 * que não existe.
 *
 * O painel sai do fluxo quando há espaço (`sm:absolute`), para abrir o
 * formulário não empurrar a lista que está logo abaixo; no celular ele volta a
 * empilhar, que é onde empurrar não incomoda.
 */
export function Disclosure({
  label,
  icon,
  children,
  className,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn('relative', className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-prom)] bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground [&::-webkit-details-marker]:hidden">
        {icon}
        {label}
      </summary>
      <div className="mt-3 rounded-[var(--radius-prom)] border border-line bg-surface p-4 shadow-lg sm:absolute sm:right-0 sm:z-30 sm:w-80">
        {children}
      </div>
    </details>
  );
}

export function FormFeedback({ state }: { state: FormState }) {
  const t = useTranslate();
  if (state.status === 'idle' || !state.messageKey) {
    return null;
  }
  return (
    <Alert tone={state.status === 'error' ? 'danger' : 'success'} title={t(state.messageKey)} />
  );
}

export function SubmitButton({
  label,
  size = 'sm',
  variant,
  className,
}: {
  label: string;
  size?: 'sm' | 'md' | 'lg' | 'icon';
  variant?: 'secondary' | 'ghost' | 'danger' | 'outline';
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size={size}
      {...(variant ? { variant } : {})}
      {...(className ? { className } : {})}
      disabled={pending}
      aria-disabled={pending}
    >
      {label}
    </Button>
  );
}
