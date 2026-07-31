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
   * Só a presença, para decidir se o botão aparece.
   *
   * O client id é público — vai na URL de autorização de qualquer forma. O
   * **secret** não passa por aqui e nem poderia: quem troca o código por token é
   * a API. Ler a mesma variável que a API usa evita a dessincronia clássica de
   * um sinalizador separado que alguém esquece de virar junto.
   */
  GITHUB_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
});

let cached: z.infer<typeof schema> | undefined;

/**
 * Variável declarada e vazia vale como ausente.
 *
 * Um `.env` de exemplo lista as chaves opcionais sem valor — é assim que se
 * documenta o que existe. Sem esta limpeza, `GITHUB_OAUTH_CLIENT_ID=` chega ao
 * Zod como string vazia, falha o `min(1)` e derruba o servidor inteiro por uma
 * configuração que a pessoa deliberadamente não preencheu.
 *
 * O `@prometheon/config`, do lado da API, já faz o mesmo antes de validar.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      clean[key] = value;
    }
  }

  return clean;
}

export function env(): z.infer<typeof schema> {
  if (!cached) {
    const parsed = schema.safeParse(withoutBlanks(process.env));
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

/**
 * Endereço do WebSocket de tempo real, derivado da URL da API.
 * O bilhete de conexão vem de `/api/realtime/ticket`; aqui só mora o host.
 */
export function realtimeOrigin(): string {
  const api = new URL(env().HUB_API_URL);
  return `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}`;
}
