/**
 * Regras da própria conta: sessões, senha e perfil.
 *
 * Três ideias governam este arquivo:
 *
 * 1. **A conta só enxerga a si mesma.** Toda leitura e toda escrita levam o
 *    `userId` da credencial até o `WHERE`. Não existe caminho em que um
 *    identificador vindo do cliente selecione linha sozinho.
 * 2. **Revogar é imediato.** Derrubar uma sessão grava `revoked_at` na sessão e
 *    na família de refresh tokens **e** marca a denylist no Redis, que é o que
 *    alcança o access token JWT ainda dentro da validade. Sem os três, "revoguei"
 *    significaria "vai parar de valer em algum momento nos próximos 15 minutos".
 * 3. **Trocar a senha é um gesto de defesa.** Ver `changePassword()` para o que
 *    isso implica para as outras sessões.
 */

import { child } from '@prometheon/logger';
import type { Database } from '@prometheon/database';

import type { RedisClient } from '../../plugins/redis.js';
import { buildPage, decodeCursor, type CursorPage } from '../../shared/cursor.js';
import { toIso, toIsoOrNull } from '../../shared/time.js';
import { sessionRevoked } from '../auth/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { AuthRepository } from '../auth/repository.js';
import { toCurrentUser } from '../auth/service.js';
import { denySession } from '../auth/token-store.js';
import type { CurrentUserView, RequestOrigin } from '../auth/types.js';
import {
  currentPasswordInvalid,
  deviceNotFound,
  emptyProfileUpdate,
  passwordUnchanged,
  sessionNotFound,
  timeZoneUnknown,
} from './errors.js';
import { AccountRepository, type ProfilePatch, type SessionRow } from './repository.js';
import { describeClient, maskIp } from './session-view.js';

const logger = child('account');

/** Uma sessão como o contrato público a descreve. */
export interface SessionView {
  id: string;
  clientName: string | null;
  ipAddress: string | null;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** Um dispositivo como o contrato público o descreve. */
export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  client: string;
  clientVersion: string | null;
  ipAddress: string | null;
  lastSeenAt: string | null;
  connectedAt: string;
  credentialExpiresAt: string | null;
}

export interface AccountServiceDeps {
  readonly db: Database;
  readonly redis: RedisClient;
}

export class AccountService {
  private readonly repository: AccountRepository;
  private readonly auth: AuthRepository;
  private readonly redis: RedisClient;

  constructor(deps: AccountServiceDeps) {
    this.repository = new AccountRepository(deps.db);
    this.auth = new AuthRepository(deps.db);
    this.redis = deps.redis;
  }

  // -------------------------------------------------------------------------
  // Sessões
  // -------------------------------------------------------------------------

  /**
   * Sessões vivas da conta.
   *
   * `currentSessionId` vem da credencial que fez a chamada e é o que marca a
   * linha com `current: true`. Uma credencial de dispositivo não tem sessão, e
   * nesse caso nenhuma linha é a atual — o que também é verdade: a extensão não
   * está em nenhuma das sessões listadas.
   */
  async listSessions(input: {
    userId: string;
    currentSessionId: string | null;
    cursor: string | undefined;
    limit: number;
  }): Promise<CursorPage<SessionView>> {
    const rows = await this.repository.listSessions({
      userId: input.userId,
      limit: input.limit,
      after: input.cursor === undefined ? undefined : decodeCursor(input.cursor),
    });

    const page = buildPage(rows, input.limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    return {
      items: page.items.map((row) => toSessionView(row, input.currentSessionId)),
      pageInfo: page.pageInfo,
    };
  }

  /**
   * Derruba uma sessão da própria conta.
   *
   * Revogar a sessão que está fazendo a chamada é permitido — é o mesmo que sair
   * daqui, e recusar seria uma regra que só atrapalha. O que a resposta devolve
   * é se foi isso que aconteceu, para o cliente saber que precisa limpar as
   * próprias credenciais em vez de só recarregar a lista.
   */
  async revokeSession(input: {
    userId: string;
    sessionId: string;
    currentSessionId: string | null;
    origin: RequestOrigin;
  }): Promise<{ current: boolean }> {
    const session = await this.repository.findSessionOfUser(input.sessionId, input.userId);

    if (session === undefined) {
      throw sessionNotFound();
    }

    await this.auth.revokeTokenFamily(session.id, 'session_revoked_by_user');
    await denySession(this.redis, session.id);
    await this.auth.recordSecurityEvent({
      type: 'session_revoked_by_user',
      severity: 'medium',
      userId: input.userId,
      ip: input.origin.ip,
      userAgent: input.origin.userAgent,
      details: { sessionId: session.id },
    });

    logger.info({ userId: input.userId, sessionId: session.id }, 'session revoked by owner');

    return { current: session.id === input.currentSessionId };
  }

  // -------------------------------------------------------------------------
  // Senha
  // -------------------------------------------------------------------------

  /**
   * Troca a senha de quem já está autenticado.
   *
   * **A senha atual é exigida.** A pessoa já provou ter uma sessão, mas sessão é
   * o que um invasor tem quando rouba um token — se isso bastasse para trocar a
   * senha, um token roubado viraria a conta inteira, com o dono trancado do lado
   * de fora. Saber a senha antiga é o que a sessão roubada não tem.
   *
   * **AS OUTRAS SESSÕES CAEM. A de quem trocou fica.**
   *
   * Trocar a senha estando logado é, quase sempre, o que a pessoa faz quando
   * desconfia de que alguém entrou na conta. Se as outras sessões sobrevivessem,
   * o invasor continuaria dentro com o refresh token que já tem, e a troca não
   * teria resolvido nada além de dar uma falsa sensação de segurança — o pior
   * resultado possível. Por isso a revogação é do mesmo tipo que a do
   * `password-reset/confirm`: sessão e família de refresh tokens no banco, mais a
   * denylist no Redis para alcançar os access tokens que ainda não expiraram.
   *
   * Preservar a sessão atual não é uma concessão de conveniência, é o que faz a
   * defesa ser usada: uma troca de senha que desloga a pessoa do próprio
   * navegador ensina a não trocar a senha. E a sessão preservada acabou de
   * provar conhecimento da senha antiga, que é justamente o que o invasor não
   * tem. Quando a chamada vem de uma credencial de dispositivo (sem sessão),
   * não há o que preservar e todas as sessões caem.
   *
   * **Os dispositivos também caem**, com as credenciais deles. A extensão no VS
   * Code é uma porta como qualquer outra; deixá-la aberta faria a troca de senha
   * prometer mais do que entrega — a pessoa sai da tela achando que expulsou
   * todo mundo enquanto o acesso pelo editor continua de pé. Vale para os dois
   * caminhos, a troca autenticada e o reset por e-mail, para que "troquei minha
   * senha" tenha um significado só.
   */
  async changePassword(input: {
    userId: string;
    currentSessionId: string | null;
    currentPassword: string;
    newPassword: string;
    origin: RequestOrigin;
  }): Promise<{ revokedSessions: number; revokedDevices: number }> {
    const user = await this.auth.findUserById(input.userId);

    if (user === undefined) {
      throw sessionRevoked();
    }

    const digest = user.passwordHash;

    // Conta sem senha (só provedor externo) não tem senha atual para conferir.
    // Deixar passar aqui seria permitir definir uma senha sem provar nada.
    if (digest === null || !(await verifyPassword(digest, input.currentPassword))) {
      await this.auth.recordSecurityEvent({
        type: 'password_change_failed',
        severity: 'medium',
        userId: input.userId,
        ip: input.origin.ip,
        userAgent: input.origin.userAgent,
        details: { reason: digest === null ? 'no_password_set' : 'wrong_current_password' },
      });

      throw currentPasswordInvalid();
    }

    // Repetir a senha atual não é troca. Recusar evita que alguém saia da tela
    // achando que fez alguma coisa — e evita derrubar as outras sessões à toa.
    if (await verifyPassword(digest, input.newPassword)) {
      throw passwordUnchanged();
    }

    await this.auth.updatePassword(input.userId, await hashPassword(input.newPassword));

    const revoked = await this.repository.revokeSessionsExcept({
      userId: input.userId,
      keepSessionId: input.currentSessionId,
      reason: 'password_changed',
    });

    await Promise.all(revoked.map((id) => denySession(this.redis, id)));

    // Os dispositivos caem depois das sessões, e não em paralelo: se esta
    // escrita falhar, o erro sobe com as sessões já derrubadas — o lado seguro
    // de uma falha parcial. Na ordem inversa, a falha deixaria as sessões vivas.
    const revokedDevices = await this.auth.revokeDevices({
      userId: input.userId,
      reason: 'password_changed',
    });

    await this.auth.recordSecurityEvent({
      type: 'password_changed',
      severity: 'medium',
      userId: input.userId,
      ip: input.origin.ip,
      userAgent: input.origin.userAgent,
      details: {
        revokedSessions: revoked.length,
        revokedDevices: revokedDevices.length,
        keptSession: input.currentSessionId,
      },
    });

    logger.info(
      {
        userId: input.userId,
        revokedSessions: revoked.length,
        revokedDevices: revokedDevices.length,
      },
      'password changed; other sessions and all devices revoked',
    );

    return { revokedSessions: revoked.length, revokedDevices: revokedDevices.length };
  }

  // -------------------------------------------------------------------------
  // Dispositivos
  // -------------------------------------------------------------------------

  /**
   * Dispositivos que ainda conseguem agir em nome da pessoa.
   *
   * Anda junto das sessões na mesma tela porque respondem à mesma pergunta —
   * "onde eu estou logado?". Separá-las faria alguém fechar as sessões, achar
   * que terminou, e deixar o editor conectado.
   */
  async listDevices(userId: string): Promise<DeviceView[]> {
    const rows = await this.repository.listDevices(userId);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      client: row.client,
      clientVersion: row.clientVersion,
      // Mesma regra das sessões: a rede basta para reconhecer, o endereço exato
      // vira histórico de localização para quem estiver lendo a tela.
      ipAddress: maskIp(row.lastIp),
      lastSeenAt: toIsoOrNull(row.lastSeenAt),
      connectedAt: toIso(row.createdAt),
      credentialExpiresAt: toIsoOrNull(row.credentialExpiresAt),
    }));
  }

  /**
   * Desconecta um dispositivo.
   *
   * Tem efeito imediato: a credencial da extensão é conferida no banco a cada
   * requisição, então não existe janela em que um token já emitido continue
   * valendo — ao contrário das sessões de navegador, que precisam da denylist.
   *
   * Dispositivo de outra pessoa responde igual a dispositivo inexistente. Um
   * 404 e um 403 diferentes contariam a quem tem uma conta qualquer se um
   * identificador existe.
   */
  async revokeDevice(input: {
    userId: string;
    deviceId: string;
    origin: RequestOrigin;
  }): Promise<void> {
    const revoked = await this.auth.revokeDevices({
      userId: input.userId,
      deviceId: input.deviceId,
      reason: 'device_revoked_by_user',
    });

    if (revoked.length === 0) {
      throw deviceNotFound();
    }

    await this.auth.recordSecurityEvent({
      type: 'device_revoked_by_user',
      severity: 'medium',
      userId: input.userId,
      ip: input.origin.ip,
      userAgent: input.origin.userAgent,
      details: { deviceId: input.deviceId },
    });

    logger.info({ userId: input.userId, deviceId: input.deviceId }, 'device revoked by owner');
  }

  // -------------------------------------------------------------------------
  // Perfil
  // -------------------------------------------------------------------------

  /**
   * Edita o próprio perfil.
   *
   * O corpo é um `PATCH`: o que não vier fica como está. `avatarUrl: null` é o
   * pedido explícito de remover a imagem, e por isso é distinguido de ausente.
   *
   * E-mail não é editável por aqui — ver `updateProfileRequestSchema` no
   * contrato para o porquê.
   */
  async updateProfile(
    userId: string,
    input: {
      name?: string | undefined;
      locale?: string | undefined;
      timeZone?: string | undefined;
      avatarUrl?: string | null | undefined;
    },
  ): Promise<{ user: CurrentUserView }> {
    const patch: ProfilePatch = {};

    if (input.name !== undefined) {
      patch.displayName = input.name;
    }

    if (input.locale !== undefined) {
      patch.locale = input.locale;
    }

    if (input.timeZone !== undefined) {
      if (!isKnownTimeZone(input.timeZone)) {
        throw timeZoneUnknown(input.timeZone);
      }

      patch.timezone = input.timeZone;
    }

    if (input.avatarUrl !== undefined) {
      patch.avatarUrl = input.avatarUrl;
    }

    if (Object.keys(patch).length === 0) {
      throw emptyProfileUpdate();
    }

    await this.repository.updateProfile(userId, patch);

    const updated = await this.auth.findUserById(userId);

    if (updated === undefined) {
      throw sessionRevoked();
    }

    return { user: toCurrentUser(updated) };
  }
}

/**
 * Converte a linha do banco no que o contrato publica.
 *
 * É aqui que o user agent cru e o endereço exato param de existir para o
 * cliente. Ver `session-view.ts`.
 */
function toSessionView(row: SessionRow, currentSessionId: string | null): SessionView {
  return {
    id: row.id,
    clientName: describeClient(row.userAgent, row.deviceName),
    ipAddress: maskIp(row.ip),
    current: row.id === currentSessionId,
    createdAt: toIso(row.createdAt),
    // Sessão que nunca foi tocada depois de criada tem o próprio nascimento como
    // último uso; `null` na tela não diria nada a ninguém.
    lastUsedAt: toIso(row.lastSeenAt ?? row.createdAt),
    expiresAt: toIso(row.expiresAt),
  };
}

/**
 * Confere o fuso contra a base de dados de fusos do runtime.
 *
 * `Intl` é a única lista que acompanha as revisões da IANA sem ninguém precisar
 * atualizar nada aqui.
 */
function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });

    return true;
  } catch {
    return false;
  }
}
