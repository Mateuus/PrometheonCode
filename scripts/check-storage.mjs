#!/usr/bin/env node
// Confere se o armazenamento de objetos responde e se as credenciais têm as
// permissões que a aplicação precisa: escrever, ler, listar e apagar.
//
// Um teste que só faz upload esconde metade dos problemas — a chave costuma ter
// escopo de escrita e não de leitura, e isso só aparece quando alguém tenta
// baixar o próprio anexo.
//
// Uso: node scripts/check-storage.mjs

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) {
    env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
}

if (!env.R2_ACCESS_KEY || !env.R2_SECRET_KEY) {
  console.log('R2 sem credenciais: a aplicação usará o disco local. Nada a verificar.');
  process.exit(0);
}

const client = new S3Client({
  region: env.R2_REGION || 'auto',
  endpoint: env.R2_ENDPOINT,
  credentials: { accessKeyId: env.R2_ACCESS_KEY, secretAccessKey: env.R2_SECRET_KEY },
});

const bucket = env.R2_BUCKET;
const key = `healthcheck/${Date.now()}.txt`;
const body = 'prometheon storage check';
const problems = [];

async function step(label, run) {
  try {
    const detail = await run();
    console.log(`ok    ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  } catch (error) {
    console.log(`FALHA ${label} — ${error.name}: ${error.message}`);
    problems.push(label);
  }
}

await step('bucket alcançável', async () => {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  return bucket;
});

await step('escrita', async () => {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'text/plain; charset=utf-8',
    }),
  );
  return key;
});

await step('leitura devolve o mesmo conteúdo', async () => {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await response.Body.transformToString();
  if (text !== body) {
    throw new Error(`conteúdo diferente: "${text}"`);
  }
  return `${text.length} bytes`;
});

await step('listagem por prefixo', async () => {
  const response = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: 'healthcheck/', MaxKeys: 5 }),
  );
  return `${response.KeyCount ?? 0} objeto(s)`;
});

// A URL assinada é como o anexo privado chega ao navegador sem tornar o bucket
// público; se ela não funcionar, todo o desenho de privacidade cai.
await step('URL assinada funciona', async () => {
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 60,
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text !== body) {
    throw new Error('a URL assinada devolveu outro conteúdo');
  }
  return 'expira em 60s';
});

await step('remoção', async () => {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return 'objeto de teste removido';
});

if (problems.length > 0) {
  console.error(`\n${problems.length} verificação(ões) falharam: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('\nArmazenamento pronto.');
