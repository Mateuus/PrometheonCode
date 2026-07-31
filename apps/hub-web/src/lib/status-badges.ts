import type { LucideIcon } from 'lucide-react';
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  CirclePause,
  ClipboardCheck,
  FileEdit,
  Handshake,
  Lightbulb,
  Loader2,
  OctagonAlert,
  PlugZap,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import type { ActiveAgent, KnowledgeStatus, TaskPriority, TaskStatus } from '@/lib/api/types';
import type { StatusTone } from '@/components/ui/status-badge';
import type { Translate } from '@/i18n/dictionary';

/**
 * Status do domínio traduzidos em rótulo, ícone e tom.
 *
 * O ícone vem junto de propósito: `Docs/05` proíbe status comunicado só por cor,
 * e a forma de garantir isso é não deixar existir um caminho em que o crachá
 * saia sem ícone e sem texto.
 */
export interface BadgeDescriptor {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
}

export function taskStatusBadge(status: TaskStatus, t: Translate): BadgeDescriptor {
  switch (status) {
    case 'backlog':
      return { label: t('tasks.status.backlog'), icon: CircleDashed, tone: 'neutral' };
    case 'ready':
      return { label: t('tasks.status.ready'), icon: Sparkles, tone: 'accent' };
    case 'claimed':
      return { label: t('tasks.status.claimed'), icon: Handshake, tone: 'activity' };
    case 'in_progress':
      return { label: t('tasks.status.inProgress'), icon: Loader2, tone: 'running' };
    case 'blocked':
      return { label: t('tasks.status.blocked'), icon: OctagonAlert, tone: 'alert' };
    case 'in_review':
      return { label: t('tasks.status.inReview'), icon: ClipboardCheck, tone: 'accent' };
    case 'done':
      return { label: t('tasks.status.done'), icon: CheckCircle2, tone: 'success' };
    case 'cancelled':
      return { label: t('tasks.status.cancelled'), icon: Ban, tone: 'neutral' };
    case 'failed':
      return { label: t('tasks.status.failed'), icon: TriangleAlert, tone: 'danger' };
  }
}

export function taskPriorityLabel(priority: TaskPriority, t: Translate): string {
  return {
    low: t('tasks.priority.low'),
    normal: t('tasks.priority.normal'),
    high: t('tasks.priority.high'),
    urgent: t('tasks.priority.urgent'),
  }[priority];
}

export function agentStatusBadge(status: ActiveAgent['status'], t: Translate): BadgeDescriptor {
  return status === 'online'
    ? { label: t('agents.status.online'), icon: PlugZap, tone: 'running' }
    : { label: t('agents.status.idle'), icon: CirclePause, tone: 'neutral' };
}

export function presenceBadge(
  status: 'online' | 'idle' | 'offline',
  t: Translate,
): BadgeDescriptor {
  switch (status) {
    case 'online':
      return { label: t('members.online'), icon: PlugZap, tone: 'activity' };
    case 'idle':
      return { label: t('agents.status.idle'), icon: CirclePause, tone: 'neutral' };
    case 'offline':
      return { label: t('members.offline'), icon: Unplug, tone: 'neutral' };
  }
}

export function knowledgeStatusBadge(status: KnowledgeStatus, t: Translate): BadgeDescriptor {
  switch (status) {
    case 'draft':
      return { label: t('brain.status.draft'), icon: FileEdit, tone: 'neutral' };
    case 'proposed':
      return { label: t('brain.status.proposed'), icon: Lightbulb, tone: 'accent' };
    case 'verified':
      return { label: t('brain.status.verified'), icon: ShieldCheck, tone: 'activity' };
    case 'approved':
      return { label: t('brain.status.approved'), icon: ThumbsUp, tone: 'success' };
    case 'official':
      return { label: t('brain.status.official'), icon: CheckCircle2, tone: 'success' };
    case 'superseded':
      return { label: t('brain.status.superseded'), icon: CircleDashed, tone: 'neutral' };
    case 'rejected':
      return { label: t('brain.status.rejected'), icon: ThumbsDown, tone: 'danger' };
  }
}
