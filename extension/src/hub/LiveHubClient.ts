import * as vscode from 'vscode';
import { normalizeCustomRole } from '../agents/AgentRoleStore';
import type { CustomAgentRole, HubConnectionStatus } from '../core/types';
import { t } from '../i18n';
import type { Logger } from '../logger';
import type { SecretStore } from '../storage/SecretStore';
import { HubNotConfiguredError, serializeError } from '../utils/errors';
import { sanitize } from '../utils/sanitize';
import { parseHubUrl } from './HubClient';
import {
  pollDeviceToken,
  requestDeviceAuthorization,
  type DeviceCredential,
  type HubHttp,
} from './deviceFlow';
import { openRealtime } from './realtime';
import type {
  HubClient,
  HubConnectionConfig,
  HubConnectOptions,
  HubConversation,
  HubMessage,
  HubProject,
  HubRealtimeEvent,
  HubSubscription,
} from './types';

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

  hasStoredCredential(): Promise<boolean> {
    return this.secrets.has('hub.token');
  }

  /**
   * Conecta ao Hub. Reaproveita a credencial guardada quando ela ainda vale; se
   * não houver, conduz o device flow com o usuário. Em modo não interativo —
   * a reconexão automática da ativação — o device flow nunca acontece: sem
   * credencial aproveitável a chamada devolve o motivo no status e para aí.
   */
  async connect(config: HubConnectionConfig, options?: HubConnectOptions): Promise<void> {
    const interactive = options?.interactive ?? true;
    const url = parseHubUrl(config.url);
    this.baseUrl = url;

    try {
      const stored = await this.loadCredential();

      // A reconexão silenciosa não toca a rede sem credencial que preste: quem
      // nunca entrou continua em `local-only`, sem badge piscando na ativação.
      if (!interactive && (stored === null || this.isExpired(stored))) {
        if (stored === null) {
          this.baseUrl = null;
        } else {
          this.setStatus({ state: 'disconnected', detail: sessionExpiredMessage() });
        }
        return;
      }

      this.setStatus({ state: 'connecting' });

      const reachable = await this.checkHealth();
      if (!reachable) {
        this.setStatus({ state: 'error', detail: t('The Hub did not answer the health check.') });
        return;
      }

      if (stored !== null && !this.isExpired(stored)) {
        this.credential = stored;
        const identity = await this.verifyCredential();
        if (identity.ok) {
          this.setStatus(connectedStatus(identity.displayName ?? displayNameFrom(stored)));
          return;
        }
        // Credencial recusada: some com ela antes de pedir outra.
        await this.forgetCredential();
        if (!interactive) {
          this.setStatus({ state: 'disconnected', detail: sessionExpiredMessage() });
          return;
        }
      }

      const credential = await this.authorizeDevice();
      if (credential === null) {
        this.setStatus({
          state: 'disconnected',
          detail: t('Device authorization was not completed.'),
        });
        return;
      }
      this.credential = credential;
      await this.secrets.store('hub.token', JSON.stringify(credential));
      this.setStatus(connectedStatus(displayNameFrom(credential)));
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

  /**
   * Sai do Hub nesta máquina.
   *
   * Além de esquecer a credencial, volta ao estado `local-only` — sem isso o
   * painel continuaria dizendo "Connected" com uma conexão que já não tem
   * credencial nenhuma por trás.
   */
  async signOut(): Promise<void> {
    await this.forgetCredential();
    this.setStatus({ state: 'local-only' });
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
      // Organização e identidade voltam junto: sem elas, cada reabertura do
      // editor pagaria uma chamada a mais para redescobrir o que já sabia.
      const organizationId = value['organizationId'];
      const userName = value['userName'];
      const userEmail = value['userEmail'];
      return {
        token,
        deviceId,
        expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
        ...(typeof organizationId === 'string' && organizationId !== ''
          ? { organizationId }
          : {}),
        ...(typeof userName === 'string' && userName !== '' ? { userName } : {}),
        ...(typeof userEmail === 'string' && userEmail !== '' ? { userEmail } : {}),
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

  async listProjects(): Promise<readonly HubProject[]> {
    const organizationId = await this.organizationId();
    const page = await this.read(`/v1/organizations/${organizationId}/projects?limit=100`);

    return page.map(readProject).filter((project): project is HubProject => project !== null);
  }

  async listConversations(projectId: string): Promise<readonly HubConversation[]> {
    const page = await this.read(`/v1/projects/${projectId}/conversations?limit=100`);

    return page
      .map(readConversation)
      .filter((conversation): conversation is HubConversation => conversation !== null);
  }

  async getMessages(conversationId: string): Promise<readonly HubMessage[]> {
    // `direction=asc` porque a conversa é lida de cima para baixo; o padrão da
    // API é `desc`, que serve à lista de sessões, não ao corpo de uma delas.
    const page = await this.read(
      `/v1/conversations/${conversationId}/messages?limit=200&direction=asc`,
    );

    return page.map(readMessage).filter((message): message is HubMessage => message !== null);
  }

  async createConversation(projectId: string, title: string): Promise<HubConversation> {
    const created = await this.write(`/v1/projects/${projectId}/conversations`, {
      title,
      origin: 'local_import',
    });
    const conversation = readConversation(created);

    if (conversation === null) {
      throw new Error('The Hub did not return the conversation it created.');
    }
    return conversation;
  }

  async postMessage(conversationId: string, content: string): Promise<HubMessage> {
    const created = await this.write(`/v1/conversations/${conversationId}/messages`, {
      authorType: 'user',
      parts: [{ type: 'text', content }],
    });
    const message = readMessage(created);

    if (message === null) {
      throw new Error('The Hub did not return the message it stored.');
    }
    return message;
  }

  async listAgentRoles(): Promise<readonly CustomAgentRole[]> {
    const organizationId = await this.organizationId();
    const page = await this.read(`/v1/organizations/${organizationId}/agent-roles?limit=100`);

    return readRoles(page);
  }

  /**
   * Substitui a lista inteira da organização.
   *
   * O Hub responde com o que passou a valer, e é esse retorno que fica em
   * memória: se outra pessoa gravou no meio do caminho, a lista local passa a
   * refletir o servidor em vez de insistir no que este cliente enviou.
   */
  async saveAgentRoles(roles: readonly CustomAgentRole[]): Promise<readonly CustomAgentRole[]> {
    const organizationId = await this.organizationId();
    const saved = await this.write(`/v1/organizations/${organizationId}/agent-roles`, {
      roles: roles.map((role) => ({
        id: role.id,
        label: role.label,
        description: role.description,
        basedOn: role.basedOn,
        skills: [...role.skills],
        ...(role.systemPrompt === undefined ? {} : { systemPrompt: role.systemPrompt }),
      })),
    });
    const items = isRecord(saved) ? saved['items'] : undefined;

    return readRoles(Array.isArray(items) ? items : []);
  }

  /**
   * Abre o canal de tempo real.
   *
   * O token é de uso único e vale uma conexão só, então ele é pedido aqui e não
   * guardado. A URL vem do próprio Hub — montar `ws://` ou `wss://` no cliente
   * daria um jeito a mais de errar num detalhe que o servidor já sabe.
   */
  async subscribe(onEvent: (event: HubRealtimeEvent) => void): Promise<HubSubscription> {
    const response = await this.request('GET', '/v1/realtime/token');

    if (response.status >= 400) {
      throw new HubNotConfiguredError('The Hub refused a realtime token for this device.');
    }

    const data = isRecord(response.body) ? response.body['data'] : undefined;
    const token = isRecord(data) ? data['token'] : undefined;
    const url = isRecord(data) ? data['url'] : undefined;

    if (typeof token !== 'string' || typeof url !== 'string') {
      throw new Error('Unexpected realtime token response.');
    }

    return openRealtime(`${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`, {
      onEvent,
      onError: (message) => {
        this.logger.info(`Canal de tempo real: ${sanitize(message)}`);
      },
    });
  }

  /** POST que devolve o `data` do envelope, com os erros já traduzidos. */
  private async write(path: string, body: unknown): Promise<unknown> {
    const response = await this.request('POST', path, body);

    if (response.status === 401 || response.status === 403) {
      throw new HubNotConfiguredError(t('This device is not authorized in the Hub.'));
    }
    if (response.status >= 400) {
      throw new Error(`Hub responded ${String(response.status)} for ${path}.`);
    }
    return isRecord(response.body) ? response.body['data'] : undefined;
  }

  /**
   * Organização desta credencial.
   *
   * O device flow costuma devolvê-la; quando não devolve, a primeira da lista
   * é a escolha certa — a credencial só enxerga as organizações a que tem
   * acesso, e uma extensão sem organização escolhida não teria o que listar.
   */
  private async organizationId(): Promise<string> {
    const known = this.credential?.organizationId;

    if (known !== undefined && known !== '') {
      return known;
    }

    const first = this.read('/v1/organizations?limit=1');
    const organization = (await first)[0];
    const id = isRecord(organization) ? organization['id'] : undefined;

    if (typeof id !== 'string' || id === '') {
      throw new HubNotConfiguredError('This account has no organization in the Hub yet.');
    }
    return id;
  }

  /**
   * GET de uma página, já desembrulhada.
   *
   * O Hub responde sempre `{ data, meta }` e as listas vêm em
   * `data.items` (`Docs/06`). Um corpo fora desse formato é tratado como
   * falha e não como lista vazia: silenciar aqui esconderia uma quebra de
   * contrato atrás de um histórico que parece só estar vazio.
   */
  private async read(path: string): Promise<readonly unknown[]> {
    const response = await this.request('GET', path);

    if (response.status === 401 || response.status === 403) {
      throw new HubNotConfiguredError(t('This device is not authorized in the Hub.'));
    }
    if (response.status >= 400) {
      throw new Error(`Hub responded ${String(response.status)} for ${path}.`);
    }

    const data = isRecord(response.body) ? response.body['data'] : undefined;
    const items = isRecord(data) ? data['items'] : undefined;

    if (!Array.isArray(items)) {
      throw new Error(`Unexpected response shape from ${path}.`);
    }
    return items;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (this.baseUrl === null) {
      // Mesmo contrato do cliente sem Hub de antigamente: quem chama o Web Chat
      // sem conexão recebe `hub.not-configured`, não um erro genérico de URL.
      throw new HubNotConfiguredError();
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

  /**
   * Confere a credencial em `/v1/me` e aproveita a viagem para trazer quem é o
   * usuário — é o nome que o painel mostra ao lado de "Connected".
   */
  private async verifyCredential(): Promise<{ ok: boolean; displayName?: string }> {
    try {
      const response = await this.request('GET', '/v1/me');
      if (response.status !== 200) {
        return { ok: false };
      }
      const data = isRecord(response.body) ? response.body['data'] : undefined;
      const user = isRecord(data) ? data['user'] : undefined;
      const name = isRecord(user) ? (text(user['name']) ?? text(user['email'])) : null;
      return { ok: true, ...(name === null ? {} : { displayName: name }) };
    } catch {
      return { ok: false };
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

    // Direto ao navegador, sem diálogo no caminho — como GitHub e Claude. A
    // conferência anti-phishing não se perde: a notificação de progresso repete
    // o código aqui, e a página o mostra em destaque para a comparação.
    await vscode.env.openExternal(
      vscode.Uri.parse(authorization.verificationUriComplete ?? authorization.verificationUri),
    );

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Waiting for Hub authorization (code {0})', authorization.userCode),
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
              void vscode.window.showWarningMessage(t('Prometheon Hub: {0}', outcome.reason));
              return null;
            case 'expired':
              void vscode.window.showWarningMessage(
                t('The authorization code expired. Start the connection again.'),
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

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Conectado, dizendo como quem — quando o Hub contou. */
function connectedStatus(displayName: string | undefined): HubConnectionStatus {
  return displayName === undefined
    ? { state: 'connected' }
    : { state: 'connected', detail: t('Signed in as {0}', displayName) };
}

function displayNameFrom(credential: DeviceCredential): string | undefined {
  return credential.userName ?? credential.userEmail;
}

/**
 * Função e não constante para a frase sair no idioma vigente na hora do aviso,
 * não no da carga do módulo.
 */
function sessionExpiredMessage(): string {
  return t('Your Hub session expired. Sign in to connect this device again.');
}

// ---------------------------------------------------------------------------
// Leitura das respostas
// ---------------------------------------------------------------------------

/**
 * A resposta do Hub chega como `unknown` e é validada aqui.
 *
 * É a mesma regra da fronteira com a webview: o que não casa com o contrato é
 * descartado inteiro, e não completado com valores inventados. Uma conversa sem
 * `id` não vira uma conversa com id vazio — ela some da lista, e o resto
 * continua utilizável.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Data ISO do Hub em milissegundos. Data ilegível vira `null`. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function readProject(value: unknown): HubProject | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = text(value['id']);
  const name = text(value['name']);

  return id === null || name === null ? null : { id, name, slug: text(value['slug']) ?? '' };
}

export function readConversation(value: unknown): HubConversation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = text(value['id']);

  if (id === null) {
    return null;
  }
  const createdAt = instant(value['createdAt']) ?? Date.now();
  const count = value['messageCount'];

  return {
    id,
    // Conversa sem título é normal enquanto ninguém escreveu nela.
    title: text(value['title']) ?? 'Untitled',
    messageCount: typeof count === 'number' && Number.isFinite(count) ? count : 0,
    createdAt,
    // `lastMessageAt` é nulo antes da primeira mensagem; aí a criação ordena.
    updatedAt: instant(value['lastMessageAt']) ?? instant(value['updatedAt']) ?? createdAt,
  };
}

/**
 * Papéis vindos do Hub. A validação é a mesma dos que vêm de disco: o escopo
 * `hub` só diz de onde chegaram, não que sejam confiáveis por isso.
 */
export function readRoles(items: readonly unknown[]): readonly CustomAgentRole[] {
  return items
    .map((item) => normalizeCustomRole(item, 'hub'))
    .filter((role): role is CustomAgentRole => role !== null);
}

const MESSAGE_AUTHORS = ['user', 'agent', 'system'] as const;
const MESSAGE_STATUSES = [
  'pending',
  'streaming',
  'complete',
  'failed',
  'cancelled',
  'redacted',
] as const;

export function readMessage(value: unknown): HubMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = text(value['id']);
  const authorType = MESSAGE_AUTHORS.find((candidate) => candidate === value['authorType']);

  if (id === null || authorType === undefined) {
    return null;
  }

  const status =
    MESSAGE_STATUSES.find((candidate) => candidate === value['status']) ?? 'complete';
  const author = value['authorUser'];

  return {
    id,
    authorType,
    authorName: isRecord(author) ? text(author['name']) : null,
    content: joinParts(value['parts']),
    status,
    createdAt: instant(value['createdAt']) ?? Date.now(),
  };
}

/**
 * Junta as partes textuais numa mensagem só.
 *
 * Só `text` entra. `reasoning_summary` é raciocínio, `tool_call` e `tool_result`
 * pertencem à timeline de passos — despejar tudo no corpo transformaria a
 * resposta num log. As partes que a fase 1 não exibe continuam no Hub,
 * esperando a timeline que a fase 2 traz.
 */
function joinParts(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .filter(isRecord)
    .filter((part) => part['type'] === 'text')
    .map((part) => text(part['content']) ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
}
