/**
 * O que o Prometheon precisa para funcionar nesta máquina.
 *
 * Cada verificação responde a uma pergunta prática e, quando falha, diz o que
 * fazer. Um diagnóstico que só informa "não encontrado" deixa a pessoa no mesmo
 * lugar em que ela já estava.
 *
 * As checagens são separadas da interface de propósito: o mesmo resultado
 * alimenta a tela bonita e a saída JSON de automação.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeVersion } from '@prometheon/agent-runtime';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail?: string;
  readonly fix?: string;
}

/** Onde a configuração e os perfis vivem — o mesmo lugar da extensão. */
export function prometheonHome(): string {
  return join(homedir(), '.prometheon');
}

export async function runDoctor(): Promise<readonly CheckResult[]> {
  return [checkNode(), await checkClaudeCode(), await checkProfiles(), checkTerminal()];
}

/**
 * Versão do Node.
 *
 * O CLI usa `AbortSignal` em `spawn` e recursos de ESM que estabilizaram no 20.
 * Uma versão anterior falha em runtime, com erro que não parece ser de versão.
 */
function checkNode(): CheckResult {
  const major = Number(process.versions.node.split('.', 1)[0]);

  if (Number.isNaN(major) || major < 20) {
    return {
      id: 'node',
      label: 'Node.js 20 ou mais novo',
      status: 'fail',
      detail: `encontrado ${process.versions.node}`,
      fix: 'Instale o Node 20+ em https://nodejs.org',
    };
  }

  return { id: 'node', label: 'Node.js', status: 'ok', detail: `v${process.versions.node}` };
}

/**
 * O CLI do provedor.
 *
 * É `warn` e não `fail`: o Prometheon conversa com o Hub e administra a equipe
 * sem nenhum provedor instalado. O que não dá é executar agente — e a mensagem
 * diz isso, em vez de sugerir que nada funciona.
 */
async function checkClaudeCode(): Promise<CheckResult> {
  const version = await claudeVersion({});

  if (version === null) {
    return {
      id: 'claude-code',
      label: 'Claude Code CLI',
      status: 'warn',
      detail: 'não encontrado — sem ele, o Prometheon não executa agentes',
      fix: 'npm install -g @anthropic-ai/claude-code',
    };
  }

  return { id: 'claude-code', label: 'Claude Code CLI', status: 'ok', detail: `v${version}` };
}

/**
 * Contas configuradas.
 *
 * Lê o mesmo arquivo que a extensão escreve: quem já configurou pelo VS Code
 * não precisa configurar de novo aqui.
 */
async function checkProfiles(): Promise<CheckResult> {
  const path = join(prometheonHome(), 'local-profiles.json');

  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const profiles = Array.isArray(parsed) ? parsed : [];

    if (profiles.length === 0) {
      return {
        id: 'profiles',
        label: 'Contas de provedor',
        status: 'warn',
        detail: 'nenhuma configurada',
        fix: 'prometheon login',
      };
    }

    return {
      id: 'profiles',
      label: 'Contas de provedor',
      status: 'ok',
      detail: `${profiles.length} configurada${profiles.length === 1 ? '' : 's'}`,
    };
  } catch {
    // Arquivo ausente é o estado de quem nunca usou, não um erro.
    return {
      id: 'profiles',
      label: 'Contas de provedor',
      status: 'warn',
      detail: 'nenhuma configurada',
      fix: 'prometheon login',
    };
  }
}

/**
 * Capacidade do terminal.
 *
 * Nunca falha: é informação, não requisito. O CLI funciona num terminal sem
 * cor — só fica menos bonito, e é bom que a pessoa saiba por quê antes de achar
 * que algo quebrou.
 */
function checkTerminal(): CheckResult {
  const interactive = process.stdout.isTTY;
  const colorless = process.env['NO_COLOR'] !== undefined;

  if (!interactive) {
    return {
      id: 'terminal',
      label: 'Terminal',
      status: 'ok',
      detail: 'saída canalizada — a interface interativa fica desligada',
    };
  }

  return {
    id: 'terminal',
    label: 'Terminal',
    status: 'ok',
    detail: colorless ? 'NO_COLOR ativo — sem cores, por sua escolha' : `${process.stdout.columns} colunas`,
  };
}

/** Um problema que impede o uso, ou nada. */
export function blockingFailure(results: readonly CheckResult[]): CheckResult | undefined {
  return results.find((result) => result.status === 'fail');
}
