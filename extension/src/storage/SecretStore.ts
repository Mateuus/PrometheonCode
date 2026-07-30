import type * as vscode from 'vscode';

/** Chaves conhecidas de segredos. Nada além disto deve ser gravado. */
export type SecretKey = 'hub.token' | 'hub.refreshToken';

/**
 * Único caminho autorizado para credenciais. Delega tudo ao
 * `vscode.SecretStorage`: nenhum segredo vai para disco no projeto, para
 * `.prometheon/`, para configurações ou para logs.
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get(key: SecretKey): Thenable<string | undefined> {
    return this.secrets.get(qualify(key));
  }

  store(key: SecretKey, value: string): Thenable<void> {
    return this.secrets.store(qualify(key), value);
  }

  delete(key: SecretKey): Thenable<void> {
    return this.secrets.delete(qualify(key));
  }

  async has(key: SecretKey): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }
}

function qualify(key: SecretKey): string {
  return `prometheon.${key}`;
}
