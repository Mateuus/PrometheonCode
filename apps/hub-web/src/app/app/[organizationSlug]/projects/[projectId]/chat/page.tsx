import type { Metadata } from 'next';
import Link from 'next/link';
import { Bot, MonitorSmartphone, Paperclip, ServerCog, UserRound } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { EmptyState } from '@/components/states/screen-states';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { LiveRegion } from '@/components/realtime/live-region';
import { ChatComposer, NewConversationForm } from '@/components/chat/composer';
import {
  getOrganizationBySlug,
  listActiveAgents,
  listConversations,
  listMessages,
  listPresence,
  listTasks,
} from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { relativeTime } from '@/lib/format';
import { presenceBadge, taskStatusBadge } from '@/lib/status-badges';
import { viewerCan } from '@/lib/roles';
import type { Message } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Chat' };

/**
 * Texto legível de uma mensagem.
 *
 * O corpo é uma lista de partes discriminadas por `type` — texto, chamada de
 * ferramenta, artefato, erro. Esta tela mostra as textuais e **nomeia** as
 * outras em vez de escondê-las: uma mensagem que só tem chamada de ferramenta
 * não pode aparecer como uma bolha vazia.
 */
function renderParts(message: Message, t: (key: 'chat.part.tool' | 'chat.part.artifact' | 'chat.part.error' | 'chat.part.reasoning' | 'chat.part.other') => string) {
  return message.parts.map((part, index) => {
    const key = `${message.id}-${index}`;
    if (part.type === 'text') {
      return (
        <p key={key} className="whitespace-pre-wrap text-sm text-foreground">
          {part.text}
        </p>
      );
    }
    if (part.type === 'reasoning_summary') {
      return (
        <p key={key} className="whitespace-pre-wrap text-sm italic text-muted">
          {part.summary}
        </p>
      );
    }
    if (part.type === 'error') {
      return (
        <p key={key} className="text-sm text-danger">
          {t('chat.part.error')}: {part.message}
        </p>
      );
    }
    const label =
      part.type === 'tool_call' || part.type === 'tool_result'
        ? t('chat.part.tool')
        : part.type === 'artifact_reference'
          ? t('chat.part.artifact')
          : t('chat.part.other');
    return (
      <p key={key} className="text-xs text-muted">
        <StatusBadge tone="neutral">{label}</StatusBadge>
      </p>
    );
  });
}

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
  const forced = devForcedState(query);

  const conversations = await applyForcedState(forced, await listConversations(projectId), []);

  const selectedRaw = query.conversation;
  const selectedId =
    (Array.isArray(selectedRaw) ? selectedRaw[0] : selectedRaw) ??
    (conversations.ok ? conversations.data[0]?.id : undefined);

  const [messages, agents, tasks, presence, organization] = await Promise.all([
    selectedId ? listMessages(selectedId) : Promise.resolve(null),
    listActiveAgents(projectId),
    listTasks(projectId),
    listPresence(projectId),
    getOrganizationBySlug(organizationSlug),
  ]);

  const selectedConversation = conversations.ok
    ? conversations.data.find((conversation) => conversation.id === selectedId)
    : undefined;

  // "Core online" é literal: um dispositivo autorizado batendo heartbeat neste
  // projeto. Sem ele, a mensagem é gravada e fica esperando — e a tela diz isso.
  const coreOnline = agents.ok && agents.data.some((agent) => agent.status === 'online');
  const relatedTasks = tasks.ok
    ? tasks.data.filter((task) => task.status === 'in_progress' || task.status === 'in_review')
    : [];
  const canWrite =
    organization.ok &&
    viewerCan(
      { role: organization.data.role, permissions: organization.data.permissions },
      'chat.write',
    );

  return (
    <div className="space-y-4">
      <ForcedStateNotice forced={forced} />

      {/* Mensagem nova nesta conversa recompõe a tela — inclusive quando ela
          chega de outra aba, de outra pessoa ou de um agente. */}
      <LiveRegion
        eventTypes={['message.created', 'message.updated', 'task.updated', 'presence.changed', 'device.changed']}
        projectId={projectId}
      />

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_16rem]">
        {/* Conversas */}
        <section aria-label={t('chat.conversations')} className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">{t('chat.conversations')}</h2>

          {canWrite ? (
            <NewConversationForm organizationSlug={organizationSlug} projectId={projectId} />
          ) : null}

          <DataView
            result={conversations}
            isEmpty={(itemList) => itemList.length === 0}
            emptyDescriptionKey="chat.emptyConversations"
            retryHref={`${base}/chat`}
            backHref={base}
          >
            {(itemList) => (
              <ul className="space-y-1">
                {itemList.map((conversation) => {
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
                          {conversation.lastMessageAt
                            ? relativeTime(conversation.lastMessageAt, locale)
                            : t('chat.neverUsed')}
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
            <span className="truncate text-sm font-medium text-foreground">
              {selectedConversation?.title ?? t('chat.title')}
            </span>
            {selectedConversation ? (
              <>
                <span className="text-xs text-muted">{t('chat.mode')}</span>
                <StatusBadge tone="accent">
                  {selectedConversation.workMode === 'plan'
                    ? t('chat.mode.plan')
                    : selectedConversation.workMode === 'edit'
                      ? t('chat.mode.edit')
                      : t('chat.mode.agentTeam')}
                </StatusBadge>
              </>
            ) : null}
            <StatusBadge tone={coreOnline ? 'running' : 'neutral'} icon={Bot} className="ml-auto">
              {coreOnline ? t('chat.coreOnline') : t('chat.coreOffline')}
            </StatusBadge>
          </div>

          <div className="flex-1">
            {messages === null ? (
              <EmptyState descriptionKey="chat.emptyConversations" />
            ) : (
              <DataView
                result={messages}
                isEmpty={(itemList) => itemList.length === 0}
                emptyDescriptionKey="chat.emptyMessages"
                retryHref={`${base}/chat`}
                backHref={base}
              >
                {(itemList) => (
                  <ol className="space-y-3">
                    {itemList.map((message) => (
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
                            {message.authorUser?.name ??
                              (message.authorType === 'agent'
                                ? t('chat.author.agent')
                                : t('chat.author.system'))}
                          </span>
                          {message.status === 'complete' ? null : (
                            <StatusBadge
                              tone={message.status === 'failed' ? 'danger' : 'activity'}
                            >
                              {message.status}
                            </StatusBadge>
                          )}
                          <span className="ml-auto text-xs text-muted">
                            {relativeTime(message.createdAt, locale)}
                          </span>
                        </div>
                        <div className="mt-2 space-y-1.5">{renderParts(message, t)}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </DataView>
            )}
          </div>

          <ChatComposer
            conversationId={selectedId}
            returnTo={`${base}/chat`}
            coreOnline={coreOnline}
            canWrite={canWrite}
          />
        </section>

        {/* Contexto, tarefas e presença */}
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Paperclip aria-hidden className="size-3.5 text-muted" />
                {t('chat.participants')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {selectedConversation === undefined ||
              selectedConversation.participants.length === 0 ? (
                <p className="text-sm text-muted">{t('chat.noParticipants')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {selectedConversation.participants.map((participant) => (
                    <li key={participant.id} className="flex items-center gap-2 text-sm">
                      {participant.kind === 'agent' ? (
                        <Bot aria-hidden className="size-3.5 text-muted" />
                      ) : (
                        <UserRound aria-hidden className="size-3.5 text-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {participant.user?.name ?? t('chat.author.agent')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
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
            <CardContent className="space-y-2">
              {(presence.ok ? presence.data : []).map((entry) => {
                const badge = presenceBadge(entry.status, t);
                return (
                  <div key={entry.user.id} className="flex items-center gap-2 text-sm">
                    <UserRound aria-hidden className="size-3.5 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {entry.user.name}
                    </span>
                    <StatusBadge tone={badge.tone} icon={badge.icon}>
                      {badge.label}
                    </StatusBadge>
                  </div>
                );
              })}
              {(agents.ok ? agents.data : []).map((agent) => (
                <div key={agent.deviceId} className="flex items-center gap-2 text-sm">
                  <MonitorSmartphone aria-hidden className="size-3.5 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {agent.deviceName}
                  </span>
                  <span className="text-xs text-muted">{agent.kind}</span>
                </div>
              ))}
              {(!presence.ok || presence.data.length === 0) &&
              (!agents.ok || agents.data.length === 0) ? (
                <p className="text-sm text-muted">{t('chat.noPresence')}</p>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
