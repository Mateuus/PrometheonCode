// Envelope publicado pelo outbox (`Docs/08`).
//
// É exatamente o envelope que a instância da API repassa pelo WebSocket:
//
// ```json
// { "id": "evt_...", "type": "task.updated", "version": 1,
//   "organizationId": "org_...", "projectId": "prj_...",
//   "occurredAt": "2026-07-30T15:00:00.000Z", "cursor": "..." }
// ```
//
// Duas escolhas explicam o resto:
//
// - **`id` é o ULID da linha do outbox** e também o `cursor`. ULID ordena por
//   tempo, então o consumidor que guarda o último `cursor` sabe exatamente de
//   onde retomar, e deduplica pelo mesmo valor. Entrega é pelo menos uma vez;
//   o ID estável é o que torna isso tolerável.
// - **`aggregate` viaja junto** para o consumidor que precisa de ordem por
//   agregado conseguir detectar buraco na sequência sem consultar o REST.

/** Forma da mensagem que o publicador lê do banco. */
export interface OutboxRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number | null;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly availableAt: Date;
  readonly attempts: number;
}

export interface OutboxEnvelope {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly occurredAt: string;
  readonly cursor: string;
  readonly aggregate: {
    readonly type: string;
    readonly id: string;
    readonly sequence: number | null;
  };
  readonly data: Record<string, unknown>;
}

/** Monta o envelope a partir da linha do outbox. */
export function toEnvelope(message: OutboxRecord): OutboxEnvelope {
  return {
    id: message.id,
    type: message.eventType,
    version: message.eventVersion,
    organizationId: message.organizationId,
    projectId: message.projectId,
    occurredAt: message.occurredAt.toISOString(),
    cursor: message.id,
    aggregate: {
      type: message.aggregateType,
      id: message.aggregateId,
      sequence: message.aggregateSequence,
    },
    data: message.payload,
  };
}

/** Chave de agrupamento por agregado, base da ordenação na publicação. */
export function aggregateKey(message: OutboxRecord): string {
  return `${message.aggregateType}:${message.aggregateId}`;
}
