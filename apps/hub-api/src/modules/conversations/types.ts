/** Tipos internos do módulo de conversas. */

export interface ConversationRow {
  id: string;
  organizationId: string;
  projectId: string | null;
  title: string;
  origin: 'web' | 'local_import' | 'agent';
  status: 'active' | 'archived' | 'locked';
  visibility: 'private' | 'project' | 'organization';
  workMode: 'plan' | 'edit' | 'agent_team';
  lastSequence: number;
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  version: number;
}

export interface ParticipantRow {
  id: string;
  conversationId: string;
  participantType: 'user' | 'agent';
  participantId: string;
  role: 'owner' | 'member' | 'observer';
  joinedAt: Date | null;
  createdAt: Date;
  userName: string | null;
  userEmail: string | null;
  userAvatarUrl: string | null;
  agentProfileId: string | null;
}
