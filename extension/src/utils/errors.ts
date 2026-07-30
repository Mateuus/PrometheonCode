import type { SerializedError } from '../core/types';

/** Erro base do Prometheon, com código estável para a webview reagir. */
export class PrometheonError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Web Chat foi acionado sem um Hub configurado. */
export class HubNotConfiguredError extends PrometheonError {
  constructor(
    message = 'Web Chat keeps conversations and approved context synchronized through Prometheon Hub. Connect a Hub to continue.',
  ) {
    super(message, 'hub.not-configured');
  }
}

/** Uma ação foi negada pelas políticas de permissão. */
export class PermissionDeniedError extends PrometheonError {
  constructor(message: string) {
    super(message, 'permission.denied');
  }
}

/** Mensagem recebida da webview não passou na validação de runtime. */
export class InvalidMessageError extends PrometheonError {
  constructor(message: string) {
    super(message, 'message.invalid');
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof PrometheonError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}
