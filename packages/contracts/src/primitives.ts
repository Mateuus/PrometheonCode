/**
 * Tipos primitivos compartilhados por todos os contratos.
 *
 * Regras do `Docs/03`: identificador é ULID em string, data trafega em ISO 8601
 * UTC e dinheiro é inteiro na menor unidade da moeda.
 */

import { z } from 'zod';

/** ULID canônico: 26 caracteres em Crockford Base32, sem I, L, O e U. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const ulidSchema = z
  .string()
  .regex(ULID_PATTERN, { message: 'must be a ULID' });

/** Data e hora em ISO 8601 com deslocamento zero (`...Z`). */
export const isoDateTimeSchema = z.iso.datetime();

/** Data simples `YYYY-MM-DD`. */
export const isoDateSchema = z.iso.date();

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));

/** Identificador legível usado em URLs. */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'must contain only lowercase letters, digits and hyphens',
      }),
  );

/** Contador de versão usado no controle otimista de concorrência. */
export const versionSchema = z.int().nonnegative();

/** Cursor opaco de paginação; o cliente devolve exatamente o que recebeu. */
export const cursorSchema = z.string().min(1).max(1024);

/** Chave de idempotência de comandos críticos. */
export const idempotencyKeySchema = z.string().min(8).max(255);

/** Identificador da requisição, ecoado em `meta` e em todo erro. */
export const requestIdSchema = z.string().min(1).max(64);

/** Código ISO 4217 em maiúsculas. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{3}$/, { message: 'must be an ISO 4217 code' }));

/**
 * Valor monetário. `amount` é inteiro na menor unidade — centavos, para BRL e
 * USD — porque ponto flutuante não guarda dinheiro.
 */
export const moneySchema = z.object({
  amount: z.int(),
  currency: currencyCodeSchema,
});

/** Texto curto de formulário. */
export const shortTextSchema = z.string().trim().min(1).max(255);

/** Texto longo, com teto para conter payload abusivo. */
export const longTextSchema = z.string().max(64_000);

/** Etiqueta livre aplicada a projetos, tarefas e conhecimento. */
export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().min(1).max(48));

export const tagsSchema = z.array(tagSchema).max(32);

/** Metadados livres, limitados em profundidade pelo uso — não guarde segredo. */
export const metadataSchema = z.record(z.string(), z.unknown());

export type Ulid = z.infer<typeof ulidSchema>;
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type Money = z.infer<typeof moneySchema>;
export type Cursor = z.infer<typeof cursorSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
