/**
 * Estado do device authorization flow (`Docs/09`, seis passos).
 *
 * O estado vive no Redis, com TTL igual ao do device code. A razão é estrutural,
 * não de conveniência: no passo 1 ainda não existe usuário associado, e
 * `devices.user_id` é obrigatório no schema. O dispositivo só é criado no passo
 * 5, quando já se sabe quem autorizou — antes disso, o que existe é um pedido
 * pendente que expira em dez minutos e não deixa rastro se ninguém aprovar.
 *
 * O que sobrevive ao fluxo (o dispositivo e a credencial hasheada) vai para
 * `devices` e `device_tokens`, no MySQL.
 *
 * Chaves:
 * ```text
 * auth:device:code:<sha256(deviceCode)>  → estado em JSON
 * auth:device:user:<userCode>            → sha256(deviceCode)
 * auth:device:poll:<sha256(deviceCode)>  → marca do último polling
 * ```
 */

import { AUTH_SETTINGS } from '../../config/index.js';
import { generateUserCode, hashToken, randomToken } from '../../shared/crypto.js';
import type { RedisClient } from '../../plugins/redis.js';
import type { DeviceFlowState } from './types.js';

const CODE_PREFIX = 'auth:device:code:';
const USER_CODE_PREFIX = 'auth:device:user:';
const POLL_PREFIX = 'auth:device:poll:';

export interface StartDeviceFlowInput {
  readonly deviceName: string;
  readonly deviceKind: 'vscode' | 'cli' | 'ci' | 'other';
  readonly platform: string | null;
  readonly clientVersion: string | null;
}

export interface StartedDeviceFlow {
  /** Segredo que a extensão guarda; nunca é mostrado ao usuário. */
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly state: DeviceFlowState;
}

export async function startDeviceFlow(
  redis: RedisClient,
  input: StartDeviceFlowInput,
): Promise<StartedDeviceFlow> {
  const deviceCode = randomToken();
  const codeHash = hashToken(deviceCode);
  const ttl = AUTH_SETTINGS.deviceCodeTtlSeconds;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1_000);

  // Colisão de user code é improvável (40 bits em uma janela de 10 minutos),
  // mas o custo de tratá-la é uma tentativa a mais — e o custo de ignorá-la é
  // um usuário aprovar o dispositivo de outro.
  let userCode = generateUserCode();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reserved = await redis.set(
      `${USER_CODE_PREFIX}${userCode}`,
      codeHash,
      'EX',
      ttl,
      'NX',
    );

    if (reserved === 'OK') {
      break;
    }

    userCode = generateUserCode();
  }

  const state: DeviceFlowState = {
    deviceName: input.deviceName,
    deviceKind: input.deviceKind,
    platform: input.platform,
    clientVersion: input.clientVersion,
    userCode,
    requestedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'pending',
  };

  await redis.set(`${CODE_PREFIX}${codeHash}`, JSON.stringify(state), 'EX', ttl);

  return {
    deviceCode,
    userCode,
    expiresIn: ttl,
    interval: AUTH_SETTINGS.devicePollIntervalSeconds,
    state,
  };
}

export async function readByDeviceCode(
  redis: RedisClient,
  deviceCode: string,
): Promise<DeviceFlowState | null> {
  const raw = await redis.get(`${CODE_PREFIX}${hashToken(deviceCode)}`);

  return raw === null ? null : (JSON.parse(raw) as DeviceFlowState);
}

export async function readByUserCode(
  redis: RedisClient,
  userCode: string,
): Promise<{ codeHash: string; state: DeviceFlowState } | null> {
  const codeHash = await redis.get(`${USER_CODE_PREFIX}${userCode}`);

  if (codeHash === null) {
    return null;
  }

  const raw = await redis.get(`${CODE_PREFIX}${codeHash}`);

  return raw === null ? null : { codeHash, state: JSON.parse(raw) as DeviceFlowState };
}

/** Grava a decisão do usuário, preservando o TTL restante. */
export async function decideDeviceFlow(
  redis: RedisClient,
  codeHash: string,
  decision: 'approved' | 'denied',
  actor: { userId: string; organizationId: string },
): Promise<DeviceFlowState | null> {
  const key = `${CODE_PREFIX}${codeHash}`;
  const raw = await redis.get(key);

  if (raw === null) {
    return null;
  }

  const current = JSON.parse(raw) as DeviceFlowState;

  if (current.status !== 'pending') {
    return current;
  }

  const next: DeviceFlowState = {
    ...current,
    status: decision,
    userId: actor.userId,
    organizationId: actor.organizationId,
  };

  // `KEEPTTL` mantém a expiração original: aprovar não estende a validade do
  // código, que continua sendo de dez minutos a partir do pedido.
  await redis.set(key, JSON.stringify(next), 'KEEPTTL');

  return next;
}

/** Apaga o pedido depois que a credencial foi entregue. */
export async function finishDeviceFlow(
  redis: RedisClient,
  deviceCode: string,
  userCode: string,
): Promise<void> {
  const codeHash = hashToken(deviceCode);

  await redis.del(`${CODE_PREFIX}${codeHash}`, `${USER_CODE_PREFIX}${userCode}`, `${POLL_PREFIX}${codeHash}`);
}

/**
 * Impõe o intervalo mínimo entre chamadas de polling.
 *
 * O `interval` devolvido no passo 1 é uma instrução; esta função é o que a
 * torna obrigatória. Cliente que ignora recebe `SLOW_DOWN` — o mesmo nome que a
 * RFC 8628 usa — em vez de conseguir transformar o polling num canal de força
 * bruta sobre device codes.
 */
export async function registerPoll(
  redis: RedisClient,
  deviceCode: string,
): Promise<{ tooSoon: boolean; retryInSeconds: number }> {
  const key = `${POLL_PREFIX}${hashToken(deviceCode)}`;
  const interval = AUTH_SETTINGS.devicePollIntervalSeconds;
  const accepted = await redis.set(key, '1', 'EX', interval, 'NX');

  if (accepted === 'OK') {
    return { tooSoon: false, retryInSeconds: interval };
  }

  const ttl = await redis.ttl(key);

  return { tooSoon: true, retryInSeconds: ttl > 0 ? ttl : interval };
}
