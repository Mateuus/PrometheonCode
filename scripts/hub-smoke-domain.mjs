// Teste de fumaça do domínio: projetos, conversas, mensagens e tarefas contra a
// API no ar e o MySQL real.
//
// Continua de onde `hub-smoke.mjs` para: cria a conta pelo mesmo caminho (o do
// usuário), e daí em diante exercita as rotas do `Docs/06` que dependem umas das
// outras. No fim confere, direto no banco, que cada mudança deixou o evento
// correspondente em `outbox_messages` — que é o que o `Docs/08` exige e o que o
// worker publica no WebSocket.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { createConnection } from 'mysql2/promise';

// Rodando pela raiz do monorepo, as credenciais do banco vivem no `.env` e não
// no ambiente do processo. Sem esta leitura, a conexão cai no padrão
// `localhost:3306` e estoura com ECONNREFUSED longe do ponto que falhou.
for (const line of readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  'utf8',
).split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match !== null && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
}

const API = process.env.HUB_API_URL || 'http://127.0.0.1:3551';
// `||` e não `??`: no `.env` a chave existe vazia, e string vazia aqui é
// ausência de valor, não escolha de diretório.
const MAIL_DIR = process.env.MAIL_CAPTURE_DIR || join(tmpdir(), 'prometheon-mail');
const stamp = Date.now();
const email = `dominio-${stamp}@exemplo.test`;
const password = 'Senha-Muito-Forte-123'; // secret-scan:ignore — conta criada só por este script

let failures = 0;

function report(step, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${step}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

function tokenFromLatestMail(kind, to) {
  const files = readdirSync(MAIL_DIR)
    .filter((name) => name.includes(kind) && name.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of files) {
    const content = readFileSync(join(MAIL_DIR, name), 'utf8');
    if (to !== undefined && !content.includes(to)) {
      continue;
    }
    const match = /token=([A-Za-z0-9_.-]{16,})/.exec(content);
    if (match !== null) {
      return match[1];
    }
  }
  return null;
}

console.log(`conta de teste: ${email}\n`);

// --- identidade -------------------------------------------------------------

const registered = await call('POST', '/v1/auth/register', {
  body: { email, password, name: 'Domínio Prometheon', acceptedTerms: true },
});
report('registro aceito', registered.status === 202, `HTTP ${registered.status}`);

const verifyToken = tokenFromLatestMail('email-verification', email);
report('e-mail de verificação capturado', verifyToken !== null);

const verified = await call('POST', '/v1/auth/verify-email', { body: { token: verifyToken } });
report('verificação aceita', verified.status < 300, `HTTP ${verified.status}`);

const login = await call('POST', '/v1/auth/login', { body: { email, password } });
const token = login.json.data?.tokens?.accessToken;
report('login devolve access token', typeof token === 'string', `HTTP ${login.status}`);

const me = await call('GET', '/v1/me', { token });
const organizationId = me.json.data?.activeOrganizationId;
report('a conta nasce com organização', typeof organizationId === 'string', organizationId ?? '');

if (failures > 0) {
  console.log('\nInterrompido: sem identidade não há o que exercitar.');
  process.exit(1);
}

// --- projeto ----------------------------------------------------------------

const project = await call('POST', `/v1/organizations/${organizationId}/projects`, {
  token,
  body: { name: `Fumaça de Domínio ${stamp}`, tags: ['smoke'] },
});
const projectId = project.json.data?.id;
report('POST /projects cria o projeto', project.status === 201, `HTTP ${project.status} ${projectId ?? ''}`);

const readProject = await call('GET', `/v1/projects/${projectId}`, { token });
report(
  'GET /projects/:id devolve configuração e etiquetas',
  readProject.status === 200 &&
    readProject.json.data?.settings?.requireReview === true &&
    readProject.json.data?.tags?.[0] === 'smoke',
  `HTTP ${readProject.status}`,
);

const patched = await call('PATCH', `/v1/projects/${projectId}`, {
  token,
  body: { description: 'Projeto do teste de fumaça', version: readProject.json.data?.version },
});
report('PATCH /projects/:id aplica concorrência otimista', patched.status === 200, `HTTP ${patched.status}`);

const stale = await call('PATCH', `/v1/projects/${projectId}`, {
  token,
  body: { description: 'Versão atrasada', version: readProject.json.data?.version },
});
report(
  'a mesma versão não serve duas vezes',
  stale.status === 409 && stale.json.error?.code === 'VERSION_CONFLICT',
  `HTTP ${stale.status} ${stale.json.error?.code ?? ''}`,
);

const projectList = await call('GET', `/v1/organizations/${organizationId}/projects?limit=1`, { token });
report(
  'GET /projects pagina por cursor',
  projectList.status === 200 && Array.isArray(projectList.json.data?.items),
  `HTTP ${projectList.status}`,
);

// --- conversa e mensagem ----------------------------------------------------

const conversation = await call('POST', `/v1/projects/${projectId}/conversations`, {
  token,
  body: { title: 'Fumaça', initialMessage: 'Primeira mensagem do teste.' },
});
const conversationId = conversation.json.data?.id;
report(
  'POST /conversations cria com a primeira mensagem',
  conversation.status === 201 && conversation.json.data?.messageCount === 1,
  `HTTP ${conversation.status} ${conversationId ?? ''}`,
);

const message = await call('POST', `/v1/conversations/${conversationId}/messages`, {
  token,
  body: {
    parts: [
      { type: 'text', text: 'Segunda mensagem, com partes.' },
      { type: 'tool_call', toolCallId: 'call-1', toolName: 'grep', arguments: { pattern: 'outbox' } },
    ],
    contextRefs: [{ kind: 'file', reference: 'apps/hub-api/src/app.ts', label: 'app.ts' }],
  },
});
report(
  'POST /messages grava envelope e partes ordenadas',
  message.status === 201 &&
    message.json.data?.sequence === 2 &&
    message.json.data?.parts?.length === 2,
  `HTTP ${message.status} sequence=${message.json.data?.sequence ?? '?'}`,
);

const reasoning = await call('POST', `/v1/conversations/${conversationId}/messages`, {
  token,
  body: { parts: [{ type: 'reasoning_summary', summary: 'raciocínio bruto de pessoa' }] },
});
report(
  'resumo de raciocínio em mensagem de pessoa é recusado',
  reasoning.status === 400,
  `HTTP ${reasoning.status} ${reasoning.json.error?.code ?? ''}`,
);

// Dez envios simultâneos: as sequências precisam sair contíguas e sem repetir.
const burst = await Promise.all(
  Array.from({ length: 10 }, (_, index) =>
    call('POST', `/v1/conversations/${conversationId}/messages`, {
      token,
      body: { parts: [{ type: 'text', text: `paralela ${index}` }] },
    }),
  ),
);
const sequences = burst.map((item) => item.json.data?.sequence).sort((left, right) => left - right);
report(
  'dez mensagens simultâneas recebem sequências contíguas',
  burst.every((item) => item.status === 201) &&
    sequences.every((value, index) => value === sequences[0] + index),
  sequences.join(','),
);

const messageList = await call('GET', `/v1/conversations/${conversationId}/messages?limit=5`, { token });
report(
  'GET /messages pagina por cursor',
  messageList.status === 200 && messageList.json.data?.items?.length === 5,
  `HTTP ${messageList.status}`,
);

// --- tarefa -----------------------------------------------------------------

const task = await call('POST', `/v1/projects/${projectId}/tasks`, {
  token,
  body: { title: 'Tarefa da fumaça', priority: 'high', tags: ['smoke'] },
});
const taskId = task.json.data?.id;
report(
  'POST /tasks cria a tarefa em ready',
  task.status === 201 && task.json.data?.status === 'ready',
  `HTTP ${task.status} ${taskId ?? ''}`,
);

const claimed = await call('POST', `/v1/tasks/${taskId}/claim`, {
  token,
  body: { leaseSeconds: 300 },
});
report(
  'POST /tasks/:id/claim reivindica com prazo',
  claimed.status === 200 && typeof claimed.json.data?.claim?.expiresAt === 'string',
  `HTTP ${claimed.status} expira em ${claimed.json.data?.claim?.expiresAt ?? '?'}`,
);

const released = await call('POST', `/v1/tasks/${taskId}/release`, {
  token,
  body: { status: 'in_review' },
});
report(
  'POST /tasks/:id/release solta e muda o estado',
  released.status === 200 && released.json.data?.status === 'in_review' && released.json.data?.claim === null,
  `HTTP ${released.status}`,
);

const orphan = await call('POST', `/v1/tasks/${taskId}/release`, { token, body: { status: 'ready' } });
report(
  'soltar de novo falha com TASK_NOT_CLAIMED_BY_ACTOR',
  orphan.status === 409 && orphan.json.error?.code === 'TASK_NOT_CLAIMED_BY_ACTOR',
  `HTTP ${orphan.status} ${orphan.json.error?.code ?? ''}`,
);

const updated = await call('PATCH', `/v1/tasks/${taskId}`, {
  token,
  body: { priority: 'urgent', version: released.json.data?.version },
});
report('PATCH /tasks/:id atualiza', updated.status === 200, `HTTP ${updated.status}`);

const taskList = await call('GET', `/v1/projects/${projectId}/tasks?limit=10`, { token });
report(
  'GET /tasks lista o que foi criado',
  taskList.status === 200 && taskList.json.data?.items?.length >= 1,
  `HTTP ${taskList.status}`,
);

// --- outbox -----------------------------------------------------------------

const connection = await createConnection({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 3306),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
});

try {
  const [rows] = await connection.query(
    `SELECT event_type, COUNT(*) AS total
       FROM outbox_messages
      WHERE project_id = ?
      GROUP BY event_type`,
    [projectId],
  );
  const counted = Object.fromEntries(rows.map((row) => [row.event_type, Number(row.total)]));

  console.log('\neventos em outbox_messages:', JSON.stringify(counted));

  report('message.created no outbox', (counted['message.created'] ?? 0) === 12, `${counted['message.created'] ?? 0} eventos`);
  report('task.created no outbox', (counted['task.created'] ?? 0) === 1);
  report('task.claimed no outbox', (counted['task.claimed'] ?? 0) === 1);
  report('task.released no outbox', (counted['task.released'] ?? 0) === 1);
  report('task.updated no outbox', (counted['task.updated'] ?? 0) === 1);

  const [pending] = await connection.query(
    'SELECT COUNT(*) AS total FROM outbox_messages WHERE project_id = ? AND published_at IS NULL',
    [projectId],
  );
  report(
    'todos os eventos aguardam o worker (published_at nulo)',
    Number(pending[0].total) === Object.values(counted).reduce((sum, value) => sum + value, 0),
  );

  const [orphanMessages] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM messages m
       LEFT JOIN outbox_messages o
              ON o.aggregate_id = m.conversation_id
             AND o.aggregate_sequence = m.sequence
             AND o.event_type = 'message.created'
      WHERE m.conversation_id = ? AND o.id IS NULL`,
    [conversationId],
  );
  report(
    'nenhuma mensagem ficou sem evento',
    Number(orphanMessages[0].total) === 0,
    `${orphanMessages[0].total} órfã(s)`,
  );
} finally {
  await connection.end();
}

console.log(
  `\n${failures === 0 ? 'Domínio completo funcionando.' : `${failures} verificação(ões) falharam.`}`,
);
process.exit(failures === 0 ? 0 : 1);
