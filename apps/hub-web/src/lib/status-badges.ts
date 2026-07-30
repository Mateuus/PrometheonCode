import type { LucideIcon } from 'lucide-react';
import {
  CheckCircle2,
  CircleDashed,
  CirclePause,
  ClipboardCheck,
  Lightbulb,
  Loader2,
  OctagonAlert,
  PlugZap,
  ThumbsDown,
  ThumbsUp,
  Unplug,
} from 'lucide-react';
import type { AgentStatus, KnowledgeStatus, TaskStatus } from '@/lib/api/types';
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
    case 'running':
      return { label: t('tasks.status.running'), icon: Loader2, tone: 'running' };
    case 'blocked':
      return { label: t('tasks.status.blocked'), icon: OctagonAlert, tone: 'alert' };
    case 'review':
      return { label: t('tasks.status.review'), icon: ClipboardCheck, tone: 'accent' };
    case 'done':
      return { label: t('tasks.status.done'), icon: CheckCircle2, tone: 'success' };
  }
}

export function agentStatusBadge(status: AgentStatus, t: Translate): BadgeDescriptor {
  switch (status) {
    case 'idle':
      return { label: t('agents.status.idle'), icon: CircleDashed, tone: 'neutral' };
    case 'working':
      return { label: t('agents.status.working'), icon: PlugZap, tone: 'running' };
    case 'offline':
      return { label: t('agents.status.offline'), icon: Unplug, tone: 'neutral' };
    case 'paused':
      return { label: t('agents.status.paused'), icon: CirclePause, tone: 'alert' };
  }
}

export function knowledgeStatusBadge(status: KnowledgeStatus, t: Translate): BadgeDescriptor {
  switch (status) {
    case 'proposed':
      return { label: t('brain.status.proposed'), icon: Lightbulb, tone: 'accent' };
    case 'approved':
      return { label: t('brain.status.approved'), icon: ThumbsUp, tone: 'success' };
    case 'rejected':
      return { label: t('brain.status.rejected'), icon: ThumbsDown, tone: 'danger' };
  }
}
