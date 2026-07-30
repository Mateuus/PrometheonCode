import { z } from 'zod';

/**
 * Configuração do servidor do Hub Web.
 *
 * O `.env` da raiz é carregado pelo `next.config.ts`. Nada aqui vaza para o
 * cliente: este módulo só é importado por código de servidor.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HUB_WEB_PORT: z.coerce.number().int().positive().default(3550),
  HUB_WEB_URL: z.string().url().default('http://127.0.0.1:3550'),
  HUB_API_URL: z.string().url().default('http://127.0.0.1:3551'),
  /**
   * Enquanto a Hub API não existe, as telas se alimentam de dados de exemplo.
   * Desligar este flag faz o app falar HTTP de verdade com `HUB_API_URL`.
   */
  HUB_WEB_SAMPLE_DATA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

let cached: z.infer<typeof schema> | undefined;

export function env(): z.infer<typeof schema> {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Configuração inválida do hub-web: ${parsed.error.message}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}
