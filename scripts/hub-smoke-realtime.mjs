#!/usr/bin/env node
// Prova o caminho completo do Hub, com API e worker no ar:
//
//   mensagem criada na API → evento no outbox → publicado pelo worker
//   → entregue ao cliente WebSocket
//
// É o único teste que exercita as três peças juntas. Os testes de cada uma
// cobrem o comportamento interno; este cobre o que acontece entre elas.
//
// Uso: node scripts/hub-smoke-realtime.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match !== null && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
}

const wsModule = await import(pathToFileURL(join(root, 'apps/hub-api/node_modules/ws/index.js')).href);
const WebSocket = wsModule.WebSocket ?? wsModule.default;

const API = process.env.HUB_API_URL ?? 'http://127.0.0.1:3551';
const MAIL_DIR = process.env.MAIL_CAPTURE_DIR || join(tmpdir(), 'prometheon-mail');
const password = 'Senha-Muito-Forte-123'; // secret-scan:ignore
const email = `realtime-${Date.now()}@exemplo.test`;

let failures = 0;
const report = (step, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${step}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
};

async function call(method, path, { body, token } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? {} : JSON.parse(text) };
}

function verificationToken() {
  const files = readdirSync(MAIL_DIR)
    .filter((name) => name.includes('email-verification') && name.endsWith('.json'))
    .sort()
    .reverse();
  const content = readFileSync(join(MAIL_DIR, files[0]), 'utf8');
  return /token=([A-Za-z0-9_.-]{16,})/.exec(content)?.[1] ?? null;
}

// --- identidade --------------------------------------------------------------

await call('POST', '/v1/auth/register', {
  body: { email, password, name: 'Fumaça Realtime', acceptedTerms: true },
});
await call('POST', '/v1/auth/verify-email', { body: { token: verificationToken() } });
const login = await call('POST', '/v1/auth/login', { body: { email, password } });
const token = login.json.data?.tokens?.accessToken;
const me = await call('GET', '/v1/me', { token });
const organizationId = me.json.data?.activeOrganizationId;
report('conta pronta com organização', typeof token === 'string' && typeof organizationId === 'string');

const project = await call('POST', `/v1/organizations/${organizationId}/projects`, {
  token,
  body: { name: `Projeto Realtime ${Date.now()}`, slug: `realtime-${Date.now()}` },
});
const projectId = project.json.data?.id;
report('projeto criado', project.status === 201, `HTTP ${project.status}`);

// --- WebSocket ---------------------------------------------------------------

const ticket = await call('GET', '/v1/realtime/token', { token });
const realtimeToken = ticket.json.data?.token;
report('bilhete de tempo real emitido', ticket.status === 200 && typeof realtimeToken === 'string');

const socketUrl = `${API.replace('http', 'ws')}/v1/realtime?token=${encodeURIComponent(realtimeToken)}`;
const socket = new WebSocket(socketUrl);
const received = [];
let welcome = null;

const waitFor = (predicate, timeoutMs, label) =>
  new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(null), timeoutMs);
    const check = () => {
      const found = received.find(predicate);
      if (found !== undefined) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve(found);
      }
    };
    const poll = setInterval(check, 50);
    check();
  });

socket.on('message', (raw) => {
  try {
    const message = JSON.parse(String(raw));
    received.push(message);
    if (message.type === 'welcome') {
      welcome = message;
    }
  } catch {
    // Frame não-JSON não interessa a este teste.
  }
});

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
  setTimeout(() => reject(new Error('o socket não abriu em 10s')), 10_000);
});
report('conexão WebSocket aberta', socket.readyState === WebSocket.OPEN);

// O formato é o `helloMessageSchema` de @prometheon/contracts: campos nulos são
// obrigatórios e explícitos, para o servidor distinguir "não informado" de
// "informado como vazio".
socket.send(
  JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    deviceId: null,
    clientVersion: 'smoke/1',
    subscriptions: [{ organizationId, projectId: null, eventTypes: [] }],
    cursor: null,
  }),
);
const welcomed = await waitFor((m) => m.type === 'welcome', 10_000);
report('servidor respondeu welcome', welcomed !== null, welcomed?.sessionId ?? '');

// --- o caminho completo ------------------------------------------------------

const conversation = await call('POST', `/v1/projects/${projectId}/conversations`, {
  token,
  body: { title: 'Conversa de fumaça' },
});
report('conversa criada', conversation.status === 201, `HTTP ${conversation.status}`);

// A conversa nasce vazia; a mensagem é uma chamada própria. A parte usa `type`,
// que é o discriminador da união no contrato.
const message = await call('POST', `/v1/conversations/${conversation.json.data?.id}/messages`, {
  token,
  body: { authorType: 'user', parts: [{ type: 'text', text: 'olá pelo websocket' }] },
});
report('mensagem criada', message.status === 201, `HTTP ${message.status}`);

// A entrega depende do worker varrer o outbox, publicar no Redis e a API
// repassar ao socket. Três processos, então a espera é generosa.
//
// O evento vem envelopado em `{ type: 'event', event }`, como manda o
// `eventMessageSchema`: o tipo de domínio fica dentro, e o de fora identifica a
// natureza do frame no protocolo.
const frame = await waitFor(
  (m) => m.type === 'event' && m.event?.type === 'message.created',
  25_000,
);
report(
  'evento chegou ao cliente pelo WebSocket',
  frame !== null,
  frame === null ? 'nada chegou em 25s' : `cursor ${String(frame.event.cursor).slice(0, 12)}…`,
);
if (frame !== null) {
  report('o evento traz a organização certa', frame.event.organizationId === organizationId);
  report('o cursor é o identificador do evento', frame.event.cursor === frame.event.id);
}

socket.close();
console.log(
  `\n${failures === 0 ? 'API, worker e WebSocket funcionando juntos.' : `${failures} verificação(ões) falharam.`}`,
);
process.exit(failures === 0 ? 0 : 1);
