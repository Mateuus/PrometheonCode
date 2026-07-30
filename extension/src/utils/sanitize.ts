/**
 * Remove de textos destinados a logs e diagnósticos qualquer coisa com cara de
 * credencial. Nenhum segredo do Prometheon deve chegar ao canal de log.
 */
const PATTERNS: readonly RegExp[] = [
  // token=..., "api_key": "...", Authorization: Bearer ...
  /((?:api[-_]?key|secret|token|password|passwd|authorization|cookie|refresh[-_]?token)["'\s]*[:=]\s*["']?)([^\s"',}]+)/gi,
  /(bearer\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi,
  // Credenciais embutidas em URL: https://user:pass@host
  /(\/\/[^:/\s]+:)([^@\s]+)(@)/g,
];

export function sanitize(text: string): string {
  let output = text;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string, _secret: string, suffix = '') =>
      `${prefix}***${suffix}`,
    );
  }
  return output;
}

export function sanitizeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return sanitize(value.message);
  }
  return sanitize(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));
}
