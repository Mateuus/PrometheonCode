'use client';

import { useTransition } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { setThemeAction, type ThemePreference } from '@/lib/actions/preference-actions';
import { cn } from '@/lib/cn';

/**
 * Alternador de tema.
 *
 * A escolha vai para um cookie via Server Action e volta como classe no
 * `<html>` — nada de escrever tema em `localStorage` nem de script inline, que
 * a CSP recusaria. Os três botões formam um `radiogroup`: o estado atual é
 * anunciado, não deduzido pela cor do botão.
 */
export function ThemeToggle({ current }: { current: ThemePreference }) {
  const t = useTranslate();
  const [pending, startTransition] = useTransition();

  const options: { value: ThemePreference; icon: typeof Sun; label: string }[] = [
    { value: 'light', icon: Sun, label: t('theme.light') },
    { value: 'dark', icon: Moon, label: t('theme.dark') },
    { value: 'system', icon: Monitor, label: t('theme.system') },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={t('theme.toggle')}
      className="inline-flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5"
    >
      {options.map(({ value, icon: Icon, label }) => {
        const active = value === current;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            disabled={pending}
            onClick={() => startTransition(() => setThemeAction(value))}
            className={cn(
              'flex size-7 items-center justify-center rounded-full transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:bg-surface-raised hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
