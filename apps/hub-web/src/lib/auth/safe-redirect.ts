/**
 * Proteção contra open redirect (`Docs/05`).
 *
 * O login aceita `?next=` para devolver o usuário à página que ele tentou abrir.
 * Sem filtro, esse parâmetro é um convite a phishing: basta um link
 * `/login?next=https://sitefalso` para que o Hub, com o domínio dele, jogue a
 * pessoa em outro lugar logo depois de autenticar.
 *
 * A regra aqui é curta e fechada: só passa caminho relativo à raiz. Nada de
 * host, nada de esquema, nada de `//` que o navegador leria como protocolo
 * relativo, nada de barra invertida — que alguns parsers tratam como `/`.
 */

export const DEFAULT_REDIRECT = '/app';

/**
 * Controles, espaço e DEL fazem parsers de URL divergirem entre si, e é dessa
 * divergência que sai o contorno. Slugs legítimos não usam nenhum deles.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function safeRedirect(
  target: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT,
): string {
  if (typeof target !== 'string' || target.length === 0) {
    return fallback;
  }

  // Percent-encoding pode esconder `/` e `\`; normalizar antes de julgar.
  let candidate = target;
  try {
    candidate = decodeURIComponent(target);
  } catch {
    return fallback;
  }

  if (hasUnsafeCharacter(candidate)) {
    return fallback;
  }

  if (!candidate.startsWith('/')) {
    return fallback;
  }

  // `//evil.com` e `/\evil.com` são absolutos para o navegador.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return fallback;
  }

  if (candidate.includes('\\')) {
    return fallback;
  }

  // `/x:y` não deveria virar esquema, mas parsers divergem.
  if (/^\/[^/?#]*:/.test(candidate)) {
    return fallback;
  }

  return candidate;
}
