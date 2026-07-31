'use client';

import { useEffect } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { Button } from '@/components/ui/button';
import { StateBlock } from '@/components/states/state-block';

/**
 * Erro não tratado de uma tela.
 *
 * O `digest` é o que liga esta tela ao registro do servidor — mostrá-lo é o que
 * torna o relato de um usuário investigável. A mensagem crua do erro fica de
 * fora de propósito: ela pode conter detalhe interno.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslate();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <StateBlock
          icon={TriangleAlert}
          tone="danger"
          role="alert"
          title={t('state.error.title')}
          description={t('state.error.description')}
          {...(error.digest ? { detail: t('state.error.requestId', { requestId: error.digest }) } : {})}
          actions={
            <Button size="sm" variant="secondary" onClick={reset}>
              {t('action.retry')}
            </Button>
          }
        />
      </div>
    </div>
  );
}
