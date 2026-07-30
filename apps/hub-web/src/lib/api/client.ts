import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/env';
import { failure, success, type ApiResult } from './result';

/**
 * Cliente HTTP da Hub API.
 *
 * Toda ida à API passa por aqui. As telas não conhecem `fetch`, URL, envelope
 * nem código de status: recebem um `ApiResult` já classificado.
 *
 * O navegador **nunca** fala com a Hub API. O Hub Web é um BFF: o token de
 * acesso vive num cookie `HttpOnly` que só o servidor lê, e a CSP mantém
 * `connect-src` fechado no próprio Hub — a exceção é o WebSocket, que precisa de
 * um bilhete de uso único emitido por `/api/realtime/ticket`.
 */

const successEnvelope = z.object({
  data: z.unknown(),
  meta: z.object({ requestId: z.string() }).partial().optional(),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

export interface HubRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Parâmetros de query. `undefined` é omitido. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Token de acesso da sessão. Vem do cookie HttpOnly, nunca do cliente. */
  accessToken?: string | undefined;
  /**
   * Cookies da Hub API sob custódia do Hub Web (`prom_refresh`, `prom_csrf`).
   * Só o fluxo de autenticação os usa; o resto do app manda `Authorization`.
   */
  apiCookies?: Record<string, string> | undefined;
  /** Valor do cookie CSRF, ecoado no cabeçalho que a API exige. */
  csrfToken?: string | undefined;
  /**
   * Manda `Origin` do Hub Web. É isso que faz a API tratar a chamada como
   * vinda do navegador e devolver o refresh em cookie `HttpOnly` em vez do
   * corpo. Fora da autenticação não faz diferença — e sem cookie de refresh
   * junto, a API nem cobra CSRF.
   */
  browserOrigin?: boolean;
  /** Comandos críticos do `Docs/06` mandam chave de idempotência. */
  idempotencyKey?: string;
  /** Segundos de cache do Next. Omitido desliga o cache. */
  revalidate?: number;
  signal?: AbortSignal;
}

export interface HubResponse<T> {
  result: ApiResult<T>;
  /** `Set-Cookie` devolvidos pela API, já separados em nome → valor. */
  cookies: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Códigos que valem mais que o status HTTP na hora de escolher o estado de
 * tela. `EMAIL_NOT_VERIFIED` chega como 401 numa rota e 403 noutra; o que a
 * interface precisa mostrar é a mesma coisa nas duas.
 */
function kindFor(status: number, code: string | undefined) {
  if (code === 'EMAIL_NOT_VERIFIED') {
    return 'email-unverified' as const;
  }
  if (status === 401) {
    return 'unauthorized' as const;
  }
  if (status === 403) {
    return 'forbidden' as const;
  }
  if (status === 404) {
    return 'not-found' as const;
  }
  if (status >= 502 && status <= 504) {
    // Gateway fora do ar é indistinguível de rede fora, do ponto de vista da tela.
    return 'offline' as const;
  }
  return 'error' as const;
}

/**
 * Faz uma requisição e devolve o corpo já validado pelo schema informado,
 * junto dos cookies que a API pediu para gravar.
 * O schema descreve o conteúdo de `data`, não o envelope.
 */
export async function hubRequestWithCookies<T>(
  path: string,
  schema: z.ZodType<T>,
  options: HubRequestOptions = {},
): Promise<HubResponse<T>> {
  const { HUB_API_URL, HUB_WEB_URL } = env();
  const url = new URL(path.startsWith('/') ? path : `/${path}`, HUB_API_URL);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
  }
  if (options.browserOrigin) {
    headers.origin = HUB_WEB_URL;
  }
  if (options.apiCookies && Object.keys(options.apiCookies).length > 0) {
    headers.cookie = Object.entries(options.apiCookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
  if (options.csrfToken) {
    headers['x-csrf-token'] = options.csrfToken;
  }
  if (options.idempotencyKey) {
    headers['idempotency-key'] = options.idempotencyKey;
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  // O objeto é montado por partes porque `exactOptionalPropertyTypes` recusa
  // `undefined` explícito onde o tipo não o prevê.
  const init: RequestInit & { next?: { revalidate: number } } = {
    method: options.method ?? 'GET',
    headers,
    signal,
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  if (options.revalidate === undefined) {
    init.cache = 'no-store';
  } else {
    init.next = { revalidate: options.revalidate };
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // Rede fora, DNS quebrado ou timeout: para o usuário, isso é "offline".
    return { result: failure('offline'), cookies: {} };
  }

  const cookies = parseSetCookie(response.headers.getSetCookie());
  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const parsed = errorEnvelope.safeParse(payload);
    const details = parsed.success
      ? {
          code: parsed.data.error.code,
          message: parsed.data.error.message,
          ...(parsed.data.error.requestId ? { requestId: parsed.data.error.requestId } : {}),
        }
      : {};
    return {
      result: failure(kindFor(response.status, parsed.success ? parsed.data.error.code : undefined), details),
      cookies,
    };
  }

  const envelope = successEnvelope.safeParse(payload);
  if (!envelope.success) {
    return {
      result: failure('error', { code: 'INVALID_ENVELOPE', message: 'A resposta fugiu do contrato.' }),
      cookies,
    };
  }

  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) {
    // Contrato quebrado é erro de servidor, não dado bom: a tela não recebe lixo.
    return {
      result: failure('error', { code: 'INVALID_PAYLOAD', message: parsed.error.message }),
      cookies,
    };
  }

  return { result: success(parsed.data), cookies };
}

/** A forma usada em 95% das chamadas: só o resultado interessa. */
export async function hubRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: HubRequestOptions = {},
): Promise<ApiResult<T>> {
  return (await hubRequestWithCookies(path, schema, options)).result;
}

function parseSetCookie(values: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const raw of values) {
    const pair = raw.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) {
      cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
  }
  return cookies;
}
