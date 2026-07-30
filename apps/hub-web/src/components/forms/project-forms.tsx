'use client';

import { useActionState, useId } from 'react';
import { Plus } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { createProjectAction } from '@/lib/actions/domain-actions';
import { Disclosure, FormFeedback, SubmitButton } from './disclosure-form';

/**
 * Cria um projeto na organização. Quem não tem `project.create` não vê isto.
 *
 * O id dos campos vem de `useId` porque a mesma tela mostra este formulário
 * duas vezes — no cabeçalho e no estado vazio. Dois `id` iguais quebrariam o
 * `<label for>` e o leitor de tela leria o campo errado.
 */
export function CreateProjectForm({ organizationSlug }: { organizationSlug: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(createProjectAction, idleFormState);
  const id = useId();

  return (
    <Disclosure label={t('projects.create')} icon={<Plus aria-hidden className="size-4" />}>
      <form action={action} className="space-y-3">
        <input type="hidden" name="organizationSlug" value={organizationSlug} />
        <FormFeedback state={state} />

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>{t('projectSettings.name')}</Label>
          <Input
            id={`${id}-name`}
            name="name"
            required
            aria-invalid={state.fieldErrors?.name ? true : undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-description`}>{t('projectSettings.description')}</Label>
          <Textarea id={`${id}-description`} name="description" rows={2} />
        </div>

        <SubmitButton label={t('action.create')} />
      </form>
    </Disclosure>
  );
}
