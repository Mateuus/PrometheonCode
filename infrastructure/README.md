# Prometheon Hub em produção

Infraestrutura própria, com o aaPanel como reverse proxy no host e tudo mais em
containers.

O que roda onde:

| Serviço | Porta | Alcance |
| --- | --- | --- |
| `web` (Next.js) | 3550 | só `127.0.0.1` — o nginx do aaPanel alcança |
| `api` (REST + WebSocket) | 3551 | só `127.0.0.1` |
| `worker` (filas, outbox) | 3552 | só a rede interna do Docker |
| `mysql` | 3306 | só a rede interna |
| `redis` | 6379 | só a rede interna |
| `mailserver` | 25, 587 | 25 pública; 587 só `127.0.0.1` |

---

## 1. DNS

Sete registros. O `Proxy` importa tanto quanto o valor.

| # | Tipo | Nome | Conteúdo | Proxy |
| --- | --- | --- | --- | --- |
| 1 | A | `hub` | IP público | **DNS only** (cinza) |
| 2 | A | `api` | IP público | **DNS only** (cinza) |
| 3 | A | `smtp` | IP público | **DNS only — obrigatório** |
| 4 | MX | `@` | `smtp.prometheoncode.xyz`, prioridade `10` | não se aplica |
| 5 | TXT | `@` | `v=spf1 mx -all` | não se aplica |
| 6 | TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@prometheoncode.xyz` | não se aplica |
| 7 | TXT | `mail._domainkey` | gerado no passo 6 | não se aplica |

### O proxy do `smtp` precisa ficar desligado

A nuvem laranja da Cloudflare só faz proxy de HTTP e HTTPS. Ligada num registro
de e-mail, ela substitui o seu IP por um da Cloudflare — que não escuta nas
portas 25, 587 e 993. O domínio para de receber e de enviar por completo, e o
diagnóstico é confuso porque o DNS resolve normalmente.

O MX aponta para o `smtp`, então esse registro tem de expor o IP real. É por
isso que ele é o único onde a escolha não é opcional.

### `hub` e `api` começam em DNS only

Com o proxy ligado, a emissão do certificado no aaPanel disputa a validação com
a Cloudflare e falha de um jeito que parece erro de configuração do servidor.
Suba tudo em cinza, confirme que os dois sites respondem em HTTPS, e só então
ligue o proxy se quiser esconder o IP — nessa ordem, se algo quebrar você sabe
o que mudou.

Ao ligar, o modo de SSL da Cloudflare precisa ser **Full (strict)**. Em
`Flexible`, ela fala HTTP com o seu servidor enquanto o navegador vê HTTPS: o
`HTTP_TO_HTTPS` do nginx redireciona, a Cloudflare pede de novo, e o resultado é
um laço de redirecionamento.

### O `cdn`

Não crie o registro à mão. No painel do R2, em **Settings → Custom Domains** do
bucket, adicione `cdn.prometheoncode.xyz` — a Cloudflare cria o DNS e emite o
certificado sozinha. Um CNAME manual para `pub-….r2.dev` funciona para servir
arquivo, mas fica sem certificado válido para o seu domínio.

### O que cada registro de e-mail faz

O **MX** é o que permite receber. Sem ele, `mateus@prometheoncode.xyz` não existe
para o resto do mundo, e as devoluções dos envios somem sem deixar rastro.

O **SPF** declara quem pode enviar em nome do domínio. `mx` significa "o
servidor apontado pelo meu MX"; `-all` diz que mais ninguém — sem essa parte
final, qualquer um pode se passar por você e a declaração não serve de nada.

O **DMARC** diz o que fazer com quem falha na verificação, e `rua` é para onde
vão os relatórios. `p=quarantine` manda para spam; comece por aí e só passe a
`p=reject` depois de algumas semanas vendo os relatórios, porque `reject` numa
configuração ainda errada descarta e-mail legítimo silenciosamente.

O **DKIM** em `mail._domainkey` publica a chave que assina cada mensagem. O nome
vem do seletor padrão do docker-mailserver — não é subdomínio novo.

### Se o IP for dinâmico

Deixe só `hub` como A, com um DDNS atualizando, e faça `api` e `smtp` como CNAME
para `hub`. Um registro muda quando o IP mudar, em vez de três — três registros
mantidos por processos diferentes é como se descobre, no pior momento, que um
ficou para trás.

### PTR reverso — o que decide tudo

O reverso do seu IP precisa apontar para `smtp.prometheoncode.xyz`, e **só o seu
provedor de internet pode configurar isso**. Em link residencial normalmente não
dá, e o reverso fica com o nome genérico do ISP.

Sem PTR, Gmail e Outlook recusam ou mandam para spam por padrão, por mais
correto que esteja o resto. Se for o seu caso, a saída está no passo 6.

---

## 2. NAT

| Porta | Para | Por quê |
| --- | --- | --- |
| 80 | 192.168.5.14:80 | validação do certificado e redirecionamento |
| 443 | 192.168.5.14:443 | todo o tráfego da aplicação |
| 25 | 192.168.5.14:25 | recebimento de e-mail e devoluções |
| 587 | 192.168.5.14:587 | envio a partir do seu cliente de e-mail |
| 993 | 192.168.5.14:993 | leitura da caixa (IMAP) |

As três últimas só fazem sentido porque há caixa de pessoa no domínio. Se o
servidor fosse só para o `noreply@` da aplicação, bastaria a 25.

Nada além disso. Em especial **não** abra 3306, 6379, 3550, 3551, nem a porta do
painel do aaPanel — o painel tem acesso root à máquina.

---

## 2.1 Se o reverse proxy estiver noutra máquina

`BIND_ADDRESS` no `.env` passa a ser o IP deste servidor na rede, e não
`127.0.0.1` — o loopback daqui não é alcançável de outro host.

Isso abre as portas 3550 e 3551 para a rede local inteira, e aí elas precisam
ser fechadas para todo mundo menos o proxy:

```bash
ufw allow from IP_DO_PROXY to any port 3550,3551 proto tcp
ufw deny 3550,3551/tcp
```

A ordem importa: o `ufw` aplica a primeira regra que casa, então a permissão
específica precisa vir antes da negação geral.

Sem essa restrição, qualquer máquina da rede fala direto com a API. Como ela
roda com `trustProxy: true` — necessário para ler o IP real que o proxy repassa
—, ela **acredita** no `X-Forwarded-For` que receber. Falando direto com a
porta, dá para inventar um IP diferente a cada tentativa e contornar todos os
tetos de senha errada.

## 3. Sites no aaPanel

Crie dois sites, ambos com SSL Let's Encrypt e reverse proxy:

| Site | Proxy para |
| --- | --- |
| `hub.prometheoncode.xyz` | `http://127.0.0.1:3550` |
| `api.prometheoncode.xyz` | `http://127.0.0.1:3551` |

Emita o certificado também para `smtp.prometheoncode.xyz` — o mailserver
reaproveita esse certificado por volume, em vez de disputar a validação com um
segundo Let's Encrypt para o mesmo host.

**Não ative cache em nenhum dos dois.** O aaPanel oferece o botão, e ligá-lo faz
o nginx guardar respostas autenticadas e servi-las a outra pessoa: alguém abre
`/v1/me` e recebe os dados de quem chamou antes.

---

## 4. Código e configuração no servidor

```bash
git clone <repositório> /opt/prometheon
cd /opt/prometheon/infrastructure/compose
cp .env.production.example .env
```

Gere os quatro segredos, cada um com valor próprio:

```bash
for k in AUTH_ACCESS_TOKEN_SECRET AUTH_REFRESH_TOKEN_SECRET \
         AUTH_REALTIME_TOKEN_SECRET SECRETS_MASTER_KEY; do
  echo "$k=$(openssl rand -base64 48)"
done
```

Preencha o resto do `.env`: senhas do MySQL e do Redis, credenciais do R2 e o
OAuth App **de produção** do GitHub.

```bash
chmod 600 .env
```

---

## 5. Subir

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

A ordem é garantida pelo próprio compose: MySQL sobe, as migrations rodam e só
então a API entra. Acompanhe a primeira subida:

```bash
docker compose -f docker-compose.prod.yml logs -f migrate api
```

Confira:

```bash
curl -s http://127.0.0.1:3551/v1/health/ready
curl -s https://api.prometheoncode.xyz/v1/health/ready
```

---

## 6. E-mail

Depois da primeira subida, crie as contas e gere a chave DKIM.

A conta que a aplicação usa para enviar, e as caixas de pessoas:

```bash
# Remetente da aplicação. Ninguém lê esta caixa.
docker compose -f docker-compose.prod.yml exec mailserver setup email add noreply@prometheoncode.xyz

# Caixa de pessoa — uma por integrante.
docker compose -f docker-compose.prod.yml exec mailserver setup email add mateus@prometheoncode.xyz

# `postmaster` é exigido pelas regras de e-mail e é para onde vão as
# devoluções. Como alias, ele cai numa caixa que alguém realmente abre.
docker compose -f docker-compose.prod.yml exec mailserver setup alias add postmaster@prometheoncode.xyz mateus@prometheoncode.xyz
docker compose -f docker-compose.prod.yml exec mailserver setup alias add abuse@prometheoncode.xyz mateus@prometheoncode.xyz

docker compose -f docker-compose.prod.yml exec mailserver setup config dkim
```

Cada `email add` pede a senha da caixa. Ela **não** é a mesma do Hub: é a
credencial do cliente de e-mail, e vive só aqui.

### Configurar o cliente

No Thunderbird, no celular ou onde for:

| Campo | Valor |
| --- | --- |
| Servidor de entrada | `smtp.prometheoncode.xyz`, porta **993**, SSL/TLS |
| Servidor de saída | `smtp.prometheoncode.xyz`, porta **587**, STARTTLS |
| Usuário | o endereço completo, `mateus@prometheoncode.xyz` |
| Senha | a que você definiu no `email add` |

O usuário é o endereço inteiro, não só `mateus` — é o erro mais comum na
primeira configuração.

A chave sai em `docker-data/dms/config/opendkim/keys/prometheoncode.xyz/mail.txt`.
Publique o conteúdo como TXT em `mail._domainkey`.

Ponha a senha da conta em `SMTP_PASSWORD` no `.env` e reinicie `api` e `worker`.

### Teste que vale

```bash
docker compose -f docker-compose.prod.yml exec api node -e "
  const {createTransport}=require('nodemailer');
  createTransport({host:'mailserver',port:587,secure:false,
    auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}})
   .sendMail({from:process.env.MAIL_FROM,to:'SEU_ENDERECO@gmail.com',
     subject:'Teste Prometheon',text:'Chegou.'})
   .then(i=>console.log('aceito:',i.messageId))
   .catch(e=>console.log('FALHA:',e.message));
"
```

Aceito pelo servidor não é o mesmo que entregue. Abra a mensagem no Gmail, use
"Mostrar original" e confira que SPF, DKIM e DMARC aparecem como `PASS`. É esse
o teste — não o "enviado com sucesso" do log.

### Se não chegar

Duas causas dominam, e nenhuma é bug: a porta 25 de saída bloqueada pelo
provedor, e o PTR reverso apontando para o nome do ISP em vez do seu domínio.

Nesse caso, use um relay: descomente as quatro linhas `RELAY_*` em
`infrastructure/mail/mailserver.env` com as credenciais de um serviço de envio. O servidor
continua sendo seu — recebe devoluções, assina com sua chave, usa seu domínio —
e a entrega sai por um remetente com reputação estabelecida. É o arranjo normal
para quem hospeda fora de datacenter, não um remendo.

---

## 6.5. Administrador da plataforma

Quem edita planos, atribui plano a uma organização e ajusta o teto de um cliente
precisa da marca de administrador da plataforma. Ela **não tem rota que a
escreva**: é concedida com acesso ao banco, no servidor.

```bash
docker compose -f docker-compose.prod.yml exec api \
  node packages/database/dist/grant-platform-admin.js voce@prometheoncode.xyz
```

Com a API fora do ar, o mesmo vale pelo serviço das migrations, que fala com o
banco pela rede interna:

```bash
docker compose -f docker-compose.prod.yml run --rm migrate \
  node packages/database/dist/grant-platform-admin.js voce@prometheoncode.xyz
```

Em desenvolvimento, direto do repositório:

```bash
pnpm --filter @prometheon/database db:grant-admin voce@exemplo.com
# e para tirar:
pnpm --filter @prometheon/database db:grant-admin voce@exemplo.com --revoke
```

A conta precisa existir antes — crie-a pelo cadastro normal do Hub. Feito isso,
a área `/admin` aparece no menu da conta.

A marca é lida do banco a cada requisição, e não do token: revogar tem efeito na
chamada seguinte, sem esperar sessão vencer.

---

## 7. Atualizar

```bash
cd /opt/prometheon
git pull
cd infrastructure/compose
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

As migrations rodam sozinhas antes da API subir.

---

## Backup

Três coisas, e a terceira é a mais fácil de esquecer:

```bash
# Banco
docker compose -f docker-compose.prod.yml exec -T mysql mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --routines "$DATABASE_NAME" | gzip > backup-$(date +%F).sql.gz
```

O **`.env`**, que guarda o `SECRETS_MASTER_KEY` — sem ele, as credenciais de
integração cifradas no banco não voltam, e um backup que não restaura não é
backup.

E as **chaves DKIM** em `docker-data/dms/config/opendkim/`: perdê-las obriga a
publicar um DNS novo e derruba a entrega até a propagação.

Guarde fora deste servidor. Backup que mora na máquina que pode queimar é
consolo, não seguro.
