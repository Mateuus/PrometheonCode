import type { Metadata } from 'next';
import { Plus, UserRound } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { Button } from '@/components/ui/button';
import { SectionTitle } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { listTasks } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { relativeTime } from '@/lib/format';
import { taskStatusBadge } from '@/lib/status-badges';
import type { TaskStatus } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Tasks' };

/** Ordem das colunas do quadro; o mesmo eixo do ciclo de vida da tarefa. */
const COLUMNS: TaskStatus[] = ['backlog', 'running', 'blocked', 'review', 'done'];

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
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const tasks = await applyForcedState(forced, await listTasks(projectId), []);

  return (
    <div className="space-y-4">
      <SampleDataNotice />

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('tasks.title')}</h2>
        <Button size="sm">
          <Plus aria-hidden />
          {t('tasks.create')}
        </Button>
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
            {COLUMNS.map((status) => {
              const badge = taskStatusBadge(status, t);
              const column = items.filter((task) => task.status === status);
              return (
                <section key={status} aria-label={badge.label}>
                  <SectionTitle
                    action={<span className="text-xs text-muted">{column.length}</span>}
                  >
                    <StatusBadge tone={badge.tone} icon={badge.icon}>
                      {badge.label}
                    </StatusBadge>
                  </SectionTitle>

                  {column.length === 0 ? (
                    <p className="rounded-[var(--radius-prom)] border border-dashed border-line px-3 py-6 text-center text-xs text-muted">
                      {t('state.empty.title')}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {column.map((task) => (
                        <li
                          key={task.id}
                          className="rounded-[var(--radius-prom)] border border-line bg-surface p-3"
                        >
                          <p className="text-sm text-foreground">{task.title}</p>
                          {task.blockedReason ? (
                            <p className="mt-1 text-xs text-alert">
                              {t('tasks.blockedReason', { reason: task.blockedReason })}
                            </p>
                          ) : null}
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                            <UserRound aria-hidden className="size-3" />
                            {task.assigneeName ?? t('tasks.unassigned')}
                          </p>
                          <p className="mt-0.5 text-xs text-muted">
                            {t('tasks.updated', {
                              relativeTime: relativeTime(task.updatedAt, locale),
                            })}
                          </p>
                        </li>
                      ))}
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
