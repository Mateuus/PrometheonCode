/** Tipos internos do módulo de mensagens. */

import type { MessagePartType } from '@prometheon/contracts';

export interface MessageRow {
  id: string;
  organizationId: string;
  conversationId: string;
  authorType: 'user' | 'agent' | 'system';
  authorUserId: string | null;
  authorAgentRunId: string | null;
  status: 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled' | 'redacted';
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
  authorName: string | null;
  authorEmail: string | null;
  authorAvatarUrl: string | null;
}

export interface MessagePartRow {
  id: string;
  messageId: string;
  /** Posição da parte dentro da mensagem, começando em zero. */
  sequence: number;
  type: MessagePartType;
  content: string | null;
  payload: Record<string, unknown> | null;
  toolName: string | null;
}

export type ContextRefType =
  | 'file'
  | 'diff'
  | 'knowledge_item'
  | 'task'
  | 'artifact'
  | 'graph_node'
  | 'commit'
  | 'url';

export interface ContextRefRow {
  id: string;
  messageId: string;
  refType: ContextRefType;
  refId: string;
  label: string | null;
}
