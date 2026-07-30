import type { ReactNode } from 'react';
import type { ApiResult } from '@/lib/api/result';
import type { MessageKey } from '@/i18n/catalog';
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  NotFoundState,
  OfflineState,
  UnauthorizedState,
} from './screen-states';
import { StaleDataBanner } from './stale-banner';

/**
 * Ponte entre a camada de dados e a tela.
 *
 * Uma tela entrega o `ApiResult` e diz o que fazer com o caso feliz; o resto dos
 * estados obrigatórios sai daqui. Como `ApiResult` é um tipo discriminado, não
 * existe caminho em que uma tela ignore o offline ou o sem permissão — ou ela
 * usa este componente, ou o TypeScript cobra os casos na mão.
 *
 * O estado de carregamento não passa por aqui: ele é do roteador (`loading.tsx`
 * e `<Suspense>`), porque em Server Components o dado ou já chegou, ou a árvore
 * ainda está suspensa.
 */
export async function DataView<T>({
  result,
  isEmpty,
  emptyTitleKey,
  emptyDescriptionKey,
  emptyDescription,
  emptyAction,
  retryHref,
  backHref,
  children,
}: {
  result: ApiResult<T>;
  /** Quando o caso feliz ainda assim não tem o que mostrar. */
  isEmpty?: (data: T) => boolean;
  emptyTitleKey?: MessageKey;
  emptyDescriptionKey?: MessageKey;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  retryHref?: string;
  backHref?: string;
  children: (data: T) => ReactNode;
}) {
  if (!result.ok) {
    switch (result.kind) {
      case 'offline':
        return <OfflineState {...(retryHref ? { retryHref } : {})} />;
      case 'forbidden':
        return <ForbiddenState {...(backHref ? { backHref } : {})} />;
      case 'unauthorized':
        return <UnauthorizedState />;
      case 'not-found':
        return <NotFoundState {...(backHref ? { backHref } : {})} />;
      case 'error':
        return <ErrorState requestId={result.requestId} {...(retryHref ? { retryHref } : {})} />;
    }
  }

  if (isEmpty?.(result.data)) {
    return (
      <EmptyState
        {...(emptyTitleKey ? { titleKey: emptyTitleKey } : {})}
        {...(emptyDescriptionKey ? { descriptionKey: emptyDescriptionKey } : {})}
        {...(emptyDescription ? { description: emptyDescription } : {})}
        {...(emptyAction ? { action: emptyAction } : {})}
      />
    );
  }

  return (
    <>
      {result.stale ? <StaleDataBanner fetchedAt={result.fetchedAt} /> : null}
      {children(result.data)}
    </>
  );
}
