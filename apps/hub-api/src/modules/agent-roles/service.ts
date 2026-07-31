/**
 * Papéis de agente da organização.
 *
 * A escrita é substituição em bloco: a extensão edita o conjunto, e trocar a
 * lista inteira é o que torna a remoção observável — um papel some porque não
 * veio, e não porque alguém lembrou de chamar o `DELETE`. Numa transação, para
 * que uma falha no meio não deixe a organização com meia lista.
 */

import { agentRoleDefinitions, type AgentRoleDefinition, type Database } from '@prometheon/database';
import type { AgentRole, AgentRoleInput } from '@prometheon/contracts';

export class AgentRoleService {
  constructor(private readonly db: Database) {}

  async list(organizationId: string): Promise<AgentRole[]> {
    const rows = await this.db.getRepository(agentRoleDefinitions).find({
      where: { organizationId },
      order: { label: 'ASC' },
    });
    return rows.map(toContract);
  }

  /**
   * Grava a lista inteira e devolve o que passou a valer.
   *
   * O retorno é lido do banco depois do commit, e não montado a partir da
   * entrada: é ele que o cliente adota como verdade, e devolver o que foi
   * enviado esconderia qualquer normalização feita aqui.
   */
  async replace(
    organizationId: string,
    roles: readonly AgentRoleInput[],
    actorId: string | null,
  ): Promise<AgentRole[]> {
    const prepared = normalize(roles);

    await this.db.transaction(async (manager) => {
      const repository = manager.getRepository(agentRoleDefinitions);
      const keep = prepared.map((role) => role.id);

      // Apagar o que não veio antes de gravar: o contrário deixaria a remoção
      // dependendo da ordem em que o banco resolve as duas operações.
      const existing = await repository.find({ where: { organizationId } });
      for (const row of existing) {
        if (!keep.includes(row.id)) {
          await repository.delete({ organizationId, id: row.id });
        }
      }

      for (const role of prepared) {
        await repository.save({
          organizationId,
          id: role.id,
          label: role.label,
          description: role.description,
          basedOn: role.basedOn,
          skills: [...role.skills],
          systemPrompt: role.systemPrompt ?? null,
          createdBy: actorId,
        });
      }
    });

    return this.list(organizationId);
  }
}

/**
 * Resolve identificadores e descarta repetidos.
 *
 * Dois papéis com o mesmo id tornariam ambíguo o vínculo de todo agente que
 * apontasse para ele; fica o primeiro, que é o que a lista enviada declarou
 * primeiro.
 */
function normalize(roles: readonly AgentRoleInput[]): IdentifiedRole[] {
  const seen = new Set<string>();
  const result: IdentifiedRole[] = [];

  for (const role of roles) {
    const id = role.id ?? slug(role.label);
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({ ...role, id });
  }
  return result;
}

/** Papel já com identificador resolvido — é o que a gravação exige. */
type IdentifiedRole = AgentRoleInput & { readonly id: string };

/** Identificador legível derivado do rótulo, igual ao da extensão. */
export function slug(value: string): string {
  // NFD separa o acento da letra; o passo seguinte descarta o que não for ASCII,
  // então "Revisão" vira "revisao" e não "reviso".
  return value
    .normalize('NFD')
    .replace(/[^ -~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function toContract(row: AgentRoleDefinition): AgentRole {
  return {
    id: row.id,
    organizationId: row.organizationId,
    label: row.label,
    description: row.description,
    basedOn: row.basedOn,
    // A coluna é JSON e pode ter sido gravada nula antes de a lista existir.
    skills: Array.isArray(row.skills) ? row.skills : [],
    systemPrompt: row.systemPrompt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
