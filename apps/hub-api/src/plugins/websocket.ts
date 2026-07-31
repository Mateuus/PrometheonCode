/**
 * Suporte a WebSocket.
 *
 * Registrado no mesmo lugar dos demais plugins de infraestrutura porque precisa
 * existir antes de qualquer rota `{ websocket: true }` ser declarada.
 *
 * `maxPayload` é o **limite de payload** que o `Docs/08` pede, e ele vive aqui e
 * não no handler por um motivo prático: o `ws` recusa o frame antes de montá-lo
 * na memória. Checar o tamanho depois de receber já seria tarde.
 */

import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';

import { REALTIME_SETTINGS } from '../modules/realtime/settings.js';

export async function registerWebsocket(app: FastifyInstance): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: REALTIME_SETTINGS.maxIncomingPayloadBytes,
      // A lista de clientes do `ws` não é usada: quem indexa as conexões é o
      // `RealtimeHub`, que precisa delas agrupadas por organização.
      clientTracking: false,
    },
  });
}
