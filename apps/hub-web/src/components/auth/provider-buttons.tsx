import Link from 'next/link';
import { getTranslate } from '@/i18n/server';
import { env } from '@/lib/env';

/**
 * Entrada pelos provedores externos.
 *
 * É um link comum, não um botão com JavaScript: o fluxo é uma navegação de
 * verdade até o GitHub e de volta. Um `fetch` não conseguiria levar a pessoa à
 * tela de consentimento, que é o passo em que ela decide.
 *
 * O componente some inteiro quando nenhum provedor está configurado. Mostrar um
 * botão que responde "este Hub não oferece isso" seria pior do que não mostrar
 * nada — quem monta o Hub sem provedor não quer a opção na tela.
 */
export async function ProviderButtons({ next }: { next: string }) {
  const t = await getTranslate();
  const { HUB_API_URL, GITHUB_OAUTH_CLIENT_ID } = env();

  if (GITHUB_OAUTH_CLIENT_ID === undefined) {
    return null;
  }

  const href = new URL('/v1/auth/oauth/github', HUB_API_URL);

  href.searchParams.set('redirectTo', next);

  return (
    <div className="space-y-3">
      <Link
        href={href.toString()}
        // Navegação externa: o roteador do Next não deve tentar tratar isso
        // como transição interna.
        prefetch={false}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-foreground transition hover:border-accent hover:text-accent"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="size-4 fill-current">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        {t('auth.provider.github')}
      </Link>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs uppercase tracking-wide text-muted">{t('auth.provider.or')}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}
