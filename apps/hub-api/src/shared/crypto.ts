/**
 * Primitivas criptográficas de uso geral.
 *
 * Nada aqui inventa criptografia (`Docs/09`): são chamadas diretas ao `node:crypto`
 * com os parâmetros explicados. A regra que atravessa o arquivo: **segredo em
 * texto puro existe uma única vez, no momento da emissão**. O que fica guardado
 * é sempre o SHA-256 hexadecimal.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 32 bytes = 256 bits de entropia. Nada abaixo disso é emitido pelo Hub. */
export const TOKEN_BYTES = 32;

/**
 * Token opaco em base64url.
 *
 * Base64url porque o valor viaja em URL de e-mail e em header sem escapar.
 */
export function randomToken(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 hexadecimal do token.
 *
 * Aqui não se usa Argon2: o token já tem 256 bits de aleatoriedade uniforme, e
 * força bruta sobre isso é inviável independentemente do custo do hash. Argon2
 * existe para compensar a entropia baixa de senhas escolhidas por humanos —
 * aplicá-lo a um token só tornaria cada requisição autenticada 50 ms mais
 * lenta, sem ganho de segurança.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Comparação em tempo constante de dois hexadecimais.
 *
 * A busca no banco já é feita pelo hash (índice único), então o uso principal
 * daqui é comparar valores que chegaram por caminhos diferentes — CSRF, por
 * exemplo — sem vazar o quanto os dois prefixos coincidem.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  // `timingSafeEqual` exige buffers do mesmo tamanho. Comparar o tamanho antes
  // vaza apenas o comprimento, que não é segredo em nenhum dos usos.
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

/**
 * Alfabeto do código que a pessoa digita no navegador durante o device flow.
 *
 * É o Crockford Base32 sem as letras ambíguas — sem I, L, O e U — pelo mesmo
 * motivo dos ULIDs: ninguém confunde `0` com `O` lendo em voz alta, e o `U` sai
 * para reduzir a chance de o gerador formar uma palavra ofensiva.
 */
const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Código de usuário no formato `XXXX-XXXX`.
 *
 * Oito símbolos de 32 possibilidades dão 40 bits. O código vive 10 minutos e o
 * endpoint de consulta é limitado por rate limit, então adivinhá-lo dentro da
 * janela é impraticável. `randomInt` usa o CSPRNG do sistema e rejeita amostras
 * enviesadas — `Math.random()` não serviria aqui.
 */
export function generateUserCode(): string {
  const symbols: string[] = [];

  for (let index = 0; index < 8; index += 1) {
    symbols.push(USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]!);
  }

  return `${symbols.slice(0, 4).join('')}-${symbols.slice(4).join('')}`;
}

/** Normaliza o que o usuário digitou: maiúsculas, com hífen no meio. */
export function normalizeUserCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');

  if (cleaned.length !== 8) {
    return cleaned;
  }

  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}
