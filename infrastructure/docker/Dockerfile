# Imagem única para os três serviços do Hub — API, worker e web.
#
# Uma imagem só, e não três, porque os três compartilham o mesmo workspace pnpm
# e as mesmas dependências. Três imagens repetiriam `node_modules` inteiro em
# cada uma para economizar alguns megabytes de código próprio; uma imagem
# compartilhada é menor no total, sobe mais rápido e só precisa ser reconstruída
# uma vez. O que muda entre os serviços é o `command` no compose.
#
# Base Debian slim, não Alpine: `argon2` e `sharp` distribuem binários
# pré-compilados para glibc. No Alpine (musl) eles caem para compilação na hora
# da instalação, o que às vezes funciona e às vezes falha em runtime — e uma
# falha do argon2 significa que nenhuma senha é conferida.

# ---------------------------------------------------------------------------
# 1. Dependências
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

# Ferramentas de compilação para o caso de algum módulo nativo não ter binário
# pronto para esta plataforma. Ficam só neste estágio: a imagem final não as tem.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Só os manifestos primeiro: enquanto eles não mudarem, o Docker reaproveita a
# camada de instalação inteira, mesmo que todo o código tenha mudado.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub-api/package.json apps/hub-api/
COPY apps/hub-web/package.json apps/hub-web/
COPY apps/hub-worker/package.json apps/hub-worker/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/logger/package.json packages/logger/
COPY packages/permissions/package.json packages/permissions/
COPY packages/testing/package.json packages/testing/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

# Ordem importa: os pacotes compartilhados precisam estar compilados antes de a
# API e o worker resolverem os tipos deles.
RUN pnpm --filter @prometheon/logger --filter @prometheon/contracts \
  --filter @prometheon/config --filter @prometheon/permissions \
  --filter @prometheon/database build

RUN pnpm --filter @prometheon/hub-api --filter @prometheon/hub-worker build

# O Next precisa de `NODE_ENV=production` já no build para gerar o bundle certo.
# As URLs públicas são lidas em runtime, então não entram aqui — trocar de
# domínio não deve exigir reconstruir a imagem.
ENV NODE_ENV=production
RUN pnpm --filter @prometheon/hub-web build

# Tira o que só servia para compilar. `--prod` remove devDependencies do
# workspace inteiro de uma vez.
#
# `CI=true` não é decoração: sem TTY, o pnpm se recusa a apagar `node_modules`
# e aborta com `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. A proteção existe
# para quem digitou o comando por engano no terminal; num build de container ela
# só impede o build de terminar.
RUN CI=true pnpm prune --prod

# ---------------------------------------------------------------------------
# 3. Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# `tini` como PID 1: o Node sozinho nesse lugar não repassa SIGTERM direito, e o
# desligamento gracioso do Fastify e do BullMQ depende de receber o sinal. Sem
# ele, `docker compose down` mataria conexões e jobs no meio.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Roda como usuário sem privilégio. A imagem `node` já traz o usuário `node`.
COPY --from=build --chown=node:node /app /app

USER node

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]

# Sobrescrito no compose — cada serviço aponta para o seu.
CMD ["node", "apps/hub-api/dist/server.js"]
