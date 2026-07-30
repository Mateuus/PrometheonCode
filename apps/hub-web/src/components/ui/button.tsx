import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Botão do design system. Vive aqui como código do projeto, não como dependência
 * opaca (regra do `Docs/03`), então variante nova se escreve neste arquivo.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-prom)] text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-foreground hover:bg-accent-hover',
        secondary: 'bg-surface-raised text-foreground border border-line hover:border-line-strong',
        outline: 'border border-line bg-transparent text-foreground hover:bg-surface-raised',
        ghost: 'bg-transparent text-muted hover:bg-surface-raised hover:text-foreground',
        link: 'bg-transparent text-link underline underline-offset-4 hover:no-underline',
        danger: 'bg-danger text-white hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-11 px-6 text-base',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Renderiza o filho no lugar do `<button>` — usado para links com aparência de botão. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
