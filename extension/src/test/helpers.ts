import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../constants';
import type { PrometheonApi } from '../extension';

/** Ativa a extensão uma única vez e devolve a API interna para os testes. */
export async function getApi(): Promise<PrometheonApi> {
  const extension = vscode.extensions.getExtension<PrometheonApi>(EXTENSION_ID);
  assert.ok(extension, `extensão ${EXTENSION_ID} não encontrada`);
  return extension.activate();
}

export function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'os testes precisam de uma pasta de workspace aberta');
  return folder;
}

export async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida um erro do Prometheon pelo `name` e pelo `code`, e não por `instanceof`.
 *
 * A extensão em execução vem do bundle (`dist/extension.js`) enquanto o teste
 * importa de `out/`: são duas cópias da mesma classe, então `instanceof` falha
 * mesmo quando o erro está correto. O `code` é justamente o contrato estável.
 */
export function isPrometheonError(name: string, code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error, `esperava um Error, recebi ${typeof error}`);
    assert.equal(error.name, name);
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

/** Procura padrões de credencial de verdade (`chave: valor`), não a palavra solta. */
export function assertNoCredentialLike(text: string): void {
  const suspicious = /(token|secret|password|passwd|api[-_]?key|authorization|cookie)\s*[:=]\s*\S+/i;
  const lines = text.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'));
  for (const line of lines) {
    assert.doesNotMatch(line, suspicious, `linha parece conter credencial: ${line}`);
  }
}
