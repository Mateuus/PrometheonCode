'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { deleteOrganization, updateOrganization } from '@/lib/api/commands';
import { resolveOrganizationId } from '@/lib/api/queries';
import type { ApiFailure } from '@/lib/api/result';
import { formError, formSuccess, type FormState } from './form-state';

/**
 * Edição e exclusão da organização.
 *
 * O slug é o endereço em `/app/<slug>`: trocá-lo muda a URL de todo link salvo,
 * então ele só vai para a API quando muda de fato. E, como a rota atual passa a
 * apontar para lugar nenhum depois da troca, a action redireciona para o
 * endereço novo em vez de revalidar o antigo.
 */

function translateFailure(failure: ApiFailure): FormState {
  switch (failure.kind) {
    case 'offline':
      return formError('auth.error.offline');
    case 'unauthorized':
      return formError('state.unauthorized.title');
    case 'email-unverified':
      return formError('auth.verify.requiredToWrite');
    case 'forbidden':
      return formError('state.forbidden.title');
    default:
      return formError('auth.error.generic');
  }
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

function version(formData: FormData): number | undefined {
  const raw = text(formData, 'version');

  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

export async function updateOrganizationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const currentSlug = text(formData, 'currentSlug');
  const name = text(formData, 'name');
  const slug = text(formData, 'slug').toLowerCase();
  const read = version(formData);

  if (name === '') {
    return formError('organizationSettings.error.nameRequired', {
      name: 'organizationSettings.error.nameRequired',
    });
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return formError('organizationSettings.error.slugInvalid', {
      slug: 'organizationSettings.error.slugInvalid',
    });
  }
  if (read === undefined) {
    return formError('auth.error.generic');
  }

  const organizationId = await resolveOrganizationId(currentSlug);

  if (!organizationId.ok) {
    return translateFailure(organizationId);
  }

  const updated = await updateOrganization(organizationId.data, {
    name,
    ...(slug === currentSlug ? {} : { slug }),
    version: read,
  });

  if (!updated.ok) {
    if (updated.code === 'VERSION_CONFLICT') {
      return formError('organizationSettings.error.versionConflict');
    }
    if (updated.code === 'CONFLICT') {
      return formError('organizationSettings.error.slugTaken', {
        slug: 'organizationSettings.error.slugTaken',
      });
    }

    return translateFailure(updated);
  }

  // O endereço mudou: a rota atual já não existe, e revalidar o caminho antigo
  // deixaria a pessoa numa página que a próxima navegação transforma em 404.
  if (updated.data.slug !== currentSlug) {
    revalidatePath('/', 'layout');
    redirect(`/app/${updated.data.slug}/settings`);
  }

  revalidatePath(`/app/${currentSlug}`, 'layout');

  return formSuccess('organizationSettings.saved');
}

export async function deleteOrganizationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const currentSlug = text(formData, 'currentSlug');
  const confirmation = text(formData, 'confirmation').toLowerCase();
  const read = version(formData);

  if (read === undefined) {
    return formError('auth.error.generic');
  }

  // A confirmação é conferida aqui e de novo na API: a tela evita o clique
  // errado, e o servidor evita a chamada direta que pulou a tela.
  if (confirmation !== currentSlug) {
    return formError('organizationSettings.error.confirmationMismatch', {
      confirmation: 'organizationSettings.error.confirmationMismatch',
    });
  }

  const organizationId = await resolveOrganizationId(currentSlug);

  if (!organizationId.ok) {
    return translateFailure(organizationId);
  }

  const removed = await deleteOrganization(organizationId.data, {
    slug: currentSlug,
    version: read,
  });

  if (!removed.ok) {
    return removed.code === 'VERSION_CONFLICT'
      ? formError('organizationSettings.error.versionConflict')
      : translateFailure(removed);
  }

  revalidatePath('/', 'layout');
  redirect('/app');
}
