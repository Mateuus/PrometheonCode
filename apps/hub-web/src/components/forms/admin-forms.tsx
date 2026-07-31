'use client';

import { useActionState, type ReactNode } from 'react';
import { useTranslate } from '@/i18n/provider';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import {
  assignPlanAction,
  createPlanAction,
  updateLimitsAction,
  updatePlanAction,
} from '@/lib/actions/admin-actions';
import type { AdminOrganization, Plan, PlanLimits } from '@/lib/api/types';
import { Disclosure, FormFeedback, SubmitButton } from './disclosure-form';

/**
 * Formulários da administração da plataforma.
 *
 * A convenção dos limites aparece na tela inteira e vale a pena repetir onde
 * ela é digitada: **campo em branco herda**, `0` é sem teto. Nos planos, herdar
 * não faz sentido (não há de quem herdar), então em branco vale como zero.
 *
 * Armazenamento é digitado em GiB. O contrato é em bytes, e pedir bytes numa
 * caixa de texto é convite para errar uma casa decimal e liberar mil vezes mais
 * do que se pretendia.
 */

const GIB = 1_073_741_824;

/** Campos de limite, na ordem em que fazem sentido para quem compara. */
const LIMIT_FIELDS = [
  { name: 'maxMembers', labelKey: 'admin.plans.limit.members' },
  { name: 'maxProjects', labelKey: 'admin.plans.limit.projects' },
  { name: 'maxKnowledgeItems', labelKey: 'admin.plans.limit.knowledge' },
  { name: 'maxAgentRunsPerMonth', labelKey: 'admin.plans.limit.agentRuns' },
  { name: 'retentionDays', labelKey: 'admin.plans.limit.retention' },
] as const;

type LimitFieldName = (typeof LIMIT_FIELDS)[number]['name'];

function limitValue(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function storageValue(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '' : String(Math.round(bytes / GIB));
}

/** As seis caixas de limite, usadas tanto no plano quanto na exceção. */
function LimitFields({
  limits,
  idPrefix,
  placeholders,
}: {
  limits: Partial<Record<LimitFieldName, number | null>> & { maxStorageBytes?: number | null };
  idPrefix: string;
  /** Texto de apoio quando o campo em branco herda de algum lugar. */
  placeholders?: Partial<Record<LimitFieldName | 'maxStorageGib', string>>;
}) {
  const t = useTranslate();

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {LIMIT_FIELDS.map((field) => (
        <div key={field.name} className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-${field.name}`}>{t(field.labelKey)}</Label>
          <Input
            id={`${idPrefix}-${field.name}`}
            name={field.name}
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={limitValue(limits[field.name])}
            {...(placeholders?.[field.name] ? { placeholder: placeholders[field.name] } : {})}
          />
        </div>
      ))}

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-maxStorageGib`}>{t('admin.plans.limit.storageGib')}</Label>
        <Input
          id={`${idPrefix}-maxStorageGib`}
          name="maxStorageGib"
          inputMode="numeric"
          pattern="[0-9]*"
          defaultValue={storageValue(limits.maxStorageBytes)}
          {...(placeholders?.maxStorageGib ? { placeholder: placeholders.maxStorageGib } : {})}
        />
      </div>
    </div>
  );
}

function PlanFields({ plan }: { plan?: Plan }) {
  const t = useTranslate();
  const id = plan ? `plan-${plan.code}` : 'plan-new';

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>{t('admin.plans.form.name')}</Label>
          <Input id={`${id}-name`} name="name" defaultValue={plan?.name ?? ''} required />
        </div>

        {plan ? null : (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-code`}>{t('admin.plans.form.code')}</Label>
            <Input id={`${id}-code`} name="code" placeholder="studio" required />
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-price`}>{t('admin.plans.form.price')}</Label>
          <Input
            id={`${id}-price`}
            name="price"
            inputMode="decimal"
            defaultValue={plan ? (plan.price.amount / 100).toFixed(2) : '0'}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-currency`}>{t('admin.plans.form.currency')}</Label>
          <Input
            id={`${id}-currency`}
            name="currency"
            maxLength={3}
            defaultValue={plan?.price.currency ?? 'USD'}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-billingPeriod`}>{t('admin.plans.form.billingPeriod')}</Label>
          <Select
            id={`${id}-billingPeriod`}
            name="billingPeriod"
            defaultValue={plan?.billingPeriod ?? 'none'}
          >
            <option value="none">{t('admin.plans.period.none')}</option>
            <option value="monthly">{t('admin.plans.period.monthly')}</option>
            <option value="yearly">{t('admin.plans.period.yearly')}</option>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-description`}>{t('admin.plans.form.description')}</Label>
        <Textarea id={`${id}-description`} name="description" defaultValue={plan?.description ?? ''} />
      </div>

      <LimitFields limits={plan?.limits ?? {}} idPrefix={id} />

      <p className="text-xs text-muted">{t('admin.plans.form.zeroIsUnlimited')}</p>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={plan ? plan.isActive : true}
            className="size-4 accent-[var(--accent)]"
          />
          {t('admin.plans.form.active')}
        </label>

        {plan ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="isDefault"
              defaultChecked={plan.isDefault}
              className="size-4 accent-[var(--accent)]"
            />
            {t('admin.plans.form.default')}
          </label>
        ) : null}
      </div>
    </>
  );
}

/** Edita um plano existente. O código não muda: é o que as organizações apontam. */
export function UpdatePlanForm({ plan }: { plan: Plan }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(updatePlanAction, idleFormState);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="code" value={plan.code} />
      <FormFeedback state={state} />
      <PlanFields plan={plan} />
      <SubmitButton label={t('action.save')} />
    </form>
  );
}

export function CreatePlanForm() {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(createPlanAction, idleFormState);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('admin.plans.newTitle')}</CardTitle>
      </CardHeader>
      <form action={action}>
        <CardContent className="space-y-4">
          <FormFeedback state={state} />
          <PlanFields />
        </CardContent>
        <CardFooter>
          <SubmitButton label={t('admin.plans.create')} />
        </CardFooter>
      </form>
    </Card>
  );
}

/** Troca o plano de uma organização. */
export function AssignPlanForm({
  organization,
  plans,
}: {
  organization: AdminOrganization;
  plans: Plan[];
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(assignPlanAction, idleFormState);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="organizationId" value={organization.id} />
      <FormFeedback state={state} />

      <div className="space-y-1.5">
        <Label htmlFor={`assign-${organization.id}`}>{t('admin.organizations.plan')}</Label>
        <Select id={`assign-${organization.id}`} name="planCode" defaultValue={organization.planCode}>
          {plans.map((plan) => (
            <option key={plan.code} value={plan.code}>
              {plan.name}
              {plan.isActive ? '' : ` (${t('admin.plans.statusHidden')})`}
            </option>
          ))}
        </Select>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="allowOverLimit" className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          {t('admin.organizations.allowOverLimit')}
          <span className="block text-xs text-muted">
            {t('admin.organizations.allowOverLimitHint')}
          </span>
        </span>
      </label>

      <SubmitButton label={t('admin.organizations.assign')} />
    </form>
  );
}

/** Exceções de limite de uma organização. Em branco devolve o teto ao plano. */
export function OrganizationLimitsForm({ organization }: { organization: AdminOrganization }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(updateLimitsAction, idleFormState);

  const fromPlan = (value: number | null): string =>
    value === null ? t('admin.plans.unlimited') : String(value);

  const placeholders: Partial<Record<LimitFieldName | 'maxStorageGib', string>> = {
    maxMembers: fromPlan(organization.limits.maxMembers),
    maxProjects: fromPlan(organization.limits.maxProjects),
    maxKnowledgeItems: fromPlan(organization.limits.maxKnowledgeItems),
    maxAgentRunsPerMonth: fromPlan(organization.limits.maxAgentRunsPerMonth),
    retentionDays: fromPlan(organization.limits.retentionDays),
    maxStorageGib:
      organization.limits.maxStorageBytes === null
        ? t('admin.plans.unlimited')
        : String(Math.round(organization.limits.maxStorageBytes / GIB)),
  };

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="organizationId" value={organization.id} />
      <FormFeedback state={state} />

      <LimitFields
        limits={organization.overrides as Partial<PlanLimits>}
        idPrefix={`limits-${organization.id}`}
        placeholders={placeholders}
      />

      <p className="text-xs text-muted">{t('admin.organizations.overrideHint')}</p>

      <SubmitButton label={t('action.save')} />
    </form>
  );
}

/** Abre um formulário dentro de um `<details>`, sem modal nem JavaScript. */
export function AdminDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Disclosure label={label} className="sm:w-auto">
      <div className="sm:w-[26rem]">{children}</div>
    </Disclosure>
  );
}
