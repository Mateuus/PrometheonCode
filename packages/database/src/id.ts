// Geração de identificadores ULID.
//
// O `Docs/03` pede ULID/UUID consistente; escolhemos ULID porque ordena
// lexicograficamente por tempo de criação — o que dá índices bem comportados
// em `char(26)` e paginação por cursor sem coluna extra.
//
// Formato: 26 caracteres em base32 de Crockford, 10 de tempo (48 bits, ms desde
// a época) + 16 de aleatoriedade (80 bits).

import { randomBytes } from 'node:crypto';

/** Alfabeto base32 de Crockford: sem I, L, O e U. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
/** 48 bits: o maior instante representável em 10 caracteres. */
const MAX_TIME = 281_474_976_710_655;

export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Estado da monotonicidade: último instante e últimos índices sorteados. */
let lastTime = -1;
let lastRandom: number[] = [];

/** Codifica o instante em 10 caracteres, do mais significativo para o menos. */
function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new Error(`Instante fora da faixa representável em um ULID: ${time}.`);
  }
  let remaining = time;
  const chars = new Array<string>(TIME_LEN);
  for (let index = TIME_LEN - 1; index >= 0; index -= 1) {
    const mod = remaining % ENCODING_LEN;
    chars[index] = ENCODING[mod]!;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return chars.join('');
}

/**
 * Sorteia os 16 símbolos aleatórios. `byte & 31` não introduz viés porque 256
 * é múltiplo exato de 32.
 */
function randomIndexes(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const indexes = new Array<number>(RANDOM_LEN);
  for (let index = 0; index < RANDOM_LEN; index += 1) {
    indexes[index] = (bytes[index]!) & 0x1f;
  }
  return indexes;
}

/**
 * Incrementa em uma unidade a parte aleatória, tratando-a como um número de 80
 * bits. Devolve `false` quando estoura (todos os símbolos no valor máximo).
 */
function incrementRandom(indexes: number[]): boolean {
  for (let index = RANDOM_LEN - 1; index >= 0; index -= 1) {
    const value = indexes[index]!;
    if (value < ENCODING_LEN - 1) {
      indexes[index] = value + 1;
      return true;
    }
    indexes[index] = 0;
  }
  return false;
}

/**
 * Gera um ULID monotônico: dois identificadores criados no mesmo milissegundo
 * mantêm a ordem de criação quando comparados como texto.
 *
 * A monotonicidade é por processo. Entre processos vale a ordem por
 * milissegundo, que é o que os índices `(…, created_at)` precisam.
 */
export function newId(now: number = Date.now()): string {
  let time = Math.floor(now);
  if (time === lastTime) {
    if (!incrementRandom(lastRandom)) {
      // Estouro (improvável: exige 2^80 IDs no mesmo milissegundo). Avança um
      // milissegundo em vez de falhar — a ordem continua correta.
      time += 1;
      lastTime = time;
      lastRandom = randomIndexes();
    }
  } else if (time < lastTime) {
    // Relógio andou para trás (NTP). Preserva a ordem reutilizando o último
    // instante conhecido em vez de emitir um ID "no passado".
    if (!incrementRandom(lastRandom)) {
      lastTime += 1;
      lastRandom = randomIndexes();
    }
    time = lastTime;
  } else {
    lastTime = time;
    lastRandom = randomIndexes();
  }

  let random = '';
  for (const index of lastRandom) {
    random += ENCODING[index]!;
  }
  return encodeTime(time) + random;
}

/** Verifica se o texto tem forma de ULID (tamanho e alfabeto). */
export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** Extrai o instante de criação embutido no ULID, em milissegundos UTC. */
export function ulidTime(value: string): number {
  if (!isUlid(value)) {
    throw new Error(`Identificador não é um ULID válido: ${value}.`);
  }
  let time = 0;
  for (let index = 0; index < TIME_LEN; index += 1) {
    const position = ENCODING.indexOf(value[index]!);
    if (position === -1) {
      throw new Error(`Caractere fora do alfabeto ULID: ${value[index] ?? ''}.`);
    }
    time = time * ENCODING_LEN + position;
  }
  return time;
}

/** Reinicia o estado monotônico. Existe para os testes, não para o runtime. */
export function resetIdState(): void {
  lastTime = -1;
  lastRandom = [];
}
