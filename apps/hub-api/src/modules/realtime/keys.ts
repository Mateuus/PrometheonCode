/**
 * Chaves e canais do tempo real no Redis.
 *
 * **A distinção que importa:** o cliente ioredis da API é criado com
 * `keyPrefix` (ver `plugins/redis.ts`), e o ioredis aplica esse prefixo aos
 * argumentos que o Redis declara como chave. Canais de pub/sub **não são
 * chaves** — `PUBLISH` e `SUBSCRIBE` passam intactos. Por isso:
 *
 * - nomes de chave (`presenceIndex`, `deviceState`, …) saem daqui **sem**
 *   prefixo: quem o acrescenta é o ioredis;
 * - nomes de canal (`channel`) saem daqui **com** o prefixo escrito à mão, para
 *   casar byte a byte com `keys.realtimeChannel()` do `hub-worker`.
 *
 * Trocar um pelo outro produz a falha mais silenciosa possível: tudo funciona,
 * e nenhum evento chega.
 */

/** Garante exatamente um `:` no fim, como faz o worker. */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();

  if (trimmed === '') {
    return 'prometheon:';
  }

  return trimmed.endsWith(':') ? trimmed : `${trimmed}:`;
}

export interface RealtimeKeys {
  /** Prefixo dos canais, já normalizado. */
  readonly channelPrefix: string;
  /** Canal por organização — o mesmo que o `hub-worker` publica. */
  channel(organizationId: string): string;
  /** Organização de um canal recebido, ou `undefined` se não for nosso. */
  organizationOfChannel(channel: string): string | undefined;
  /** ZSET de presença da organização: membro `userId:connectionId`, score = expiração. */
  presenceOrganization(organizationId: string): string;
  /** ZSET de presença do projeto, mesmo formato. */
  presenceProject(projectId: string): string;
  /** ZSET dos dispositivos vistos num projeto: membro `deviceId`, score = expiração. */
  deviceProject(projectId: string): string;
  /** Último heartbeat de um dispositivo, em JSON, com TTL próprio. */
  deviceState(deviceId: string): string;
  /** Marca de token de handshake já usado. */
  handshakeToken(tokenId: string): string;
}

export function createRealtimeKeys(rawPrefix: string): RealtimeKeys {
  const channelPrefix = normalizePrefix(rawPrefix);
  const channelRoot = `${channelPrefix}realtime:org:`;

  return {
    channelPrefix,
    channel: (organizationId) => `${channelRoot}${organizationId}`,
    organizationOfChannel: (channel) =>
      channel.startsWith(channelRoot) ? channel.slice(channelRoot.length) : undefined,
    presenceOrganization: (organizationId) => `rt:presence:org:${organizationId}`,
    presenceProject: (projectId) => `rt:presence:prj:${projectId}`,
    deviceProject: (projectId) => `rt:device:prj:${projectId}`,
    deviceState: (deviceId) => `rt:device:${deviceId}`,
    handshakeToken: (tokenId) => `rt:handshake:${tokenId}`,
  };
}
