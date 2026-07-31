/**
 * Hash de senha com Argon2id.
 *
 * Argon2id é o que o `Docs/09` pede e o que o OWASP recomenda hoje: ele combina
 * a resistência a ataque por canal lateral do Argon2i com a resistência a
 * hardware dedicado do Argon2d. A biblioteca é a `argon2` (binding do
 * `libargon2` de referência) — nada aqui implementa criptografia.
 *
 * Os parâmetros vivem em `config/index.ts`, comentados um a um.
 */

import { argon2id, hash, needsRehash as argon2NeedsRehash, verify } from 'argon2';

import { ARGON2_OPTIONS } from '../../config/index.js';

/**
 * Hash de referência para o caminho "usuário não existe".
 *
 * Ele é verificado contra a senha enviada quando o e-mail não está cadastrado,
 * para que login com conta inexistente custe o mesmo que login com senha
 * errada. Sem isso, a diferença de alguns milissegundos entre "respondeu na
 * hora" e "respondeu depois do Argon2" entrega quais e-mails existem — que é
 * exatamente a enumeração que o `Docs/09` manda evitar.
 *
 * O valor é derivado de uma senha aleatória gerada no boot: ninguém, nem quem
 * lê este código, consegue produzir uma senha que case com ele.
 */
let dummyHash: string | undefined;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, { type: argon2id, ...ARGON2_OPTIONS });
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    // Hash corrompido ou em formato desconhecido: é falha de verificação, não
    // erro de servidor. Nunca deixe isto virar "senha aceita".
    return false;
  }
}

/**
 * Gasta o mesmo tempo de uma verificação real.
 *
 * Chamado quando o e-mail não existe ou quando a conta não tem senha definida.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= await hashPassword(
    // 32 bytes aleatórios em hexadecimal; a senha correspondente nunca existiu.
    Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
  );

  await verifyPassword(dummyHash, password);

  return false;
}

/**
 * Diz se o hash foi gerado com parâmetros mais fracos que os atuais.
 *
 * Quando o custo do Argon2id subir, o login de quem tem hash antigo continua
 * funcionando (a biblioteca lê os parâmetros do próprio hash) e o hash é
 * regravado com o custo novo — sem pedir nada ao usuário.
 */
export function needsRehash(digest: string): boolean {
  // `needsRehash` compara apenas custo e versão — o tipo do algoritmo já está
  // codificado no próprio digest.
  return argon2NeedsRehash(digest, {
    timeCost: ARGON2_OPTIONS.timeCost,
    memoryCost: ARGON2_OPTIONS.memoryCost,
    parallelism: ARGON2_OPTIONS.parallelism,
  });
}
