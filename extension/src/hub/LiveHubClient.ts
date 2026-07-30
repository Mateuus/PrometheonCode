import * as vscode from 'vscode';
import type { HubConnectionStatus } from '../core/types';
import type { Logger } from '../logger';
import type { SecretStore } from '../storage/SecretStore';
import { serializeError } from '../utils/errors';
import { sanitize } from '../utils/sanitize';
import { parseHubUrl } from './HubClient';
import {
  pollDeviceToken,
  requestDeviceAuthorization,
  type DeviceCredential,
  type HubHttp,
} from './deviceFlow';
import type { HubClient, HubConnectionConfig } from './types';

/** Tempo máximo de cada chamada; um Hub lento não pode travar a extensão. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Cliente real do Prometheon Hub.
 *
 * Fala apenas com a API HTTPS do Hub — nunca com banco. A credencial do
 * dispositivo vive no `vscode.SecretStorage`, nunca em `.prometheon/`, em
 * configuração ou em log. O que sai daqui para o Hub é o que a extensão decidir
 * enviar; a autenticação em si acontece no navegador, na sessão do usuário.
 */
export class LiveHubClient implements HubClient {
  private status: HubConnectionStatus = { state: 'local-only' };
  private baseUrl: URL | null = null;
  private credential: DeviceCredential | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly logger: Logger,
    private readonly extensionVersion: string,
  ) {}

  getStatus(): HubConnectionStatus {
    return this.status;
  }

  isAuthenticated(): boolean {
    return this.credential !== null && !this.isExpired(this.credential);
  }

  /**
   * Conecta ao Hub. Reaproveita a credencial guardada quando ela ainda vale; se
   * não houver, conduz o device flow com o usuário.
   */
  async connect(config: HubConnectionConfig): Promise<void> {
    const url = parseHubUrl(config.url);
    this.baseUrl = url;
    this.setStatus({ state: 'connecting' });

    try {
      const reachable = await this.checkHealth();
      if (!reachable) {
        this.setStatus({ state: 'error', detail: 'The Hub did not answer the health check.' });
        return;
      }

      const stored = await this.loadCredential();
      if (stored !== null && !this.isExpired(stored)) {
        this.credential = stored;
        if (await this.verifyCredential()) {
          this.setStatus({ state: 'connected' });
          return;
        }
        // Credencial recusada: some com ela antes de pedir outra.
        await this.forgetCredential();
      }

      const credential = await this.authorizeDevice();
      if (credential === null) {
        this.setStatus({ state: 'disconnected', detail: 'Device authorization was not completed.' });
        return;
      }
      this.credential = credential;
      await this.secrets.store('hub.token', JSON.stringify(credential));
      this.setStatus({ state: 'connected' });
    } catch (error) {
      const serialized = serializeError(error);
      this.logger.error(`Falha ao conectar ao Hub: ${sanitize(serialized.message)}`);
      this.setStatus({ state: 'error', detail: serialized.message });
    }
  }

  async disconnect(): Promise<void> {
    this.credential = null;
    this.baseUrl = null;
    this.setStatus({ state: 'local-only' });
  }

  /** Esquece a credencial guardada. Usado no logout e quando o Hub a recusa. */
  async forgetCredential(): Promise<void> {
    this.credential = null;
    await this.secrets.delete('hub.token');
  }

  // ---------- Internos ----------

  private setStatus(status: HubConnectionStatus): void {
    this.status = status;
  }

  private isExpired(credential: DeviceCredential): boolean {
    // Uma folga de um minuto evita usar credencial que expira no meio da chamada.
    return credential.expiresAt !== null && credential.expiresAt - 60_000 <= Date.now();
  }

  private async loadCredential(): Promise<DeviceCredential | null> {
    const raw = await this.secrets.get('hub.token');
    if (raw === undefined) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const value = parsed as Record<string, unknown>;
      const token = value['token'];
      const deviceId = value['deviceId'];
      const expiresAt = value['expiresAt'];
      if (typeof token !== 'string' || typeof deviceId !== 'string') {
        return null;
      }
      return {
        token,
        deviceId,
        expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
      };
    } catch {
      // Segredo corrompido não deve derrubar a extensão: só não serve.
      return null;
    }
  }

  private get http(): HubHttp {
    return {
      post: async (path, body) => {
        const response = await this.request('POST', path, body);
        return { status: response.status, body: response.body };
      },
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (this.baseUrl === null) {
      throw new Error('Hub URL is not configured.');
    }
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.credential === null
            ? {}
            : { authorization: `Bearer ${this.credential.token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const response = await this.request('GET', '/health/ready');
      return response.status < 500;
    } catch (error) {
      this.logger.info(`Hub inacessível: ${sanitize(serializeError(error).message)}`);
      return false;
    }
  }

  private async verifyCredential(): Promise<boolean> {
    try {
      const response = await this.request('GET', '/v1/me');
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Conduz o device flow com barra de progresso e cancelamento. O polling
   * respeita o intervalo pedido pelo Hub, inclusive quando ele manda desacelerar.
   */
  private async authorizeDevice(): Promise<DeviceCredential | null> {
    const authorization = await requestDeviceAuthorization(this.http, {
      deviceName: `VS Code — ${vscode.env.machineId.slice(0, 8)}`,
      deviceKind: 'vscode',
      clientVersion: this.extensionVersion,
      platform: process.platform,
    });

    const open = 'Open browser';
    const copy = 'Copy code';
    const choice = await vscode.window.showInformationMessage(
      `Authorize this device in the Prometheon Hub. Your code is ${authorization.userCode}.`,
      { modal: true, detail: `You will confirm the code at ${authorization.verificationUri}.` },
      open,
      copy,
    );
    if (choice === undefined) {
      return null;
    }
    if (choice === copy) {
      await vscode.env.clipboard.writeText(authorization.userCode);
    }
    await vscode.env.openExternal(
      vscode.Uri.parse(authorization.verificationUriComplete ?? authorization.verificationUri),
    );

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Waiting for authorization (code ${authorization.userCode})`,
        cancellable: true,
      },
      async (_progress, token) => {
        const deadline = Date.now() + authorization.expiresInSeconds * 1000;
        let interval = authorization.intervalSeconds;

        while (Date.now() < deadline) {
          if (token.isCancellationRequested) {
            return null;
          }
          await this.wait(interval * 1000, token);
          if (token.isCancellationRequested) {
            return null;
          }

          const outcome = await pollDeviceToken(this.http, authorization.deviceCode);
          switch (outcome.kind) {
            case 'authorized':
              return outcome.credential;
            case 'slow-down':
              interval = outcome.intervalSeconds;
              break;
            case 'denied':
              void vscode.window.showWarningMessage(`Prometheon Hub: ${outcome.reason}`);
              return null;
            case 'expired':
              void vscode.window.showWarningMessage(
                'The authorization code expired. Start the connection again.',
              );
              return null;
            case 'pending':
              break;
          }
        }
        return null;
      },
    );
  }

  /** Espera respeitando o cancelamento, para o usuário não ficar preso. */
  private wait(ms: number, token: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const subscription = token.onCancellationRequested(() => {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      });
    });
  }
}
