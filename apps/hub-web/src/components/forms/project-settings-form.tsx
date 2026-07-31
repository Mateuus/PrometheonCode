'use client';

import { useActionState } from 'react';
import { useTranslate } from '@/i18n/provider';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { updateProjectAction } from '@/lib/actions/domain-actions';
import { FormFeedback, SubmitButton } from './disclosure-form';

/**
 * Edita nome e descrição do projeto.
 *
 * `version` viaja num campo escondido porque a API usa concorrência otimista:
 * salvar por cima de uma alteração alheia devolve `VERSION_CONFLICT` em vez de
 * apagar em silêncio o que a outra pessoa escreveu.
 */
export function UpdateProjectForm({
  projectId,
  name,
  description,
  version,
  returnTo,
}: {
  projectId: string;
  name: string;
  description: string;
  version: number;
  returnTo: string;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(updateProjectAction, idleFormState);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="returnTo" value={returnTo} />

      <Card>
        <CardHeader>
          <CardTitle>{t('projectSettings.general')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormFeedback state={state} />

          <div className="space-y-1.5">
            <Label htmlFor="project-name">{t('projectSettings.name')}</Label>
            <Input
              id="project-name"
              name="name"
              defaultValue={name}
              required
              aria-invalid={state.fieldErrors?.name ? true : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-description">{t('projectSettings.description')}</Label>
            <Textarea id="project-description" name="description" defaultValue={description} />
          </div>
        </CardContent>
        <CardFooter>
          <SubmitButton label={t('action.save')} />
        </CardFooter>
      </Card>
    </form>
  );
}
