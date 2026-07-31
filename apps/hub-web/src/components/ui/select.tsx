import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Seletor nativo.
 *
 * `<select>` de verdade em vez de um menu montado à mão: teclado, leitor de tela
 * e o seletor do sistema no celular já funcionam, e nenhum deles depende de
 * JavaScript ter carregado.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-10 w-full rounded-[var(--radius-prom)] border border-line bg-surface px-3 text-sm text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
