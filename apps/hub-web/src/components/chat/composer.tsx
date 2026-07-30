'use client';

import { useActionState, useEffect, useRef } from 'react';
import { MessageSquarePlus, Send } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { useConnection } from '@/components/states/connection';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { createConversationAction, sendMessageAction } from '@/lib/actions/domain-actions';
import { Disclosure, FormFeedback, SubmitButton } from '@/components/forms/disclosure-form';

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

  useEffect(() => {
    if (state.status === 'success') {
      formRef.current?.reset();
    }
  }, [state]);

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

      <form ref={formRef} action={action} className="flex items-end gap-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label className="flex-1">
          <span className="sr-only">{t('chat.placeholder')}</span>
          <Textarea
            name="body"
            rows={2}
            required
            placeholder={t('chat.placeholder')}
            className="min-h-16 resize-none"
          />
        </label>
        <Button type="submit" size="icon">
          <Send aria-hidden />
          <span className="sr-only">{t('action.send')}</span>
        </Button>
      </form>

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
