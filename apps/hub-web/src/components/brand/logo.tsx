import { cn } from '@/lib/cn';

/**
 * Marca do Prometheon: o prisma roxo com a chama.
 *
 * O roxo é a cor do produto e a chama é o agente principal — os mesmos papéis
 * da extensão. O SVG é inline para não depender de rede nem de otimizador de
 * imagem, e é decorativo: quem nomeia o produto é o texto ao lado.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
      className={cn('size-7', className)}
    >
      <path
        d="M16 2.5 28.5 9.75v14.5L16 31.5 3.5 24.25V9.75L16 2.5Z"
        fill="var(--accent-soft)"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M16 8.5c2.6 2.4 4 4.7 4 7 0 1.5-.6 2.7-1.6 3.6.2-1.4-.3-2.6-1.4-3.6.1 2.4-.8 4-2.7 5.3-1.4 1-2.1 2.1-2.1 3.4 0 .6.1 1.1.4 1.6-1.6-1-2.6-2.7-2.6-4.8 0-2 .9-3.8 2.6-5.4-.1 1 .2 1.8.9 2.4.3-3.8 1.5-6.6 2.5-9.5Z"
        fill="var(--running)"
      />
    </svg>
  );
}

/** Marca com o nome ao lado, para cabeçalhos. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Logo />
      <span className="text-sm font-semibold tracking-tight text-foreground">Prometheon</span>
    </span>
  );
}
