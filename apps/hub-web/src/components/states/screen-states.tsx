import { CloudOff, Inbox, Lock, MailWarning, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslate } from '@/i18n/server';
import type { MessageKey } from '@/i18n/catalog';
import { Button } from '@/components/ui/button';
import { StateBlock } from './state-block';

/**
 * Estados 2 a 6 de 7, e o 404, como Server Components traduzidos.
 *
 * Cada um é uma peça só, usada por todas as telas. O `Docs/05` exige os sete
 * estados em toda tela; centralizá-los aqui é o que impede que uma tela nova
 * invente o seu próprio jeito de dizer "deu ruim".
 */

/** Estado 2 — vazio. Diz o que colocaria conteúdo ali, quando há o que dizer. */
export async function EmptyState({
  titleKey,
  descriptionKey,
  description,
  action,
}: {
  titleKey?: MessageKey;
  descriptionKey?: MessageKey;
  description?: string;
  action?: ReactNode;
}) {
  const t = await getTranslate();
  return (
    <StateBlock
      icon={Inbox}
      title={t(titleKey ?? 'state.empty.title')}
      description={description ?? t(descriptionKey ?? 'state.empty.description')}
      {...(action ? { actions: action } : {})}
    />
  );
}

/** Estado 3 — erro. Mostra o request ID porque é o que o suporte precisa. */
export async function ErrorState({
  requestId,
  retryHref,
}: {
  requestId?: string | undefined;
  retryHref?: string;
}) {
  const t = await getTranslate();
  return (
    <StateBlock
      icon={TriangleAlert}
      tone="danger"
      role="alert"
      title={t('state.error.title')}
      description={t('state.error.description')}
      {...(requestId ? { detail: t('state.error.requestId', { requestId }) } : {})}
      {...(retryHref
        ? {
            actions: (
              <Button asChild variant="secondary" size="sm">
                <Link href={retryHref}>{t('action.retry')}</Link>
              </Button>
            ),
          }
        : {})}
    />
  );
}

/** Estado 4 — offline. A tela não mente: nada foi carregado desta vez. */
export async function OfflineState({ retryHref }: { retryHref?: string }) {
  const t = await getTranslate();
  return (
    <StateBlock
      icon={CloudOff}
      tone="alert"
      title={t('state.offline.title')}
      description={t('state.offline.description')}
      {...(retryHref
        ? {
            actions: (
              <Button asChild variant="secondary" size="sm">
                <Link href={retryHref}>{t('action.retry')}</Link>
              </Button>
            ),
          }
        : {})}
    />
  );
}

/** Estado 5 — sem permissão. Quem decide isso é a API; aqui só se explica. */
export async function ForbiddenState({ backHref }: { backHref?: string }) {
  const t = await getTranslate();
  return (
    <StateBlock
      icon={ShieldAlert}
      tone="alert"
      title={t('state.forbidden.title')}
      description={t('state.forbidden.description')}
      {...(backHref
        ? {
            actions: (
              <Button asChild variant="secondary" size="sm">
                <Link href={backHref}>{t('action.goBack')}</Link>
              </Button>
            ),
          }
        : {})}
    />
  );
}

/** Sessão expirada — leva de volta ao login em vez de fingir que está tudo bem. */
export async function UnauthorizedState({ loginHref = '/login' }: { loginHref?: string }) {
  const t = await getTranslate();
  return (
    <StateBlock
      icon={Lock}
      tone="accent"
      title={t('state.unauthorized.title')}
      description={t('state.unauthorized.description')}
      actions={
        <Button asChild size="sm">
          <Link href={loginHref}>{t('action.signIn')}</Link>
        </Button>
      }
    />
  );
}

/**
 * E-mail não confirmado.
 *
 * A API deixa entrar sem confirmação, mas recusa qualquer escrita com
 * `EMAIL_NOT_VERIFIED`. Mostrar "algo deu errado" aqui seria esconder a única
 * informação útil, que é o que fazer a seguir.
 */
export async function EmailUnverifiedState() {
  const t = await getTranslate();
  return (
    <StateBlock
      icon={MailWarning}
      tone="alert"
      title={t('auth.verify.requiredToWrite')}
      description={t('auth.verify.description')}
      actions={
        <Button asChild size="sm">
          <Link href="/verify-email">{t('auth.verify.action')}</Link>
        </Button>
      }
    />
  );
}

/** Recurso inexistente, distinguido do erro genérico. */
export async function NotFoundState({ backHref = '/app' }: { backHref?: string }) {
  const t = await getTranslate();
  return (
    <StateBlock
      icon={RotateCcw}
      title={t('state.notFound.title')}
      description={t('state.notFound.description')}
      actions={
        <Button asChild variant="secondary" size="sm">
          <Link href={backHref}>{t('action.goToDashboard')}</Link>
        </Button>
      }
    />
  );
}
