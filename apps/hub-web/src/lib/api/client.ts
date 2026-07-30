import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/env';
import { failure, success, type ApiResult } from './result';

/**
 * Cliente HTTP da Hub API.
 *
 * Toda ida à API passa por aqui. As telas não conhecem `fetch`, URL, envelope
 * nem código de status: recebem um `ApiResult` já classificado. Quando a API
 * subir, é este arquivo — e só ele — que precisa acompanhar mudanças de
 * transporte.
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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Token de acesso da sessão. Vem do cookie HttpOnly, nunca do cliente. */
  accessToken?: string | undefined;
  /** Comandos críticos do `Docs/06` mandam chave de idempotência. */
  idempotencyKey?: string;
  /** Segundos de cache do Next. `0` desliga. */
  revalidate?: number;
  signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Faz uma requisição e devolve o corpo já validado pelo schema informado.
 * O schema descreve o conteúdo de `data`, não o envelope.
 */
export async function hubRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: HubRequestOptions = {},
): Promise<ApiResult<T>> {
  const { HUB_API_URL } = env();
  const url = new URL(path.startsWith('/') ? path : `/${path}`, HUB_API_URL);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
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
    return failure('offline');
  }

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
    return failure(statusToKind(response.status), details);
  }

  const envelope = successEnvelope.safeParse(payload);
  if (!envelope.success) {
    return failure('error', { code: 'INVALID_ENVELOPE', message: 'A resposta fugiu do contrato.' });
  }

  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) {
    // Contrato quebrado é erro de servidor, não dado bom: a tela não recebe lixo.
    return failure('error', { code: 'INVALID_PAYLOAD', message: parsed.error.message });
  }

  return success(parsed.data);
}

function statusToKind(status: number) {
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
