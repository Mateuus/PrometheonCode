'use client';

import { useActionState, useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { switchOrganizationAction } from '@/lib/actions/auth-actions';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { FormFeedback, SubmitButton } from '@/components/forms/disclosure-form';

const itemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-accent-soft';

export interface SwitchableOrganization {
  id: string;
  name: string;
  slug: string;
}

/**
 * Seletor da organização ativa da sessão.
 *
 * Não é navegação: cada item **reemite a sessão** com o escopo da organização
 * escolhida, porque o claim `org` vive dentro do access token e é ele que a API
 * usa nas rotas sem `:orgId` — a auditoria, entre elas. Por isso cada item é um
 * `<form>` e não um `<Link>`.
 *
 * O seletor só aparece com mais de uma organização; com uma só, não há nada a
 * escolher e o cabeçalho não ganha um controle inerte.
 */
export function OrganizationSwitcher({
  organizations,
  activeOrganizationId,
  next,
}: {
  organizations: SwitchableOrganization[];
  activeOrganizationId: string | null;
  /** Para onde voltar depois da troca. */
  next?: string;
}) {
  const t = useTranslate();
  const forms = useRef(new Map<string, HTMLFormElement>());
  // Um estado para o menu inteiro: cada item manda o seu `organizationId` no
  // próprio formulário, e só uma troca acontece por vez.
  const [state, action] = useActionState<FormState, FormData>(
    switchOrganizationAction,
    idleFormState,
  );

  if (organizations.length < 2) {
    return null;
  }

  const active = organizations.find((item) => item.id === activeOrganizationId);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex items-center gap-2 rounded-[var(--radius-prom)] border border-line bg-surface px-2 py-1 text-sm text-foreground hover:border-line-strong">
        <Building2 aria-hidden className="size-3.5 text-muted" />
        <span className="hidden max-w-32 truncate sm:inline">
          {active?.name ?? t('organizations.switch')}
        </span>
        <ChevronDown aria-hidden className="size-3.5 text-muted" />
        <span className="sr-only">{t('organizations.switch')}</span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-64 rounded-[var(--radius-prom)] border border-line bg-surface p-1 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="text-sm font-medium text-foreground">{t('organizations.switch')}</p>
            <p className="text-xs text-muted">{t('organizations.switchHint')}</p>
          </div>
          {state.status === 'error' && state.messageKey ? (
            <p className="px-2 pb-1.5 text-xs text-danger">{t(state.messageKey)}</p>
          ) : null}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />

          {organizations.map((organization) => {
            const current = organization.id === activeOrganizationId;

            return (
              /*
                Mesma armadilha do menu da conta: o Radix desmonta o conteúdo ao
                selecionar, e o clique nativo nunca chegaria ao botão. Por isso
                `onSelect` segura o fechamento e pede o envio.
              */
              <form
                key={organization.id}
                ref={(node) => {
                  if (node) {
                    forms.current.set(organization.id, node);
                  } else {
                    forms.current.delete(organization.id);
                  }
                }}
                action={action}
              >
                <input type="hidden" name="organizationId" value={organization.id} />
                <input type="hidden" name="next" value={next ?? `/app/${organization.slug}`} />
                <DropdownMenu.Item
                  className={itemClass}
                  disabled={current}
                  onSelect={(event) => {
                    event.preventDefault();
                    if (!current) {
                      forms.current.get(organization.id)?.requestSubmit();
                    }
                  }}
                >
                  <Check
                    aria-hidden
                    className={current ? 'size-4 text-accent' : 'size-4 text-transparent'}
                  />
                  <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  {current ? (
                    <span className="sr-only">{t('account.activeOrganization')}</span>
                  ) : null}
                </DropdownMenu.Item>
              </form>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Botão avulso que ancora a sessão numa organização específica.
 *
 * Existe para as telas que descobrem o descompasso sozinhas — a auditoria é a
 * primeira, porque `GET /v1/audit` resolve a organização pelo token. Avisar sem
 * oferecer a correção deixaria o usuário sem saída.
 */
export function SwitchToOrganizationButton({
  organizationId,
  next,
  label,
}: {
  organizationId: string;
  next: string;
  label: string;
}) {
  const [state, action] = useActionState<FormState, FormData>(
    switchOrganizationAction,
    idleFormState,
  );

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="next" value={next} />
      <FormFeedback state={state} />
      <SubmitButton label={label} variant="secondary" />
    </form>
  );
}
