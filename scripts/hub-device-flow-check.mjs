// Exercita o device flow contra a API real, usando o mesmo cliente que a
// extensão usa. Prova que o contrato entre os dois lados casa de verdade —
// nomes de campo, códigos de erro e formato da credencial.
import { pathToFileURL } from 'node:url';
import process from 'node:process';

// Mesma variável que a CLI usa; sem ela, o alvo é o Hub de desenvolvimento.
const API = process.env.PROMETHEON_HUB_URL ?? 'http://127.0.0.1:3551';
const flow = await import(
  pathToFileURL('f:/Projects/Prometheon/extension/out/hub/deviceFlow.js').href
);

let failures = 0;
const report = (step, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Mesma interface HTTP que o LiveHubClient monta. */
const http = {
  async post(path, body) {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  },
};

// 1 — a extensão pede o código
let authorization;
try {
  authorization = await flow.requestDeviceAuthorization(http, {
    deviceName: 'VS Code — smoke',
    deviceKind: 'vscode',
    clientVersion: '0.0.1',
    platform: process.platform,
  });
  report(
    'a API devolve os campos que a extensão espera',
    typeof authorization.deviceCode === 'string' &&
      typeof authorization.userCode === 'string' &&
      typeof authorization.verificationUri === 'string',
    `código ${authorization.userCode}`,
  );
  report(
    'intervalo e expiração vêm utilizáveis',
    authorization.intervalSeconds >= 5 && authorization.expiresInSeconds > 60,
    `${authorization.intervalSeconds}s / ${authorization.expiresInSeconds}s`,
  );
} catch (error) {
  report('a API devolve os campos que a extensão espera', false, error.message);
  process.exit(1);
}

// 2 — antes da aprovação, o polling precisa dizer "pendente" e não falhar
const pending = await flow.pollDeviceToken(http, authorization.deviceCode);
report(
  'polling antes da aprovação devolve pendente',
  pending.kind === 'pending' || pending.kind === 'slow-down',
  pending.kind,
);

// 3 — código inventado não pode virar credencial
try {
  const bogus = await flow.pollDeviceToken(http, 'dev_codigo_que_nao_existe');
  report(
    'código inexistente não autoriza',
    bogus.kind !== 'authorized',
    bogus.kind,
  );
} catch {
  report('código inexistente não autoriza', true, 'recusado com erro');
}

console.log(
  `\n${failures === 0 ? 'Extensão e API falam a mesma língua no device flow.' : `${failures} divergência(s).`}`,
);
process.exit(failures === 0 ? 0 : 1);
