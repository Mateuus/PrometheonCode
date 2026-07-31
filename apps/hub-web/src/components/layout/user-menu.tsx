'use client';

import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { ChevronDown, KeyRound, LogOut, Shield, UserRound } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { logoutAction } from '@/lib/actions/auth-actions';

const itemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-accent-soft';

/**
 * Menu da conta. O Radix cuida do foco, do Escape e do anúncio do menu.
 *
 * O item de administração só aparece para quem administra a plataforma. Isso
 * não é autorização — a Hub API nega de novo em toda rota `/admin` — mas evitar
 * oferecer uma porta que bate na cara é o mínimo que a interface deve.
 */
export function UserMenu({
  name,
  email,
  isPlatformAdmin = false,
}: {
  name: string;
  email: string;
  isPlatformAdmin?: boolean;
}) {
  const t = useTranslate();
  const signOutForm = useRef<HTMLFormElement>(null);
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-2 text-sm text-foreground hover:border-line-strong">
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground"
        >
          {initials}
        </span>
        <span className="hidden max-w-32 truncate sm:inline">{name}</span>
        <ChevronDown aria-hidden className="size-3.5 text-muted" />
        <span className="sr-only">{t('nav.account')}</span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-56 rounded-[var(--radius-prom)] border border-line bg-surface p-1 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">{name}</p>
            <p className="truncate text-xs text-muted">{email}</p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />

          <DropdownMenu.Item asChild>
            <Link href="/settings/account" className={itemClass}>
              <UserRound aria-hidden className="size-4 text-muted" />
              {t('nav.account')}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/settings/sessions" className={itemClass}>
              <KeyRound aria-hidden className="size-4 text-muted" />
              {t('nav.sessions')}
            </Link>
          </DropdownMenu.Item>
          {isPlatformAdmin ? (
            <DropdownMenu.Item asChild>
              <Link href="/admin/plans" className={itemClass}>
                <Shield aria-hidden className="size-4 text-muted" />
                {t('nav.administration')}
              </Link>
            </DropdownMenu.Item>
          ) : null}

          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {/*
            Sair é o único item que não é um link.

            O menu fecha ao selecionar, e fechar desmonta o conteúdo antes de o
            clique nativo chegar ao `<button>` — o formulário nunca seria
            enviado. Por isso o envio é explícito: `onSelect` segura o
            fechamento e pede o submit. O `<form>` fica por fora do item para
            que o papel de `menuitem` caia em quem se ativa, e não no formulário.
          */}
          <form ref={signOutForm} action={logoutAction}>
            <DropdownMenu.Item
              className={itemClass}
              onSelect={(event) => {
                event.preventDefault();
                signOutForm.current?.requestSubmit();
              }}
            >
              <LogOut aria-hidden className="size-4 text-muted" />
              {t('action.signOut')}
            </DropdownMenu.Item>
          </form>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
