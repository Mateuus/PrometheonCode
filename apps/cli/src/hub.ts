/**
 * Conversa com o Prometheon Hub.
 *
 * O CLI funciona sem Hub nenhum: executar agente é local. O que o Hub
 * acrescenta é o trabalho em equipe — projetos, tarefas, conversas
 * sincronizadas. Por isso nada aqui é obrigatório, e a ausência de credencial
 * nunca é tratada como erro.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { prometheonHome } from './doctor.js';

/** Credencial deste dispositivo, emitida pelo Hub. */
export interface HubCredential {
  readonly url: string;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly organizationId: string;
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly expiresAt: string | null;
}

function credentialPath(): string {
  return join(prometheonHome(), 'hub-credential.json');
}

/**
 * Guarda a credencial no disco, só para o dono do arquivo.
 *
 * O CLI não tem `SecretStorage` como a extensão — não existe cofre do sistema
 * disponível de forma portátil aqui. O que dá para garantir é que mais ninguém
 * na máquina leia: `0600` deixa o arquivo invisível para outros usuários. Num
 * computador compartilhado, isso é o que separa a sua conta da de quem senta
 * depois de você.
 */
export async function saveCredential(credential: HubCredential): Promise<void> {
  await mkdir(prometheonHome(), { recursive: true });
  await writeFile(credentialPath(), `${JSON.stringify(credential, null, 2)}\n`, 'utf8');

  try {
    await chmod(credentialPath(), 0o600);
  } catch {
    // No Windows a permissão POSIX não se aplica; o arquivo já fica sob o
    // perfil do usuário, que é a proteção equivalente daquele sistema.
  }
}

export async function readCredential(): Promise<HubCredential | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(credentialPath(), 'utf8'));

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const candidate = parsed as Partial<HubCredential>;

    // Credencial pela metade é o mesmo que credencial nenhuma: seguir com ela
    // produziria um 401 confuso no meio de outra coisa.
    return typeof candidate.deviceToken === 'string' && typeof candidate.url === 'string'
      ? (candidate as HubCredential)
      : null;
  } catch {
    return null;
  }
}

export async function forgetCredential(): Promise<void> {
  try {
    await writeFile(credentialPath(), '', 'utf8');
  } catch {
    // Nada a apagar é o resultado desejado.
  }
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** Começa o fluxo: o Hub devolve o código que a pessoa confirma no navegador. */
export async function startDeviceFlow(url: string): Promise<DeviceAuthorization> {
  const response = await fetch(`${trim(url)}/v1/auth/device/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceName: `${hostname()} (CLI)`,
      deviceKind: 'cli',
      platform: platform(),
      clientVersion: '0.0.1',
    }),
  });

  const payload = (await response.json()) as { data?: DeviceAuthorization; error?: { message?: string } };

  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? `O Hub respondeu ${String(response.status)}.`);
  }

  return payload.data;
}

export type PollOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'slow-down'; readonly interval: number }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'ready'; readonly credential: Omit<HubCredential, 'url'> };

/**
 * Pergunta ao Hub se a pessoa já confirmou.
 *
 * Cada desfecho vira um caso próprio em vez de um erro genérico: "ainda não
 * confirmou" e "o código expirou" pedem reações opostas — esperar mais ou
 * recomeçar —, e um `catch` só faria as duas parecerem a mesma falha.
 */
export async function pollDeviceFlow(url: string, deviceCode: string): Promise<PollOutcome> {
  const response = await fetch(`${trim(url)}/v1/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  });

  const payload = (await response.json()) as {
    data?: Omit<HubCredential, 'url'>;
    error?: { code?: string; retryAfter?: string };
  };

  if (response.ok && payload.data !== undefined) {
    return { kind: 'ready', credential: payload.data };
  }

  switch (payload.error?.code) {
    case 'DEVICE_AUTHORIZATION_PENDING':
      return { kind: 'pending' };

    case 'SLOW_DOWN':
      return { kind: 'slow-down', interval: 5 };

    case 'DEVICE_AUTHORIZATION_DENIED':
    case 'DEVICE_REVOKED':
      return { kind: 'denied' };

    case 'DEVICE_CODE_EXPIRED':
    case 'DEVICE_CODE_INVALID':
      return { kind: 'expired' };

    default:
      throw new Error(`O Hub respondeu ${String(response.status)}.`);
  }
}

/** Confere se a credencial ainda vale, sem alterar nada. */
export async function whoami(
  credential: HubCredential,
): Promise<{ name: string; email: string } | null> {
  try {
    const response = await fetch(`${trim(credential.url)}/v1/me`, {
      headers: { authorization: `Bearer ${credential.deviceToken}` },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { data?: { user?: { name: string; email: string } } };

    return payload.data?.user ?? null;
  } catch {
    // Hub fora do ar não é credencial inválida — quem chama distingue os dois.
    return null;
  }
}

function trim(url: string): string {
  return url.replace(/\/+$/, '');
}
