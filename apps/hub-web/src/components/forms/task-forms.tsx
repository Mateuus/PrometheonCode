'use client';

import { useActionState } from 'react';
import { Plus } from 'lucide-react';
import { TASK_PRIORITIES } from '@prometheon/contracts';
import { useTranslate } from '@/i18n/provider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { createTaskAction, updateTaskStatusAction } from '@/lib/actions/domain-actions';
import { taskPriorityLabel, taskStatusBadge } from '@/lib/status-badges';
import type { TaskStatus } from '@/lib/api/types';
import { Disclosure, FormFeedback, SubmitButton } from './disclosure-form';

export function CreateTaskForm({
  projectId,
  returnTo,
}: {
  projectId: string;
  returnTo: string;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(createTaskAction, idleFormState);

  return (
    <Disclosure label={t('tasks.create')} icon={<Plus aria-hidden className="size-4" />}>
      <form action={action} className="space-y-3">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <FormFeedback state={state} />

        <div className="space-y-1.5">
          <Label htmlFor="new-task-title">{t('tasks.field.title')}</Label>
          <Input
            id="new-task-title"
            name="title"
            required
            aria-invalid={state.fieldErrors?.title ? true : undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-task-priority">{t('tasks.field.priority')}</Label>
          <Select id="new-task-priority" name="priority" defaultValue="normal">
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {taskPriorityLabel(priority, t)}
              </option>
            ))}
          </Select>
        </div>

        <SubmitButton label={t('action.create')} />
      </form>
    </Disclosure>
  );
}

/**
 * Move uma tarefa de estado.
 *
 * Manda `version` junto porque a API usa concorrência otimista: se um agente
 * mexeu na tarefa enquanto a tela estava aberta, o comando falha com
 * `VERSION_CONFLICT` em vez de sobrescrever o que o outro fez.
 */
export function TaskStatusControl({
  taskId,
  status,
  version,
  returnTo,
  options,
}: {
  taskId: string;
  status: TaskStatus;
  version: number;
  returnTo: string;
  options: TaskStatus[];
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(updateTaskStatusAction, idleFormState);

  return (
    <form action={action} className="mt-2 flex items-center gap-1.5">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="returnTo" value={returnTo} />

      <label className="sr-only" htmlFor={`task-status-${taskId}`}>
        {t('tasks.moveTo')}
      </label>
      <Select
        id={`task-status-${taskId}`}
        name="status"
        defaultValue={status}
        className="h-7 flex-1 text-xs"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {taskStatusBadge(option, t).label}
          </option>
        ))}
      </Select>
      <SubmitButton label={t('action.apply')} variant="secondary" />
      {state.status === 'error' && state.messageKey ? (
        <span role="alert" className="text-xs text-danger">
          {t(state.messageKey)}
        </span>
      ) : null}
    </form>
  );
}
