'use server';

import { revalidatePath } from 'next/cache';
import {
  assignPlan,
  createPlan,
  updateOrganizationLimits,
  updatePlan,
  type PlanLimitsInput,
} from '@/lib/api/commands';
import type { ApiFailure } from '@/lib/api/result';
import { formError, formSuccess, type FormState } from './form-state';

/**
 * Escritas da administração da plataforma.
 *
 * Nenhuma delas decide quem pode: a Hub API exige a marca de administrador da
 * plataforma e responde 403 a quem não a tem. O que existe aqui é a tradução da
 * entrada do formulário para o corpo do comando — e é onde mora a única regra
 * de interface que importa nesta tela: **campo vazio não é zero**.
 *
 * Nos limites, os três estados são diferentes e precisam continuar diferentes
 * até a API:
 *
 * - campo em branco → `null`: volte a valer o que o plano diz;
 * - `0` → sem teto;
 * - qualquer outro número → esse é o teto.
 */

function translateFailure(failure: ApiFailure): FormState {
  switch (failure.kind) {
    case 'offline':
      return formError('auth.error.offline');
    case 'unauthorized':
      return formError('state.unauthorized.title');
    case 'forbidden':
      return formError('state.forbidden.title');
    default:
      return formError(
        failure.code === 'PLAN_LIMIT_EXCEEDED' ? 'admin.error.overLimit' : 'auth.error.generic',
      );
  }
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === 'on' || formData.get(name) === 'true';
}

/** Inteiro não negativo; `undefined` quando o campo não é número. */
function integer(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Um GiB em bytes. O formulário fala em GiB; o contrato, em bytes. */
const GIB = 1_073_741_824;

/**
 * Lê os seis limites do formulário.
 *
 * Devolve `null` para o campo em branco e ignora o que não for número — um
 * "abc" digitado por engano não pode virar teto zero, que significa ilimitado.
 */
function readLimits(formData: FormData): PlanLimitsInput {
  const limits: PlanLimitsInput = {};

  for (const field of [
    'maxMembers',
    'maxProjects',
    'maxKnowledgeItems',
    'maxAgentRunsPerMonth',
    'retentionDays',
  ] as const) {
    const raw = text(formData, field);

    if (raw === '') {
      limits[field] = null;
      continue;
    }

    const parsed = integer(raw);

    if (parsed !== undefined) {
      limits[field] = parsed;
    }
  }

  const storage = text(formData, 'maxStorageGib');

  if (storage === '') {
    limits.maxStorageBytes = null;
  } else {
    const parsed = integer(storage);

    if (parsed !== undefined) {
      limits.maxStorageBytes = parsed * GIB;
    }
  }

  return limits;
}

/** Preço digitado na moeda cheia, guardado na menor unidade dela. */
function readPriceCents(value: string): number | undefined {
  if (!/^\d+([.,]\d{1,2})?$/.test(value)) {
    return undefined;
  }

  return Math.round(Number(value.replace(',', '.')) * 100);
}

// --------------------------------------------------------------------- planos

export async function createPlanAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = text(formData, 'code').toLowerCase();
  const name = text(formData, 'name');
  const price = text(formData, 'price');

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(code)) {
    return formError('admin.error.codeInvalid', { code: 'admin.error.codeInvalid' });
  }
  if (name === '') {
    return formError('admin.error.nameRequired', { name: 'admin.error.nameRequired' });
  }

  const priceCents = price === '' ? 0 : readPriceCents(price);

  if (priceCents === undefined) {
    return formError('admin.error.priceInvalid', { price: 'admin.error.priceInvalid' });
  }

  const description = text(formData, 'description');
  const billingPeriod = text(formData, 'billingPeriod');

  const created = await createPlan({
    code,
    name,
    ...(description === '' ? {} : { description }),
    priceCents,
    currency: (text(formData, 'currency') || 'USD').toUpperCase(),
    billingPeriod:
      billingPeriod === 'monthly' || billingPeriod === 'yearly' ? billingPeriod : 'none',
    limits: readLimits(formData),
    isActive: checked(formData, 'isActive'),
  });

  if (!created.ok) {
    return created.code === 'CONFLICT'
      ? formError('admin.error.codeTaken', { code: 'admin.error.codeTaken' })
      : translateFailure(created);
  }

  revalidatePath('/admin/plans');

  return formSuccess('admin.plans.created');
}

export async function updatePlanAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = text(formData, 'code');
  const name = text(formData, 'name');
  const price = text(formData, 'price');

  if (name === '') {
    return formError('admin.error.nameRequired', { name: 'admin.error.nameRequired' });
  }

  const priceCents = price === '' ? 0 : readPriceCents(price);

  if (priceCents === undefined) {
    return formError('admin.error.priceInvalid', { price: 'admin.error.priceInvalid' });
  }

  const description = text(formData, 'description');
  const billingPeriod = text(formData, 'billingPeriod');

  const updated = await updatePlan(code, {
    name,
    description: description === '' ? null : description,
    priceCents,
    currency: (text(formData, 'currency') || 'USD').toUpperCase(),
    billingPeriod:
      billingPeriod === 'monthly' || billingPeriod === 'yearly' ? billingPeriod : 'none',
    limits: readLimits(formData),
    isActive: checked(formData, 'isActive'),
    isDefault: checked(formData, 'isDefault'),
  });

  if (!updated.ok) {
    return translateFailure(updated);
  }

  revalidatePath('/admin/plans');
  revalidatePath('/admin/organizations');

  return formSuccess('admin.plans.saved');
}

// -------------------------------------------------------------- organizações

export async function assignPlanAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const organizationId = text(formData, 'organizationId');
  const planCode = text(formData, 'planCode');

  if (organizationId === '' || planCode === '') {
    return formError('auth.error.generic');
  }

  const assigned = await assignPlan(organizationId, {
    planCode,
    allowOverLimit: checked(formData, 'allowOverLimit'),
  });

  if (!assigned.ok) {
    return translateFailure(assigned);
  }

  revalidatePath('/admin/organizations');

  return formSuccess('admin.organizations.planAssigned');
}

export async function updateLimitsAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const organizationId = text(formData, 'organizationId');

  if (organizationId === '') {
    return formError('auth.error.generic');
  }

  const updated = await updateOrganizationLimits(organizationId, readLimits(formData));

  if (!updated.ok) {
    return translateFailure(updated);
  }

  revalidatePath('/admin/organizations');

  return formSuccess('admin.organizations.limitsSaved');
}
