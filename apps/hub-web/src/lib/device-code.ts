/**
 * Código de usuário do device flow (`Docs/09`).
 *
 * Espelha `normalizeUserCode` de `apps/hub-api/src/shared/crypto.ts`. A
 * duplicação é consciente: o Hub Web não importa código da hub-api, e ainda
 * assim precisa mandar a forma canônica — `r5rw vzwh` colado do editor tem de
 * virar `R5RW-VZWH` antes de encarar a validação de rota (6 a 16 caracteres),
 * que roda antes de a API sequer normalizar.
 */
export function normalizeUserCode(input: string | null | undefined): string {
  const cleaned = (input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');

  if (cleaned.length !== 8) {
    return cleaned;
  }

  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}
