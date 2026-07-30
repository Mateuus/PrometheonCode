import * as vscode from 'vscode';
import type { Logger } from '../logger';
import { evaluatePermission } from './PermissionPolicy';
import {
  EMPTY_PROJECT_POLICY,
  type PermissionContext,
  type PermissionRequest,
  type PermissionResult,
} from './types';

/**
 * Ponto único de decisão sobre o que os agentes podem fazer. Nenhum serviço
 * executa terminal, Git ou escrita de arquivo sem passar por aqui.
 */
export class PermissionService {
  private context: PermissionContext = {
    workMode: 'plan',
    autonomy: 'manual',
    bypass: null,
    projectPolicy: EMPTY_PROJECT_POLICY,
  };

  constructor(private readonly logger: Logger) {}

  get snapshot(): PermissionContext {
    return this.context;
  }

  update(patch: Partial<PermissionContext>): void {
    this.context = { ...this.context, ...patch };
  }

  evaluate(request: PermissionRequest): PermissionResult {
    return evaluatePermission(request, this.context);
  }

  /**
   * Resolve uma permissão, perguntando ao usuário quando necessário.
   * `prompt` é o texto do diálogo modal e deve descrever a ação concreta.
   */
  async requestApproval(request: PermissionRequest, prompt: string): Promise<boolean> {
    const result = this.evaluate(request);
    this.logger.debug(
      `Permissão "${request.action}": ${result.decision} (${result.source}) — ${result.reason}`,
    );

    if (result.decision === 'allow') {
      return true;
    }
    if (result.decision === 'deny') {
      void vscode.window.showWarningMessage(result.reason);
      return false;
    }

    const approve = 'Allow';
    const choice = await vscode.window.showWarningMessage(
      prompt,
      { modal: true, detail: result.reason },
      approve,
    );
    return choice === approve;
  }
}
