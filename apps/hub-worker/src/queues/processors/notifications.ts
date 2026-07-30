// Fila `notifications` — entrega de uma notificação.
//
// ESTADO: estrutura completa, efeito pendente da API.
//
// O que já vale aqui: validação do payload, resolução do destinatário quando
// ele é um usuário do Hub, idempotência por destinatário + template + assunto,
// correlação e métricas. Um destinatário que não existe, ou uma conta sem
// e-mail verificado quando o canal é e-mail, é falha **permanente**: repetir a
// entrega não faz o endereço aparecer.
//
// PENDENTE DA API/infra — falta ligar:
//
// 1. o catálogo de templates (assunto e corpo por idioma; a interface é
//    localizada em `en`, `pt-br` e `es`);
// 2. o transporte de e-mail (SMTP já está em `@prometheon/config`), com as
//    falhas 4xx do servidor tratadas como permanentes e as 5xx como
//    transitórias;
// 3. a notificação in-app, que precisa de tabela própria — o schema atual não
//    tem `notifications`, então gravar aqui seria inventar modelo de dados;
// 4. o webhook de saída da organização, com sua própria assinatura.
//
// Nada de conteúdo sensível no log: variáveis de template podem carregar título
// de tarefa e trecho de mensagem, e o `Docs/11` proíbe despejar isso por padrão.

import { users } from '@prometheon/database';

import { PermanentJobError } from '../../errors.js';
import { notificationJobSchema } from '../payloads.js';
import type { JobHandler } from '../runtime.js';

export const notificationsHandler: JobHandler<typeof notificationJobSchema> = {
  queue: 'notifications',
  schema: notificationJobSchema,
  idempotencyKey: (data, job) =>
    `${data.channel}:${data.template}:${data.recipientUserId ?? data.recipientAddress ?? job.id ?? 'anonymous'}`,
  async run({ data, deps, logger }) {
    if (data.recipientUserId == null && data.recipientAddress == null) {
      throw new PermanentJobError('Notificação sem destinatário.', {
        code: 'NOTIFICATION_RECIPIENT_MISSING',
        details: { template: data.template, channel: data.channel },
      });
    }

    let recipientEmail = data.recipientAddress ?? null;

    if (data.recipientUserId != null) {
      const user = await deps.db.manager
        .createQueryBuilder(users, 'user')
        .select([
          'user.id',
          'user.email',
          'user.status',
          'user.emailVerifiedAt',
          'user.locale',
          'user.deletedAt',
        ])
        .where('user.id = :userId', { userId: data.recipientUserId })
        .limit(1)
        .getOne();

      if (user === null) {
        throw new PermanentJobError('Destinatário inexistente.', {
          code: 'NOTIFICATION_RECIPIENT_NOT_FOUND',
          details: { recipientUserId: data.recipientUserId },
        });
      }
      if (user.deletedAt !== null) {
        throw new PermanentJobError('Destinatário com conta apagada.', {
          code: 'NOTIFICATION_RECIPIENT_DELETED',
          details: { recipientUserId: data.recipientUserId },
        });
      }
      if (data.channel === 'email' && user.emailVerifiedAt === null) {
        throw new PermanentJobError('E-mail do destinatário não verificado.', {
          code: 'NOTIFICATION_EMAIL_NOT_VERIFIED',
          details: { recipientUserId: data.recipientUserId },
        });
      }
      recipientEmail = user.email;
    }

    logger.info(
      {
        channel: data.channel,
        template: data.template,
        recipientUserId: data.recipientUserId,
        // O endereço em si é dado pessoal: registra-se apenas a presença.
        hasAddress: recipientEmail !== null,
        variableCount: Object.keys(data.variables).length,
      },
      'notificação validada; entrega pendente da API',
    );

    return {
      status: 'pending-api',
      details: {
        channel: data.channel,
        template: data.template,
        pending: 'catálogo de templates e transporte em apps/hub-api',
      },
    };
  },
};
