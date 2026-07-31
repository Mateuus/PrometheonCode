'use client';

import { useActionState } from 'react';
import { useTranslate } from '@/i18n/provider';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import {
  deleteOrganizationAction,
  updateOrganizationAction,
} from '@/lib/actions/organization-actions';
import { FormFeedback, SubmitButton } from './disclosure-form';

/**
 * Identidade da organização e o botão que não tem volta.
 *
 * `version` viaja escondido porque a API usa concorrência otimista: salvar por
 * cima da edição de outra pessoa devolve conflito em vez de apagá-la.
 */
export function UpdateOrganizationForm({
  name,
  slug,
  version,
}: {
  name: string;
  slug: string;
  version: number;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(
    updateOrganizationAction,
    idleFormState,
  );

  return (
    <form action={action}>
      <input type="hidden" name="currentSlug" value={slug} />
      <input type="hidden" name="version" value={version} />

      <Card>
        <CardHeader>
          <CardTitle>{t('organizationSettings.general')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormFeedback state={state} />

          <div className="space-y-1.5">
            <Label htmlFor="organization-name">{t('organizationSettings.name')}</Label>
            <Input
              id="organization-name"
              name="name"
              defaultValue={name}
              required
              aria-invalid={state.fieldErrors?.name ? true : undefined}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="organization-slug">{t('organizationSettings.slug')}</Label>
            <Input
              id="organization-slug"
              name="slug"
              defaultValue={slug}
              required
              aria-invalid={state.fieldErrors?.slug ? true : undefined}
              aria-describedby="organization-slug-hint"
            />
            <p id="organization-slug-hint" className="text-xs text-muted">
              {t('organizationSettings.slugHint')}
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <SubmitButton label={t('action.save')} />
        </CardFooter>
      </Card>
    </form>
  );
}

/**
 * Exclusão da organização.
 *
 * Pede o endereço digitado de novo — a mesma confirmação que a API exige. É a
 * única barreira entre um clique errado e a saída de projetos, conversas e do
 * conhecimento da equipe de todas as telas.
 */
export function DeleteOrganizationForm({ slug, version }: { slug: string; version: number }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(
    deleteOrganizationAction,
    idleFormState,
  );

  return (
    <form action={action}>
      <input type="hidden" name="currentSlug" value={slug} />
      <input type="hidden" name="version" value={version} />

      <Card className="border-[var(--danger,#b42318)]/40">
        <CardHeader>
          <CardTitle>{t('organizationSettings.dangerZone')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormFeedback state={state} />

          <p className="text-sm text-muted">{t('organizationSettings.deleteWarning')}</p>

          <div className="space-y-1.5">
            <Label htmlFor="organization-confirmation">
              {t('organizationSettings.confirmWith', { slug })}
            </Label>
            <Input
              id="organization-confirmation"
              name="confirmation"
              autoComplete="off"
              required
              aria-invalid={state.fieldErrors?.confirmation ? true : undefined}
            />
          </div>
        </CardContent>
        <CardFooter>
          <SubmitButton label={t('organizationSettings.delete')} variant="danger" />
        </CardFooter>
      </Card>
    </form>
  );
}
