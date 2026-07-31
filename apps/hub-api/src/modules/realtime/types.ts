/**
 * Formas internas do tempo real.
 *
 * O envelope aqui é **deliberadamente mais frouxo** que
 * `realtimeEventSchema` de `@prometheon/contracts`. Aquele é um union
 * discriminado que valida o `data` de cada tipo de evento, e é o contrato que o
 * **cliente** aplica. O servidor valida apenas o invólucro — identificador,
 * tipo, organização, instante e cursor — e repassa o `data` como veio do
 * outbox.
 *
 * O motivo é operacional: o publicador é outro processo, e os payloads nascem
 * em módulos que evoluem em ritmos diferentes. Um servidor que recusasse
 * envelope cujo `data` ainda não conhece transformaria "um módulo acrescentou um
 * campo" em "o tempo real parou" — para todos os eventos, não só para aquele.
 * Repassar mantém a falha local ao cliente que se importa com aquele tipo.
 */

import { z } from 'zod';

import { isoDateTimeSchema, ulidSchema } from '@prometheon/contracts';

export const realtimeEnvelopeSchema = z.object({
  id: ulidSchema,
  type: z.string().min(1).max(96),
  version: z.int().positive(),
  organizationId: ulidSchema,
  projectId: ulidSchema.nullable(),
  occurredAt: isoDateTimeSchema,
  cursor: z.string().min(1).max(1024),
  aggregate: z
    .object({
      type: z.string().max(64),
      id: z.string().max(64),
      sequence: z.number().nullable(),
    })
    .optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;

/** Inscrição já conferida contra a autorização, do jeito que o hub consulta. */
export interface AuthorizedSubscription {
  readonly organizationId: string;
  readonly projectId: string | null;
  /** Vazio significa "todos os tipos". */
  readonly eventTypes: ReadonlySet<string>;
  /**
   * Projetos visíveis, quando a inscrição é da organização inteira.
   *
   * Sem isto, "assinar a organização" entregaria os eventos de todo projeto
   * privado dela — inclusive os que a pessoa não pode ver. Fica `undefined`
   * numa inscrição de projeto, onde a própria autorização já resolveu a questão.
   */
  readonly allowedProjectIds?: ReadonlySet<string> | undefined;
}

/** Quem está do outro lado do socket. */
export interface RealtimePrincipal {
  readonly userId: string;
  readonly kind: 'user' | 'device';
  readonly sessionId: string | null;
  readonly deviceId: string | null;
  readonly organizationId: string | null;
}

/**
 * Instante embutido num ULID, em milissegundos.
 *
 * Os dez primeiros caracteres são 48 bits de tempo em Crockford Base32. É o que
 * permite decidir se um cursor caiu fora da janela de retomada sem ir ao banco.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulidTimestamp(id: string): number | undefined {
  if (id.length < 10) {
    return undefined;
  }

  let value = 0;

  for (const character of id.slice(0, 10)) {
    const digit = CROCKFORD.indexOf(character.toUpperCase());

    if (digit === -1) {
      return undefined;
    }

    value = value * 32 + digit;
  }

  return value;
}

/**
 * Menor ULID possível de um instante — o piso da janela de retomada.
 *
 * A janela é recortada **pelo próprio identificador**, e não por uma coluna de
 * data, por dois motivos. O primeiro é de correção: `outbox_messages.created_at`
 * tem `DEFAULT CURRENT_TIMESTAMP(3)`, então quem o preenche é o servidor MySQL,
 * com o fuso da sessão dele — comparar esse valor com um `Date` do Node
 * silenciosamente devolve nada quando os dois relógios não estão no mesmo fuso.
 * O segundo é de desempenho: `id` é a chave primária, e um intervalo de quinze
 * minutos vira um range scan estreito nela.
 */
export function ulidFloor(milliseconds: number): string {
  let time = '';
  let remaining = Math.max(0, Math.floor(milliseconds));

  for (let index = 0; index < 10; index += 1) {
    time = (CROCKFORD[remaining % 32] ?? '0') + time;
    remaining = Math.floor(remaining / 32);
  }

  return `${time}0000000000000000`;
}
