/**
 * Papéis de agente definidos pela organização.
 *
 * Os sete papéis embutidos (`orchestrator`, `planner`, …) são código: existem em
 * toda instalação e não passam por aqui. O que a organização define são os
 * papéis **nomeados** — "Gameplay PIE UE5 Test", por exemplo —, que dão nome e
 * kit de skills a uma especialidade que os embutidos não cobrem.
 *
 * Duas decisões atravessam os schemas daqui:
 *
 * - **`basedOn` é obrigatório.** Um papel nomeado não é um papel novo para o
 *   orquestrador: ele se comporta como um dos embutidos na hora da delegação.
 *   Sem isso, o orquestrador não saberia a quem entregar o quê.
 * - **a escrita é a lista inteira.** A extensão edita o conjunto de papéis, não
 *   um papel de cada vez, e substituir em bloco é o que torna a remoção
 *   observável — um papel some porque não veio, não porque alguém lembrou de
 *   chamar o `DELETE`.
 *
 * Nada aqui é credencial: papel é configuração compartilhável.
 */

import { z } from 'zod';

import { isoDateTimeSchema, shortTextSchema, slugSchema, ulidSchema } from './primitives.js';

/** Papéis embutidos que um papel nomeado pode herdar. */
export const AGENT_ROLE_BASES = [
  'orchestrator',
  'planner',
  'implementer',
  'reviewer',
  'researcher',
  'tester',
] as const;

export const agentRoleBaseSchema = z.enum(AGENT_ROLE_BASES);

export type AgentRoleBase = z.infer<typeof agentRoleBaseSchema>;

/** Nome de skill: o mesmo formato dos três hosts que leem `SKILL.md`. */
export const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'skill name must be lowercase letters, digits and hyphens');

export const agentRoleSkillsSchema = z.array(skillNameSchema).max(40);

/** Um papel nomeado, como a API o devolve. */
export const agentRoleSchema = z.object({
  id: slugSchema,
  organizationId: ulidSchema,
  label: shortTextSchema,
  description: z.string().trim().min(1).max(240),
  basedOn: agentRoleBaseSchema,
  skills: agentRoleSkillsSchema,
  systemPrompt: z.string().max(8_000).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type AgentRole = z.infer<typeof agentRoleSchema>;

/** Um papel como ele chega para gravação. O `id` sai do rótulo quando falta. */
export const agentRoleInputSchema = z.object({
  id: slugSchema.optional(),
  label: shortTextSchema,
  description: z.string().trim().min(1).max(240),
  basedOn: agentRoleBaseSchema,
  skills: agentRoleSkillsSchema.default([]),
  systemPrompt: z.string().max(8_000).optional(),
});

export type AgentRoleInput = z.infer<typeof agentRoleInputSchema>;

/**
 * Substituição em bloco. O limite de 60 é o mesmo da extensão: acima disso a
 * lista deixa de ser escolhível numa tela e vira um catálogo, que é outro
 * problema — e um que ninguém tem hoje.
 */
export const replaceAgentRolesSchema = z.object({
  roles: z.array(agentRoleInputSchema).max(60),
});

export type ReplaceAgentRolesInput = z.infer<typeof replaceAgentRolesSchema>;

export const agentRoleListSchema = z.object({
  items: z.array(agentRoleSchema),
});

export type AgentRoleList = z.infer<typeof agentRoleListSchema>;
