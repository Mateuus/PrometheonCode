'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { useConnection } from '@/components/states/connection';

/**
 * Campo de escrita do chat.
 *
 * PROVISÓRIO no envio: sem a Hub API não há para onde mandar, então o botão fica
 * desabilitado e a tela **diz** que fica. É a diferença entre uma interface
 * honesta e uma que finge ter enviado.
 *
 * Quando a API existir, o envio vira uma Server Action; a regra do `Docs/05`
 * continua a mesma: o Hub enfileira, e um agente local só executa se um Core
 * autorizado estiver online e aceitar o job.
 */
export function ChatComposer({ coreOnline }: { coreOnline: boolean }) {
  const t = useTranslate();
  const { status } = useConnection();
  const [value, setValue] = useState('');

  const blocked = !coreOnline || status !== 'online';

  return (
    <div className="space-y-2">
      {blocked ? <Alert tone="alert" title={t('chat.noCoreOnline')} /> : null}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setValue('');
        }}
      >
        <label className="flex-1">
          <span className="sr-only">{t('chat.placeholder')}</span>
          <Textarea
            rows={2}
            value={value}
            placeholder={t('chat.placeholder')}
            onChange={(event) => setValue(event.target.value)}
            className="min-h-16 resize-none"
          />
        </label>
        <Button type="submit" size="icon" disabled={blocked || value.trim() === ''}>
          <Send aria-hidden />
          <span className="sr-only">{t('action.send')}</span>
        </Button>
      </form>

      <p className="text-xs text-muted">{t('chat.localExecutionNotice')}</p>
    </div>
  );
}
