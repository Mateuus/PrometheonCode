import { PrometheonError } from '../utils/errors';

/**
 * Device flow do Prometheon Hub, o mesmo fluxo de seis passos do
 * `Docs/09_AUTH_SECURITY_PERMISSIONS.md`.
 *
 * A extensão nunca pede a senha da conta: ela solicita um código, abre o
 * navegador para o usuário autorizar na sessão dele e faz polling até receber a
 * credencial do dispositivo. Nada aqui grava segredo — quem guarda é o
 * `SecretStore`, sobre o `vscode.SecretStorage`.
 */

export class DeviceAuthorizationError extends PrometheonError {
  constructor(
    message: string,
    /** Código devolvido pelo Hub, quando houver. */
    readonly reason?: string,
  ) {
    super(message, 'hub.device-authorization-failed');
  }
}

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  /** Endereço que o usuário abre para autorizar. */
  readonly verificationUri: string;
  /** Mesmo endereço já com o código preenchido, quando o Hub oferece. */
  readonly verificationUriComplete?: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface DeviceCredential {
  readonly token: string;
  readonly deviceId: string;
  /** Instante de expiração em milissegundos, ou `null` quando não expira. */
  readonly expiresAt: number | null;
  readonly organizationId?: string;
  /** Quem autorizou, para a interface dizer como quem o dispositivo entrou. */
  readonly userName?: string;
  readonly userEmail?: string;
}

/** Resultado de uma tentativa de troca do código por credencial. */
export type PollOutcome =
  | { readonly kind: 'pending' }
  /** O Hub pediu para diminuir o ritmo; o intervalo novo já vem aplicado. */
  | { readonly kind: 'slow-down'; readonly intervalSeconds: number }
  | { readonly kind: 'denied'; readonly reason: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'authorized'; readonly credential: DeviceCredential };

export interface HubHttp {
  /** Faz uma chamada à API do Hub e devolve status e corpo já em JSON. */
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function positiveInteger(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Como o dispositivo se identifica ao Hub. Espelha o contrato público. */
export interface DeviceIdentity {
  readonly deviceName: string;
  /** `vscode` para esta extensão; os outros valores existem para CLI e CI. */
  readonly deviceKind: 'vscode' | 'cli' | 'ci' | 'other';
  readonly clientVersion?: string;
  readonly platform?: string;
}

/** Passo 1: pede um código de dispositivo. */
export async function requestDeviceAuthorization(
  http: HubHttp,
  identity: DeviceIdentity,
): Promise<DeviceAuthorization> {
  const response = await http.post('/v1/auth/device/authorize', identity);
  const data = record(record(response.body)['data']);

  const deviceCode = text(data, 'deviceCode');
  const userCode = text(data, 'userCode');
  const verificationUri = text(data, 'verificationUri');

  if (response.status >= 400 || deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new DeviceAuthorizationError(
      messageFrom(response.body) ?? 'The Hub did not return a device code.',
    );
  }

  const complete = text(data, 'verificationUriComplete');
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete === undefined ? {} : { verificationUriComplete: complete }),
    expiresInSeconds: positiveInteger(data, 'expiresIn') ?? 600,
    // O piso de 5 segundos evita que um valor ausente vire polling agressivo.
    intervalSeconds: Math.max(5, positiveInteger(data, 'interval') ?? 5),
  };
}

/**
 * Passo 4: uma tentativa de troca. O chamador é quem controla o ritmo — assim
 * o cancelamento pelo usuário é imediato, sem esperar o timer interno.
 */
export async function pollDeviceToken(http: HubHttp, deviceCode: string): Promise<PollOutcome> {
  const response = await http.post('/v1/auth/device/token', { deviceCode });
  const body = record(response.body);
  const data = record(body['data']);
  const error = record(body['error']);
  const code = text(error, 'code');

  if (response.status < 300) {
    const token = text(data, 'deviceToken');
    const deviceId = text(data, 'deviceId');
    if (token === undefined || deviceId === undefined) {
      throw new DeviceAuthorizationError('The Hub approved the device but did not return a credential.');
    }
    // O contrato manda o usuário junto da credencial; nome e e-mail deixam a
    // interface dizer "conectado como fulano" sem outra ida ao Hub.
    const user = record(data['user']);
    const userName = text(user, 'name');
    const userEmail = text(user, 'email');
    return {
      kind: 'authorized',
      credential: {
        token,
        deviceId,
        // O contrato entrega instante ISO, não duração — converter aqui evita
        // que cada chamador reinvente o cálculo e erre o fuso.
        expiresAt: parseInstant(text(data, 'expiresAt')),
        ...(text(data, 'organizationId') === undefined
          ? {}
          : { organizationId: text(data, 'organizationId') as string }),
        ...(userName === undefined ? {} : { userName }),
        ...(userEmail === undefined ? {} : { userEmail }),
      },
    };
  }

  // Os códigos são os do `errorCode` de `@prometheon/contracts`, não os nomes
  // genéricos do device flow do OAuth — o Hub tem vocabulário próprio.
  switch (code) {
    case 'DEVICE_AUTHORIZATION_PENDING':
      return { kind: 'pending' };
    case 'SLOW_DOWN':
      return {
        kind: 'slow-down',
        intervalSeconds: Math.max(5, positiveInteger(data, 'interval') ?? 10),
      };
    case 'DEVICE_AUTHORIZATION_DENIED':
    case 'DEVICE_REVOKED':
      return { kind: 'denied', reason: text(error, 'message') ?? 'Authorization was denied.' };
    case 'DEVICE_CODE_EXPIRED':
    case 'DEVICE_CODE_INVALID':
      return { kind: 'expired' };
    default:
      throw new DeviceAuthorizationError(
        text(error, 'message') ?? `The Hub refused the device code (HTTP ${response.status}).`,
        code,
      );
  }
}

/** Converte instante ISO em milissegundos; valor inválido vira `null`. */
function parseInstant(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function messageFrom(body: unknown): string | undefined {
  return text(record(record(body)['error']), 'message');
}
