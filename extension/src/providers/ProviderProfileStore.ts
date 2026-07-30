import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import { PROVIDER_IDS, type ProviderId, type ProviderProfile } from './types';

/**
 * Perfis ficam em `~/.prometheon/local-profiles.json`: são específicos da
 * máquina e da pessoa, então não entram no repositório nem no estado do
 * workspace, que é sincronizável. O arquivo guarda apenas metadados — o
 * diretório de configuração de cada CLI é que contém as credenciais, e ele é só
 * apontado, nunca lido.
 */
export class ProviderProfileStore {
  private profiles: ProviderProfile[] | null = null;

  constructor(private readonly logger: Logger) {}

  /** Raiz local do Prometheon nesta máquina. */
  get root(): vscode.Uri {
    return vscode.Uri.file(join(homedir(), '.prometheon'));
  }

  get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'local-profiles.json');
  }

  /** Diretório isolado de um perfil, derivado do provedor e do identificador. */
  directoryFor(providerId: ProviderId, profileId: string): string {
    return vscode.Uri.joinPath(this.root, 'providers', providerId, profileId).fsPath;
  }

  async list(): Promise<readonly ProviderProfile[]> {
    if (this.profiles === null) {
      this.profiles = await this.read();
    }
    return this.profiles;
  }

  async find(id: string): Promise<ProviderProfile | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  async save(profile: ProviderProfile): Promise<void> {
    const profiles = [...(await this.list())];
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index === -1) {
      profiles.push(profile);
    } else {
      profiles[index] = profile;
    }
    await this.write(profiles);
  }

  async remove(id: string): Promise<void> {
    const profiles = (await this.list()).filter((profile) => profile.id !== id);
    await this.write(profiles);
  }

  private async read(): Promise<ProviderProfile[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isProviderProfile);
    } catch {
      // Sem arquivo é o estado normal na primeira execução.
      return [];
    }
  }

  private async write(profiles: readonly ProviderProfile[]): Promise<void> {
    this.profiles = [...profiles];
    await vscode.workspace.fs.createDirectory(this.root);
    const content = `${JSON.stringify(profiles, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(content));
    this.logger.info(`Perfis de provedor gravados (${profiles.length}).`);
  }
}

/**
 * Validação de runtime do arquivo em disco: ele pode ter sido editado à mão, e
 * um perfil malformado não pode virar um `spawn` com diretório errado.
 */
function isProviderProfile(value: unknown): value is ProviderProfile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['id'] === 'string' &&
    candidate['id'].length > 0 &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['providerId'] === 'string' &&
    PROVIDER_IDS.includes(candidate['providerId']) &&
    typeof candidate['configDirectory'] === 'string' &&
    candidate['configDirectory'].length > 0 &&
    typeof candidate['enabled'] === 'boolean' &&
    typeof candidate['createdAt'] === 'number' &&
    typeof candidate['updatedAt'] === 'number'
  );
}
