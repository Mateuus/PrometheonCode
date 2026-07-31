import type { Metadata } from 'next';
import { UserRound } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { SectionTitle } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { LiveRegion } from '@/components/realtime/live-region';
import { CreateTaskForm, TaskStatusControl } from '@/components/forms/task-forms';
import { getOrganizationBySlug, listTasks } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { relativeTime } from '@/lib/format';
import { taskPriorityLabel, taskStatusBadge } from '@/lib/status-badges';
import { viewerCan } from '@/lib/roles';
import type { MessageKey } from '@/i18n/catalog';
import type { TaskStatus } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Colunas do quadro.
 *
 * A API tem nove estados de tarefa; nove colunas seriam ilegíveis. O quadro
 * agrupa por fase do ciclo de vida e o crachá dentro do cartão continua
 * mostrando o estado exato — nada de informação se perde no agrupamento.
 */
const COLUMNS: { key: string; labelKey: MessageKey; statuses: TaskStatus[] }[] = [
  { key: 'backlog', labelKey: 'tasks.column.backlog', statuses: ['backlog', 'ready'] },
  { key: 'running', labelKey: 'tasks.column.running', statuses: ['claimed', 'in_progress'] },
  { key: 'blocked', labelKey: 'tasks.column.blocked', statuses: ['blocked'] },
  { key: 'review', labelKey: 'tasks.column.review', statuses: ['in_review'] },
  { key: 'closed', labelKey: 'tasks.column.closed', statuses: ['done', 'cancelled', 'failed'] },
];

/** Estados que uma pessoa move pela interface. Reivindicar é coisa de agente. */
const MANUAL_STATUSES: TaskStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
];

export default async function ProjectTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ organizationSlug, projectId }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslate(),
    getLocale(),
  ]);

  const base = `/app/${organizationSlug}/projects/${projectId}`;
  const forced = devForcedState(query);
  const [tasksResult, organization] = await Promise.all([
    listTasks(projectId),
    getOrganizationBySlug(organizationSlug),
  ]);
  const tasks = await applyForcedState(forced, tasksResult, []);

  const canManage =
    organization.ok &&
    viewerCan(
      { role: organization.data.role, permissions: organization.data.permissions },
      'task.create',
    );

  return (
    <div className="space-y-4">
      <ForcedStateNotice forced={forced} />

      <LiveRegion
        eventTypes={['task.created', 'task.updated', 'task.claimed', 'task.released']}
        projectId={projectId}
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t('tasks.title')}</h2>
        {canManage ? <CreateTaskForm projectId={projectId} returnTo={`${base}/tasks`} /> : null}
      </div>

      <DataView
        result={tasks}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="tasks.empty"
        retryHref={`${base}/tasks`}
        backHref={base}
      >
        {(items) => (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {COLUMNS.map((column) => {
              const cards = items.filter((task) => column.statuses.includes(task.status));
              return (
                <section key={column.key} aria-label={t(column.labelKey)}>
                  <SectionTitle
                    action={<span className="text-xs text-muted">{cards.length}</span>}
                  >
                    {t(column.labelKey)}
                  </SectionTitle>

                  {cards.length === 0 ? (
                    <p className="rounded-[var(--radius-prom)] border border-dashed border-line px-3 py-6 text-center text-xs text-muted">
                      {t('state.empty.title')}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {cards.map((task) => {
                        const badge = taskStatusBadge(task.status, t);
                        return (
                          <li
                            key={task.id}
                            className="rounded-[var(--radius-prom)] border border-line bg-surface p-3"
                          >
                            <p className="text-sm text-foreground">{task.title}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <StatusBadge tone={badge.tone} icon={badge.icon}>
                                {badge.label}
                              </StatusBadge>
                              <span className="text-xs text-muted">
                                {taskPriorityLabel(task.priority, t)}
                              </span>
                            </div>
                            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                              <UserRound aria-hidden className="size-3" />
                              {task.assignee?.name ?? t('tasks.unassigned')}
                            </p>
                            <p className="mt-0.5 text-xs text-muted">
                              {t('tasks.updated', {
                                relativeTime: relativeTime(task.updatedAt, locale),
                              })}
                            </p>
                            {canManage ? (
                              <TaskStatusControl
                                taskId={task.id}
                                status={task.status}
                                version={task.version}
                                returnTo={`${base}/tasks`}
                                options={MANUAL_STATUSES}
                              />
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </DataView>
    </div>
  );
}
