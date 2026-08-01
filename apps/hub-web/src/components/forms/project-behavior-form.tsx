'use client';

import { useActionState } from 'react';
import { useTranslate } from '@/i18n/provider';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { updateProjectBehaviorAction } from '@/lib/actions/domain-actions';
import type { ProjectSettings } from '@/lib/api/types';
import { FormFeedback, SubmitButton } from './disclosure-form';

/**
 * Edita o comportamento do projeto — os mesmos valores que a visão geral exibe
 * no card "Behaviour", agora graváveis.
 *
 * `version` viaja escondida pelo mesmo motivo do formulário geral: a API usa
 * concorrência otimista, e salvar por cima de uma alteração alheia devolve
 * `VERSION_CONFLICT` em vez de apagar em silêncio o que a outra pessoa fez.
 *
 * A autonomia só oferece `manual` e `auto`. `bypass` fica de fora de propósito
 * (`projectSettingsSchema` no contrato): ele é local e temporário por desenho,
 * e um seletor que o gravasse como padrão seria o jeito de torná-lo permanente.
 */
export function ProjectBehaviorForm({
  projectId,
  settings,
  version,
  projectPath,
}: {
  projectId: string;
  settings: ProjectSettings;
  version: number;
  /** Base da visão geral; a action revalida essa página e a de configurações. */
  projectPath: string;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(
    updateProjectBehaviorAction,
    idleFormState,
  );

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="projectPath" value={projectPath} />

      <Card>
        <CardHeader>
          <CardTitle>{t('projectSettings.behaviour')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormFeedback state={state} />

          <div className="space-y-1.5">
            <Label htmlFor="behavior-work-mode">{t('projectSettings.workMode')}</Label>
            <Select
              id="behavior-work-mode"
              name="defaultWorkMode"
              defaultValue={settings.defaultWorkMode}
            >
              {/* Valores do contrato (`WORK_MODES`); os rótulos são os mesmos da visão geral. */}
              <option value="plan">{t('chat.mode.plan')}</option>
              <option value="edit">{t('chat.mode.edit')}</option>
              <option value="agent_team">{t('chat.mode.agentTeam')}</option>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="behavior-autonomy">{t('projectSettings.autonomy')}</Label>
            <Select
              id="behavior-autonomy"
              name="defaultAutonomy"
              defaultValue={settings.defaultAutonomy}
            >
              <option value="manual">{t('projectSettings.autonomy.manual')}</option>
              <option value="auto">{t('projectSettings.autonomy.auto')}</option>
            </Select>
            <p className="text-xs text-muted">{t('projectSettings.autonomy.bypassNote')}</p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="requireReview"
              defaultChecked={settings.requireReview}
              className="mt-0.5 size-4 accent-[var(--accent)]"
            />
            <span>
              {t('projectSettings.requireReview')}
              <span className="block text-xs text-muted">
                {t('projectSettings.requireReview.hint')}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="allowRemoteAgents"
              defaultChecked={settings.allowRemoteAgents}
              className="mt-0.5 size-4 accent-[var(--accent)]"
            />
            <span>
              {t('projectSettings.remoteAgents')}
              <span className="block text-xs text-muted">
                {t('projectSettings.remoteAgents.hint')}
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="behavior-context-budget">{t('projectSettings.contextBudget')}</Label>
            <Input
              id="behavior-context-budget"
              name="contextBudgetTokens"
              type="number"
              inputMode="numeric"
              min={1}
              max={10_000_000}
              step={1}
              required
              defaultValue={settings.contextBudgetTokens}
              aria-invalid={state.fieldErrors?.contextBudgetTokens ? true : undefined}
            />
            <p className="text-xs text-muted">{t('projectSettings.contextBudget.hint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="behavior-retention">{t('projectSettings.retention')}</Label>
            <Input
              id="behavior-retention"
              name="conversationRetentionDays"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              step={1}
              defaultValue={settings.conversationRetentionDays ?? ''}
              aria-invalid={state.fieldErrors?.conversationRetentionDays ? true : undefined}
            />
            <p className="text-xs text-muted">{t('projectSettings.retention.hint')}</p>
          </div>
        </CardContent>
        <CardFooter>
          <SubmitButton label={t('projectSettings.saveBehaviour')} />
        </CardFooter>
      </Card>
    </form>
  );
}
