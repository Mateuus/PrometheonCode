import { describe, expect, it } from 'vitest';

import { assessSecret, MIN_SECRET_BYTES, secretEntropyBytes } from './secrets.js';
import { TEST_SECRET_KEYS, testSecretFor } from './test-fallbacks.js';

describe('secretEntropyBytes', () => {
  it('decodes hexadecimal', () => {
    expect(secretEntropyBytes('a'.repeat(64))).toBe(32);
    expect(secretEntropyBytes('0123456789abcdef')).toBe(8);
  });

  it('decodes base64url', () => {
    const value = Buffer.from('x'.repeat(32)).toString('base64url');

    expect(secretEntropyBytes(value)).toBe(32);
  });

  it('falls back to utf-8 byte length', () => {
    expect(secretEntropyBytes('não-é-base64!!')).toBe(
      Buffer.byteLength('não-é-base64!!', 'utf8'),
    );
  });

  it('returns zero for an empty string', () => {
    expect(secretEntropyBytes('')).toBe(0);
  });
});

describe('assessSecret', () => {
  it('accepts a random 32 byte value', () => {
    const value = Buffer.from(
      Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 251),
    ).toString('base64url');

    const assessment = assessSecret(value);

    expect(assessment.ok).toBe(true);
  });

  it('rejects an empty value', () => {
    expect(assessSecret('')).toMatchObject({ ok: false });
  });

  it('rejects surrounding whitespace', () => {
    expect(assessSecret(' abc ')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('whitespace'),
    });
  });

  it('rejects low variation values', () => {
    expect(assessSecret('ab'.repeat(40))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('variation'),
    });
  });

  it(`rejects anything under ${String(MIN_SECRET_BYTES)} bytes`, () => {
    expect(assessSecret('Kq7bZ3xW9tR2vN8mL5cP1y')).toMatchObject({ ok: false });
  });
});

describe('test secrets', () => {
  it('are deterministic, distinct and strong enough', () => {
    const values = TEST_SECRET_KEYS.map(testSecretFor);

    expect(new Set(values).size).toBe(TEST_SECRET_KEYS.length);

    for (const value of values) {
      expect(assessSecret(value)).toMatchObject({ ok: true });
      expect(testSecretFor(TEST_SECRET_KEYS[0]!)).toBe(
        testSecretFor(TEST_SECRET_KEYS[0]!),
      );
    }
  });
});
