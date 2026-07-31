import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { MAX_MODEL_LENGTH, type ProviderModels } from '../core/types';
import type { Logger } from '../logger';
import type { ModelChoice } from './types';

const decoder = new TextDecoder();

/** Nome do arquivo, igual nos dois escopos. */
export const MODELS_FILE = 'models.json';

/** Teto por provedor: acima disso a lista deixa de ser escolhível numa tela. */
export const MAX_MODELS_PER_PROVIDER = 40;

/**
 * Modelos que a interface oferece, por provedor.
 *
 * O catálogo é dado, não código: vive em `media/models.json`, e quem quiser
 * acrescentar um modelo recém-lançado escreve `~/.prometheon/models.json` sem
 * esperar por uma versão da extensão. As duas listas são mescladas — a do
 * usuário por cima, provedor a provedor.
 *
 * Nada aqui é gate. O campo Model do Agent Profile continua aceitando texto
 * livre: o provedor lança modelo sem avisar, e recusar um identificador novo
 * faria o Prometheon ser o motivo de você não usar o mais recente.
 */
export class ModelCatalog {
  private cache: readonly ProviderModels[] | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: Logger,
  ) {}

  get bundledFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media', MODELS_FILE);
  }

  get userFile(): vscode.Uri {
    return vscode.Uri.file(join(homedir(), '.prometheon', MODELS_FILE));
  }

  async list(): Promise<readonly ProviderModels[]> {
    if (this.cache === null) {
      this.cache = merge(await this.read(this.bundledFile), await this.read(this.userFile));
    }
    return this.cache;
  }

  /** Descarta o cache. A próxima leitura relê os dois arquivos. */
  invalidate(): void {
    this.cache = null;
  }

  async forProvider(providerId: string): Promise<readonly ModelChoice[]> {
    return (await this.list()).find((entry) => entry.providerId === providerId)?.models ?? [];
  }

  private async read(file: vscode.Uri): Promise<readonly ProviderModels[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(file)));
    } catch (error) {
      // Ausente é o estado normal do arquivo do usuário; ilegível vira aviso e
      // lista vazia, para um JSON quebrado não deixar o painel sem modelos.
      if (!(error instanceof vscode.FileSystemError)) {
        this.logger.warn(`Não foi possível ler ${file.fsPath}: ${String(error)}`);
      }
      return [];
    }
    return normalizeCatalog(parsed, (message) => this.logger.warn(message));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > maxLength ? null : trimmed;
}

/**
 * Lê `{ providers: { <id>: [...] } }`.
 *
 * Uma entrada malformada é descartada sozinha, e não leva o arquivo junto: um
 * modelo escrito errado à mão não pode esvaziar a lista dos outros.
 */
export function normalizeCatalog(
  raw: unknown,
  warn: (message: string) => void,
): readonly ProviderModels[] {
  const providers = isRecord(raw) ? raw['providers'] : undefined;
  if (!isRecord(providers)) {
    if (raw !== undefined && raw !== null) {
      warn('models.json não tem um mapa `providers`; ignorado.');
    }
    return [];
  }

  const result: ProviderModels[] = [];
  for (const [providerId, value] of Object.entries(providers)) {
    if (!Array.isArray(value)) {
      warn(`models.json: a lista de "${providerId}" não é um array; ignorada.`);
      continue;
    }
    const models: ModelChoice[] = [];
    const seen = new Set<string>();
    for (const entry of value.slice(0, MAX_MODELS_PER_PROVIDER)) {
      const model = normalizeModel(entry);
      if (model === null) {
        warn(`models.json: entrada inválida em "${providerId}"; descartada.`);
        continue;
      }
      if (!seen.has(model.id)) {
        seen.add(model.id);
        models.push(model);
      }
    }
    if (models.length > 0) {
      result.push({ providerId, models });
    }
  }
  return result;
}

function normalizeModel(value: unknown): ModelChoice | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = text(value['id'], MAX_MODEL_LENGTH);
  if (id === null) {
    return null;
  }
  // Rótulo ausente cai no próprio id: melhor mostrar o identificador cru do que
  // descartar um modelo que funciona por causa de um campo cosmético.
  return {
    id,
    label: text(value['label'], 60) ?? id,
    hint: text(value['hint'], 120) ?? '',
  };
}

/**
 * Junta os dois catálogos. O do usuário vence: um id repetido tem os rótulos
 * substituídos, na posição original, e um id novo entra no fim da lista.
 */
export function merge(
  bundled: readonly ProviderModels[],
  user: readonly ProviderModels[],
): readonly ProviderModels[] {
  const byProvider = new Map<string, ModelChoice[]>();
  for (const entry of bundled) {
    byProvider.set(entry.providerId, [...entry.models]);
  }

  for (const entry of user) {
    const models = byProvider.get(entry.providerId) ?? [];
    for (const model of entry.models) {
      const index = models.findIndex((candidate) => candidate.id === model.id);
      if (index === -1) {
        models.push(model);
      } else {
        models[index] = model;
      }
    }
    byProvider.set(entry.providerId, models);
  }

  return [...byProvider.entries()].map(([providerId, models]) => ({ providerId, models }));
}
