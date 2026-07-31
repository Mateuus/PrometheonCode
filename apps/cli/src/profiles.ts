/**
 * Contas de provedor configuradas nesta máquina.
 *
 * O arquivo é o mesmo que a extensão do VS Code escreve. Quem já configurou
 * pelo editor não configura de novo aqui, e quem configurar aqui aparece lá —
 * duas listas separadas divergiriam na primeira mudança, e a pessoa levaria um
 * tempo até entender por que a conta some ao trocar de ferramenta.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prometheonHome } from './doctor.js';

export interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  /** Diretório isolado de credenciais do CLI. É o que separa uma conta de outra. */
  readonly configDirectory: string;
  readonly executablePath?: string;
  readonly enabled: boolean;
}

function profilesPath(): string {
  return join(prometheonHome(), 'local-profiles.json');
}

export async function listProfiles(): Promise<readonly ProviderProfile[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(profilesPath(), 'utf8'));

    return Array.isArray(parsed) ? (parsed as ProviderProfile[]) : [];
  } catch {
    // Arquivo ausente é o estado de quem nunca usou, não um erro.
    return [];
  }
}

/**
 * A conta que o `run` vai usar.
 *
 * A primeira habilitada do provedor. A escolha é previsível e não depende de
 * estado guardado noutro lugar, que poderia divergir do que a extensão mostra.
 */
export async function activeProfile(
  providerId = 'claude-code',
): Promise<ProviderProfile | undefined> {
  const profiles = await listProfiles();

  return profiles.find((profile) => profile.providerId === providerId && profile.enabled);
}

export async function saveProfiles(profiles: readonly ProviderProfile[]): Promise<void> {
  await mkdir(prometheonHome(), { recursive: true });
  await writeFile(profilesPath(), `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
}
