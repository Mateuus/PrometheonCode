// Espaço de nomes das chaves no Redis.
//
// Tudo que o worker escreve passa por aqui. O prefixo vem da configuração
// (`VALKEY_KEY_PREFIX`), o que permite dois ambientes dividirem a mesma
// instância sem se atropelarem — e permite aos testes usarem um prefixo
// descartável e apagarem só o que é deles no final.
//
// O prefixo **não** vai na conexão ioredis: o BullMQ administra as próprias
// chaves e exige receber o prefixo pela opção `prefix`, não pelo cliente.

export interface KeyNamespace {
  /** Prefixo bruto, terminado em `:`. */
  readonly prefix: string;
  /** Prefixo das chaves do BullMQ. */
  readonly bull: string;
  /** Lock curto de publicação de uma mensagem do outbox. */
  outboxLock(messageId: string): string;
  /** Canal pub/sub por organização, consumido pelas instâncias da API. */
  realtimeChannel(organizationId: string): string;
  /** Padrão para quem quiser assinar tudo (`psubscribe`). */
  readonly realtimeChannelPattern: string;
  /** Marca de "job já processado", base da idempotência entre execuções. */
  jobDone(queue: string, key: string): string;
  /** Lista de inspeção da dead-letter. */
  readonly deadLetterRecords: string;
}

/** Garante exatamente um `:` no fim, sem duplicar quando já vem com ele. */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed === '') {
    return 'prometheon:';
  }
  return trimmed.endsWith(':') ? trimmed : `${trimmed}:`;
}

export function createKeyNamespace(rawPrefix: string): KeyNamespace {
  const prefix = normalizePrefix(rawPrefix);
  return {
    prefix,
    // Chaves do BullMQ ficam entre chaves para que o Redis Cluster mantenha a
    // fila inteira no mesmo slot.
    bull: `{${prefix}bull}`,
    outboxLock: (messageId) => `${prefix}outbox:lock:${messageId}`,
    realtimeChannel: (organizationId) => `${prefix}realtime:org:${organizationId}`,
    realtimeChannelPattern: `${prefix}realtime:org:*`,
    jobDone: (queue, key) => `${prefix}jobs:done:${queue}:${key}`,
    deadLetterRecords: `${prefix}jobs:dead-letter:records`,
  };
}
