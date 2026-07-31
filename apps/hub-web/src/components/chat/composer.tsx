'use client';

import { useActionState, useEffect, useRef } from 'react';
import { Mic, MessageSquarePlus, Send, Square } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { useConnection } from '@/components/states/connection';
import { cn } from '@/lib/cn';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { createConversationAction, sendMessageAction } from '@/lib/actions/domain-actions';
import { Disclosure, FormFeedback, SubmitButton } from '@/components/forms/disclosure-form';
import {
  useLiveTranscription,
  type DictationError,
} from '@/lib/transcription/use-live-transcription';

/**
 * Chave de tradução de cada motivo de falha do ditado.
 *
 * `as const` e não uma anotação `Record<…, string>`: os valores precisam chegar
 * ao `t()` como literais, senão o compilador perde a garantia de que a chave
 * existe no catálogo — que é justamente o que impede uma frase nova de ir para
 * produção sem tradução.
 */
const DICTATION_ERROR_KEYS = {
  'permission-denied': 'chat.dictation.error.permissionDenied',
  'no-microphone': 'chat.dictation.error.noMicrophone',
  unsupported: 'chat.dictation.error.unsupported',
  'ticket-failed': 'chat.dictation.error.ticketFailed',
  'connection-failed': 'chat.dictation.error.connectionFailed',
  'service-unavailable': 'chat.dictation.error.serviceUnavailable',
} as const satisfies Record<DictationError, string>;

/**
 * Campo de escrita do chat.
 *
 * O envio é uma Server Action: a mensagem vai para
 * `POST /v1/conversations/:id/messages` com `parts: [{ type: 'text', ... }]`, e
 * a conversa é recarregada pelo evento `message.created` que volta pelo canal ao
 * vivo — inclusive nas outras abas.
 *
 * O que continua valendo do `Docs/05`: o Hub enfileira, e um agente local só
 * executa se um Core autorizado estiver online e aceitar o job. Sem Core, a
 * mensagem é gravada do mesmo jeito; o que a tela não faz é fingir que alguém
 * vai respondê-la.
 */
export function ChatComposer({
  conversationId,
  returnTo,
  coreOnline,
  canWrite,
}: {
  conversationId: string | undefined;
  returnTo: string;
  coreOnline: boolean;
  canWrite: boolean;
}) {
  const t = useTranslate();
  const { status } = useConnection();
  const [state, action] = useActionState<FormState, FormData>(sendMessageAction, idleFormState);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** O que já estava escrito quando o ditado começou. O ditado se soma a isso. */
  const baseTextRef = useRef('');
  const dictation = useLiveTranscription();

  const dictating = dictation.status !== 'idle';

  useEffect(() => {
    if (state.status === 'success') {
      formRef.current?.reset();
    }
  }, [state]);

  /**
   * Escreve o ditado no campo.
   *
   * Direto no nó, e não por estado do React: as revisões chegam a cada poucas
   * centenas de milissegundos, e passá-las por `useState` re-renderizaria o
   * formulário inteiro nesse ritmo. Escrever no `value` do textarea não
   * atravessa a reconciliação e mantém o campo não controlado, que é o que a
   * Server Action deste formulário espera.
   */
  useEffect(() => {
    const textarea = textareaRef.current;

    if (textarea === null || !dictating) {
      return;
    }

    const base = baseTextRef.current;
    textarea.value = base === '' ? dictation.transcript : `${base} ${dictation.transcript}`;
    // Mantém a última palavra à vista quando o texto passa da altura do campo.
    textarea.scrollTop = textarea.scrollHeight;
  }, [dictating, dictation.transcript]);

  const toggleDictation = (): void => {
    if (dictating) {
      dictation.stop();

      return;
    }

    baseTextRef.current = textareaRef.current?.value.trim() ?? '';
    dictation.start();
  };

  if (!canWrite) {
    return <Alert tone="info" title={t('chat.readOnly')} />;
  }
  if (!conversationId) {
    return <Alert tone="info" title={t('chat.error.noConversation')} />;
  }

  return (
    <div className="space-y-2">
      {coreOnline ? null : <Alert tone="alert" title={t('chat.noCoreOnline')} />}
      {status === 'offline' ? <Alert tone="alert" title={t('state.offline.title')} /> : null}
      {state.status === 'error' && state.messageKey ? (
        <Alert tone="danger" title={t(state.messageKey)} />
      ) : null}
      {dictation.error ? (
        <Alert tone="danger" title={t(DICTATION_ERROR_KEYS[dictation.error])} />
      ) : null}

      <form ref={formRef} action={action} className="flex items-end gap-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label className="flex-1">
          <span className="sr-only">{t('chat.placeholder')}</span>
          <Textarea
            ref={textareaRef}
            name="body"
            rows={2}
            required
            // Somente leitura enquanto o ditado corre: as revisões reescrevem o
            // campo inteiro a cada segundo, e uma correção digitada no meio
            // disso seria apagada pela revisão seguinte. O campo volta a aceitar
            // edição assim que o ditado para, com o texto todo lá para ajustar.
            readOnly={dictating}
            placeholder={t('chat.placeholder')}
            className={cn('min-h-16 resize-none', dictating && 'ring-2 ring-accent/50')}
          />
        </label>
        {dictation.supported ? (
          <Button
            type="button"
            size="icon"
            variant={dictating ? 'danger' : 'secondary'}
            onClick={toggleDictation}
            disabled={dictation.status === 'starting' || dictation.status === 'stopping'}
            aria-pressed={dictating}
          >
            {dictating ? <Square aria-hidden /> : <Mic aria-hidden />}
            <span className="sr-only">
              {t(dictating ? 'chat.dictation.stop' : 'chat.dictation.start')}
            </span>
          </Button>
        ) : null}
        <Button type="submit" size="icon" disabled={dictating}>
          <Send aria-hidden />
          <span className="sr-only">{t('action.send')}</span>
        </Button>
      </form>

      {/*
        `aria-live` porque a mudança acontece longe de onde o foco está: quem usa
        leitor de tela clicou no microfone e precisa saber que ele abriu, que
        está ouvindo, e quando parou.
      */}
      {dictating ? (
        <p aria-live="polite" className="flex items-center gap-2 text-xs text-muted">
          <span
            className={cn(
              'size-2 rounded-full',
              dictation.speaking ? 'animate-pulse bg-danger' : 'bg-muted',
            )}
            aria-hidden
          />
          {t(
            dictation.status === 'starting'
              ? 'chat.dictation.starting'
              : dictation.status === 'stopping'
                ? 'chat.dictation.stopping'
                : 'chat.dictation.listening',
          )}
        </p>
      ) : null}

      <p className="text-xs text-muted">{t('chat.localExecutionNotice')}</p>
    </div>
  );
}

/** Abre uma conversa nova. Ela nasce vazia: a API não aceita primeira mensagem. */
export function NewConversationForm({
  organizationSlug,
  projectId,
}: {
  organizationSlug: string;
  projectId: string;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(
    createConversationAction,
    idleFormState,
  );

  return (
    <Disclosure
      label={t('chat.newConversation')}
      icon={<MessageSquarePlus aria-hidden className="size-4" />}
    >
      <form action={action} className="space-y-3">
        <input type="hidden" name="organizationSlug" value={organizationSlug} />
        <input type="hidden" name="projectId" value={projectId} />
        <FormFeedback state={state} />

        <div className="space-y-1.5">
          <Label htmlFor="new-conversation-title">{t('chat.field.title')}</Label>
          <Input id="new-conversation-title" name="title" />
        </div>

        <SubmitButton label={t('action.create')} />
      </form>
    </Disclosure>
  );
}
