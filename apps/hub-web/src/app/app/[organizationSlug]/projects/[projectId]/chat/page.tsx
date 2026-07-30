import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Bot,
  Download,
  MessageSquarePlus,
  Paperclip,
  Search,
  ServerCog,
  UserRound,
} from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { EmptyState } from '@/components/states/screen-states';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { ChatComposer } from '@/components/chat/composer';
import {
  getOrganizationBySlug,
  listAgents,
  listConversations,
  listMessages,
  listProjects,
  listTasks,
} from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { relativeTime } from '@/lib/format';
import { taskStatusBadge } from '@/lib/status-badges';

export const metadata: Metadata = { title: 'Chat' };

export default async function ProjectChatPage({
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

  const conversations = await applyForcedState(forced, await listConversations(projectId), []);

  const selectedRaw = query.conversation;
  const selectedId =
    (Array.isArray(selectedRaw) ? selectedRaw[0] : selectedRaw) ??
    (conversations.ok ? conversations.data[0]?.id : undefined);

  const [messages, agents, tasks, organization] = await Promise.all([
    selectedId ? listMessages(selectedId) : Promise.resolve(null),
    listAgents(projectId),
    listTasks(projectId),
    getOrganizationBySlug(organizationSlug),
  ]);

  const projectList = organization.ok ? await listProjects(organization.data.id) : null;
  const projects = projectList?.ok ? projectList.data : [];

  const mainAgent = agents.ok ? agents.data.find((agent) => agent.role === 'main') : undefined;
  const coreOnline = agents.ok
    ? agents.data.some((agent) => agent.status === 'working' || agent.status === 'idle')
    : false;
  const relatedTasks = tasks.ok
    ? tasks.data.filter((task) => task.status === 'running' || task.status === 'review')
    : [];

  return (
    <div className="space-y-4">
      <SampleDataNotice />

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_16rem]">
        {/* Conversas */}
        <section aria-label={t('chat.conversations')} className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{t('chat.conversations')}</h2>
            <Button size="icon" variant="ghost" className="ml-auto">
              <MessageSquarePlus aria-hidden />
              <span className="sr-only">{t('chat.newConversation')}</span>
            </Button>
          </div>

          <label className="relative block">
            <span className="sr-only">{t('chat.search')}</span>
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
            />
            <Input placeholder={t('chat.search')} className="h-9 pl-8 text-sm" />
          </label>

          <DataView
            result={conversations}
            isEmpty={(items) => items.length === 0}
            emptyDescriptionKey="chat.emptyConversations"
            retryHref={`${base}/chat`}
            backHref={base}
          >
            {(items) => (
              <ul className="space-y-1">
                {items.map((conversation) => {
                  const active = conversation.id === selectedId;
                  return (
                    <li key={conversation.id}>
                      <Link
                        href={`${base}/chat?conversation=${conversation.id}`}
                        aria-current={active ? 'true' : undefined}
                        className={
                          active
                            ? 'block rounded-[var(--radius-prom)] border border-accent/40 bg-accent-soft p-2.5'
                            : 'block rounded-[var(--radius-prom)] border border-transparent p-2.5 hover:bg-surface-raised'
                        }
                      >
                        <span className="block truncate text-sm text-foreground">
                          {conversation.title}
                        </span>
                        <span className="block text-xs text-muted">
                          {relativeTime(conversation.updatedAt, locale)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </DataView>
        </section>

        {/* Mensagens */}
        <section aria-label={t('chat.title')} className="flex min-h-[28rem] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-prom)] border border-line bg-surface px-3 py-2">
            {/* Seletor de projeto: o `Docs/05` pede que o chat troque de projeto
                sem sair da tela. São links porque o projeto está na URL. */}
            <span className="text-xs text-muted">{t('chat.projectSelector')}</span>
            {projects.slice(0, 3).map((option) => (
              <Link
                key={option.id}
                href={`/app/${organizationSlug}/projects/${option.id}/chat`}
                aria-current={option.id === projectId ? 'page' : undefined}
                className={
                  option.id === projectId
                    ? 'rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-xs font-medium text-foreground'
                    : 'rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:text-foreground'
                }
              >
                {option.name}
              </Link>
            ))}

            <span className="ml-2 text-xs text-muted">{t('chat.mainAgent')}</span>
            <StatusBadge tone="running" icon={Bot}>
              {mainAgent?.name ?? t('common.unknown')}
            </StatusBadge>
            <span className="text-xs text-muted">{t('chat.mode')}</span>
            <StatusBadge tone="accent">{t('chat.mode.agentTeam')}</StatusBadge>

            <Button size="sm" variant="ghost" className="ml-auto">
              <Download aria-hidden />
              {t('chat.export')}
            </Button>
          </div>

          <div className="flex-1">
            {messages === null ? (
              <EmptyState descriptionKey="chat.emptyMessages" />
            ) : (
              <DataView
                result={messages}
                isEmpty={(items) => items.length === 0}
                emptyDescriptionKey="chat.emptyMessages"
                retryHref={`${base}/chat`}
                backHref={base}
              >
                {(items) => (
                  <ol className="space-y-3">
                    {items.map((message) => (
                      <li
                        key={message.id}
                        className="rounded-[var(--radius-prom)] border border-line bg-surface p-3"
                      >
                        <div className="flex items-center gap-2">
                          {/* Cada tipo de autor tem ícone próprio: pessoa, agente
                              e o próprio Hub não se distinguem só pela cor. */}
                          {message.authorType === 'agent' ? (
                            <Bot aria-hidden className="size-4 text-running" />
                          ) : message.authorType === 'system' ? (
                            <ServerCog aria-hidden className="size-4 text-activity" />
                          ) : (
                            <UserRound aria-hidden className="size-4 text-accent" />
                          )}
                          <span className="text-sm font-medium text-foreground">
                            {message.authorName}
                          </span>
                          <span className="ml-auto text-xs text-muted">
                            {relativeTime(message.createdAt, locale)}
                          </span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                          {message.body}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </DataView>
            )}
          </div>

          <ChatComposer coreOnline={coreOnline} />
        </section>

        {/* Contexto, tarefas e presença */}
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Paperclip aria-hidden className="size-3.5 text-muted" />
                {t('chat.attachedContext')}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted">
              <p className="font-mono text-xs">{`${projectId.slice(0, 12)}…`}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('chat.relatedTasks')}</CardTitle>
            </CardHeader>
            <CardContent>
              {relatedTasks.length === 0 ? (
                <p className="text-sm text-muted">{t('tasks.empty')}</p>
              ) : (
                <ul className="space-y-2">
                  {relatedTasks.map((task) => {
                    const badge = taskStatusBadge(task.status, t);
                    return (
                      <li key={task.id} className="space-y-1">
                        <p className="text-sm text-foreground">{task.title}</p>
                        <StatusBadge tone={badge.tone} icon={badge.icon}>
                          {badge.label}
                        </StatusBadge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('chat.presence')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {(agents.ok ? agents.data : []).map((agent) => (
                  <li key={agent.id} className="flex items-center gap-2 text-sm">
                    <Bot aria-hidden className="size-3.5 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
                    <span className="text-xs text-muted">{agent.deviceLabel}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
