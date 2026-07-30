'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Item de navegação.
 *
 * A página atual é marcada com `aria-current`, não só com um fundo diferente —
 * a mesma regra de "status nunca só por cor" vale para "onde eu estou". O ícone
 * chega como elemento pronto, para o servidor decidir qual é sem que o cliente
 * precise carregar a biblioteca inteira de ícones.
 */
export function NavLink({
  href,
  icon,
  children,
  exact = false,
  badge,
}: {
  href: string;
  icon?: ReactNode;
  children: ReactNode;
  exact?: boolean;
  badge?: ReactNode;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-[var(--radius-prom)] px-2.5 py-2 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        active
          ? 'bg-accent-soft font-medium text-foreground [&_svg]:text-accent'
          : 'text-muted hover:bg-surface-raised hover:text-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {badge}
    </Link>
  );
}

/** Aba horizontal, usada nas seções de um projeto. */
export function TabLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href;

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative -mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
        active
          ? 'border-accent font-medium text-foreground'
          : 'border-transparent text-muted hover:border-line-strong hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}
