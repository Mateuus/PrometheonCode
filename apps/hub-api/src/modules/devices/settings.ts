/**
 * Parâmetros do heartbeat de dispositivo (`Docs/06`).
 *
 * O par intervalo/TTL é a regra inteira: o dispositivo bate a cada intervalo, e
 * o registro vale por pouco mais de três batidas. Perder uma batida por causa de
 * uma rede ruim não tira ninguém da lista; parar de bater tira, sozinho, sem
 * depender de nenhum processo de limpeza — pelo mesmo motivo da presença de
 * pessoas, e pelo mesmo defeito que se quer evitar: uma lista de agentes ativos
 * que mostra agentes mortos deixa de ser consultada.
 */

export const DEVICE_SETTINGS = {
  /** Intervalo pedido ao dispositivo, em segundos. */
  heartbeatIntervalSeconds: 30,
  /** Vida do registro no Redis: três batidas e um pouco. */
  presenceTtlMs: 95_000,
  /** Projetos que um heartbeat pode declarar de uma vez. */
  maxProjectsPerHeartbeat: 50,
} as const;
