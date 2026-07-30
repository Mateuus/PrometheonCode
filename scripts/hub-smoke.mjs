// Teste de fumaça do Hub: percorre o fluxo real de cadastro contra a API no ar,
// lendo o token do e-mail que a captura gravou em disco. É o que prova que os
// quatro trabalhos paralelos conversam entre si.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const API = 'http://127.0.0.1:3551';
const MAIL_DIR = join(tmpdir(), 'prometheon-mail');
const email = process.argv[2] ?? `smoke-${Date.now()}@exemplo.test`;
const password = 'Senha-Muito-Forte-123'; // secret-scan:ignore — conta criada e apagada pelo próprio script

let failures = 0;

function report(step, ok, detail = '') {
  const mark = ok ? 'ok  ' : 'FALHA';
  console.log(`${mark} ${step}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

async function call(method, path, { body, token, cookie, origin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin !== undefined) {
    headers.origin = origin;
  }
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  if (cookie !== undefined) {
    headers.cookie = cookie;
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
  return { status: response.status, json, headers: response.headers };
}

/** Procura o token no e-mail mais recente do tipo pedido. */
function tokenFromLatestMail(kind) {
  const files = readdirSync(MAIL_DIR)
    .filter((name) => name.includes(kind) && name.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) {
    return null;
  }
  const content = readFileSync(join(MAIL_DIR, files[0]), 'utf8');
  const match = /token=([A-Za-z0-9_.-]{16,})/.exec(content);
  return match?.[1] ?? null;
}

console.log(`conta de teste: ${email}\n`);

// 1 — registro
const registered = await call('POST', '/v1/auth/register', {
  body: { email, password, name: 'Fumaça Prometheon', acceptedTerms: true },
});
report(
  'registro devolve 202 sem expor a conta',
  registered.status === 202 &&
    registered.json.data?.email === email &&
    registered.json.data?.user === undefined,
  `HTTP ${registered.status}`,
);

// 2 — login antes de verificar entra, mas não escreve. Permitir a entrada é
// decisão de produto; o que não pode é agir sem provar posse do endereço.
const early = await call('POST', '/v1/auth/login', { body: { email, password } });
report(
  'login antes da verificação entra com emailVerified=false',
  early.status === 200 && early.json.data?.user?.emailVerified === false,
  `HTTP ${early.status}`,
);
const earlyWrite = await call('POST', '/v1/organizations', {
  body: { name: 'Org Sem Verificar' },
  token: early.json.data?.tokens?.accessToken,
});
report(
  'escrita antes da verificação é barrada',
  earlyWrite.status >= 400 && earlyWrite.json.error?.code === 'EMAIL_NOT_VERIFIED',
  `HTTP ${earlyWrite.status} ${earlyWrite.json.error?.code ?? ''}`,
);

// 3 — verificação com o token do e-mail
const verifyToken = tokenFromLatestMail('email-verification');
report('e-mail de verificação capturado em disco', verifyToken !== null);
const verified = await call('POST', '/v1/auth/verify-email', { body: { token: verifyToken } });
report('verificação aceita o token', verified.status < 300, `HTTP ${verified.status}`);

// 4 — token de uso único
const replay = await call('POST', '/v1/auth/verify-email', { body: { token: verifyToken } });
report('token de verificação não pode ser reusado', replay.status >= 400, `HTTP ${replay.status}`);

// 5 — login
const login = await call('POST', '/v1/auth/login', {
  body: { email, password, clientName: 'smoke' },
});
const accessToken = login.json.data?.tokens?.accessToken;
report(
  'login devolve access token e refresh no corpo (cliente não-browser)',
  login.status < 300 &&
    typeof accessToken === 'string' &&
    typeof login.json.data?.tokens?.refreshToken === 'string',
  `HTTP ${login.status}`,
);

// 5b — o mesmo login a partir do Hub Web: refresh sai do corpo e vai para cookie
const browserLogin = await call('POST', '/v1/auth/login', {
  body: { email, password, clientName: 'hub-web' },
  origin: 'http://127.0.0.1:3550',
});
const browserCookies = browserLogin.headers.getSetCookie?.() ?? [];
report(
  'login de browser manda refresh em cookie HttpOnly',
  browserCookies.some((cookie) => /httponly/i.test(cookie)),
  browserCookies.map((cookie) => cookie.split('=')[0]).join(', '),
);
report(
  'login de browser não repete o refresh no corpo',
  browserLogin.json.data?.tokens?.refreshToken === undefined,
);

// 6 — identidade e escrita já verificada
const me = await call('GET', '/v1/me', { token: accessToken });
report(
  'GET /v1/me reconhece a conta',
  me.status === 200 && me.json.data?.user?.email === email,
  `HTTP ${me.status}`,
);
// O registro já cria uma organização pessoal com o usuário como owner: sem isso
// a pessoa entraria no Hub sem lugar nenhum para trabalhar.
report(
  'a conta nasce com organização própria e papel owner',
  me.json.data?.organizations?.[0]?.role === 'owner' &&
    typeof me.json.data?.activeOrganizationId === 'string',
  me.json.data?.organizations?.[0]?.slug ?? '',
);

const write = await call('POST', '/v1/organizations', {
  body: { name: `Org da Fumaça ${Date.now()}` },
  token: accessToken,
});
report('escrita depois da verificação é aceita', write.status < 300, `HTTP ${write.status}`);

// 7 — senha errada
const wrong = await call('POST', '/v1/auth/login', { body: { email, password: 'senha-errada-123' } }); // secret-scan:ignore
report('senha errada é recusada', wrong.status >= 400, `HTTP ${wrong.status}`);

// 8 — anti-enumeração: conta inexistente responde igual
const unknown = await call('POST', '/v1/auth/login', {
  body: { email: `nao-existe-${Date.now()}@exemplo.test`, password },
});
report(
  'conta inexistente responde como senha errada',
  unknown.status === wrong.status && unknown.json.error?.code === wrong.json.error?.code,
  `${unknown.status} ${unknown.json.error?.code ?? ''}`,
);

// 9 — sem token não passa
const anonymous = await call('GET', '/v1/me');
report('rota protegida exige credencial', anonymous.status === 401, `HTTP ${anonymous.status}`);

// 10 — OpenAPI publicada
const openapi = await call('GET', '/v1/openapi.json');
const paths = Object.keys(openapi.json.paths ?? {}).length;
report('OpenAPI publicada', openapi.status === 200 && paths > 10, `${paths} rotas`);

console.log(`\n${failures === 0 ? 'Fluxo completo funcionando.' : `${failures} verificação(ões) falharam.`}`);
process.exit(failures === 0 ? 0 : 1);
