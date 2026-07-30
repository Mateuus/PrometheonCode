import { cn } from '@/lib/cn';

/**
 * Estado 1 de 7 — carregando.
 *
 * Esqueleto no formato do conteúdo que vai chegar, para a página não pular
 * quando os dados entram. `aria-busy` avisa o leitor de tela; o texto oculto dá
 * o que anunciar, já que barra cinza não se lê.
 */
export function LoadingState({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('space-y-3', className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-[var(--radius-prom)] border border-line bg-surface p-4"
        >
          <div className="h-3 w-1/3 rounded bg-surface-raised" />
          <div className="mt-3 h-2.5 w-2/3 rounded bg-surface-raised" />
          <div className="mt-2 h-2.5 w-1/2 rounded bg-surface-raised" />
        </div>
      ))}
    </div>
  );
}

/** Esqueleto de cartão isolado, para grades do painel. */
export function LoadingCard({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        'animate-pulse rounded-[var(--radius-prom)] border border-line bg-surface p-5',
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      <div className="h-3 w-24 rounded bg-surface-raised" />
      <div className="mt-4 h-6 w-16 rounded bg-surface-raised" />
    </div>
  );
}
