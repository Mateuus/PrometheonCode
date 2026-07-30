<div align="center">

<img src="extension/media/prometheon.svg" alt="Prometheon" width="96" height="96" />

# Prometheon

**One workspace. Every agent.**

Orquestração de múltiplos agentes de IA de codificação dentro de um único workspace do VS Code.

[![CI](https://github.com/Mateuus/PrometheonCode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Mateuus/PrometheonCode/actions/workflows/ci.yml)
[![PR Validation](https://github.com/Mateuus/PrometheonCode/actions/workflows/pr-validation.yml/badge.svg)](https://github.com/Mateuus/PrometheonCode/actions/workflows/pr-validation.yml)
[![CodeQL](https://github.com/Mateuus/PrometheonCode/actions/workflows/codeql.yml/badge.svg)](https://github.com/Mateuus/PrometheonCode/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.105-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com)

</div>

---

## Índice

- [O que é o Prometheon](#o-que-é-o-prometheon)
- [Status do projeto](#status-do-projeto)
- [Arquitetura do repositório](#arquitetura-do-repositório)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
  - [1. Dependências do repositório](#1-dependências-do-repositório)
  - [2. CLIs de agentes de IA](#2-clis-de-agentes-de-ia)
  - [3. Graphify e camada de conhecimento](#3-graphify-e-camada-de-conhecimento)
  - [4. Verificação do ambiente](#4-verificação-do-ambiente)
- [Executando em desenvolvimento](#executando-em-desenvolvimento)
- [Scripts disponíveis](#scripts-disponíveis)
- [Configurações da extensão](#configurações-da-extensão)
- [Contrato extensão ↔ servidor](#contrato-extensão--servidor)
- [Qualidade, CI e automação de pull request](#qualidade-ci-e-automação-de-pull-request)
- [Como contribuir](#como-contribuir)
- [Segurança](#segurança)
- [Releases e versionamento](#releases-e-versionamento)
- [Licença](#licença)

---

## O que é o Prometheon

O Prometheon é uma extensão do VS Code que coordena vários agentes de IA de
codificação a partir de um único lugar. Em vez de alternar entre terminais,
contas e ferramentas, você define um **Main Agent**, um **modo de trabalho** e um
**nível de autonomia** — e a malha distribui o trabalho.

Pilares do produto:

| Pilar | Descrição |
| --- | --- |
| **Orquestração multiagente** | Um agente principal delega tarefas a workers (Claude Code, Codex CLI, Gemini CLI, Kimi Code). |
| **Isolamento por worktree** | Cada agente trabalha em seu próprio Git worktree, sem conflitar com o seu checkout. |
| **Permissões explícitas** | Três níveis de autonomia (`Manual`, `Auto`, `Bypass permissions`), com escopo e duração controlados. |
| **Conhecimento versionado** | Base em Markdown/Obsidian dentro de `.prometheon/`, opcionalmente indexada por grafo. |
| **Hub opcional** | Servidor próprio para Web Chat, times e memória compartilhada. Quem trabalha sozinho não precisa dele. |

> **Privacidade por padrão:** nenhuma telemetria. O Local Chat nunca envia dados
> a um servidor. Segredos vivem exclusivamente no `vscode.SecretStorage`, nunca em
> arquivos do repositório.

---

## Status do projeto

O projeto está em **estágio inicial (`0.0.x`, pré-alfa)**. A API interna, os
contratos HTTP e o formato de `.prometheon/prometheon.yaml` podem mudar sem aviso
entre versões `0.x`.

| Área | Estado |
| --- | --- |
| Extensão do VS Code (painel, status bar, comandos) | ✅ Funcional |
| Cliente HTTP do servidor (`/health`, `/agents`) | ✅ Funcional |
| Servidor Prometheon (`server/`) | 🚧 Não iniciado |
| Chat local com streaming | 🚧 Em desenvolvimento |
| Adaptadores reais de CLI (Claude/Codex/Gemini/Kimi) | 🚧 Planejado |
| Git worktrees por agente | 🚧 Planejado |
| Graphify / grafo de conhecimento | 🚧 Planejado |
| Prometheon Hub (Web Chat, times) | 🚧 Planejado |

O plano de implementação detalhado da primeira etapa está em
[Docs/PROMETHEON_INICIO_EXTENSAO.md](Docs/PROMETHEON_INICIO_EXTENSAO.md).

---

## Arquitetura do repositório

Monorepo **sem npm workspaces** — cada pacote tem seu próprio `package.json` e
seu próprio `node_modules`. Isso é intencional: o empacotamento de extensões do
VS Code (`vsce`) sofre com o hoisting de dependências dos workspaces.

```
Prometheon/
├─ .github/            workflows, templates de issue/PR, CODEOWNERS
├─ Docs/               documentação de arquitetura e planos de implementação
├─ extension/          extensão do VS Code (cliente) — TypeScript + esbuild
│  ├─ src/             código-fonte
│  ├─ media/           ícones originais
│  └─ package.json     manifest da extensão
├─ scripts/            utilitários do monorepo (doctor, automações)
├─ server/             servidor Prometheon — ainda não criado
├─ .vscode/            tasks, launch e recomendações do monorepo
└─ package.json        orquestrador de scripts da raiz (privado, não publicado)
```

Regra arquitetural que vale para todo o código: **a Webview nunca executa nada
diretamente.** Ela envia mensagens tipadas e validadas em runtime; o núcleo da
extensão decide se e como executar terminal, Git, CLI, arquivos ou rede.

---

## Requisitos

| Ferramenta | Versão mínima | Obrigatório | Observações |
| --- | --- | --- | --- |
| [Node.js](https://nodejs.org) | 20 LTS | ✅ | Testado em 20 e 22. |
| npm | 10 | ✅ | Acompanha o Node 20+. |
| [Git](https://git-scm.com) | 2.40 | ✅ | Necessário para worktrees. |
| [VS Code](https://code.visualstudio.com) | 1.105 | ✅ | Ou VS Code Insiders. |
| CLIs de agentes | — | ⚪ Opcional | Veja [CLIs de agentes de IA](#2-clis-de-agentes-de-ia). |
| Graphify | — | ⚪ Opcional | Veja [Graphify](#3-graphify-e-camada-de-conhecimento). |

Sistemas suportados: Windows 11, macOS 13+, Linux (glibc 2.31+).

---

## Instalação

### 1. Dependências do repositório

```bash
git clone https://github.com/Mateuus/PrometheonCode.git
cd PrometheonCode
npm run install:all      # instala as dependências de todos os pacotes
npm run compile          # gera extension/dist/extension.js
```

Em ambientes de CI ou quando você quer uma instalação reprodutível a partir do
lockfile, use:

```bash
npm run ci:install       # npm ci em cada pacote — não altera o package-lock.json
```

> **Nunca** comite alterações de `package-lock.json` que não sejam consequência
> direta do seu PR. Se o lockfile mudar sem que você tenha tocado nas
> dependências, reverta-o.

### 2. CLIs de agentes de IA

O Prometheon **não empacota** nenhum modelo ou CLI de terceiros. Os agentes reais
são processos externos que você instala e autentica separadamente, com sua
própria conta e sua própria cota. A extensão funciona sem nenhum deles — nesse
caso apenas o adaptador simulado (`Mock Agent`) fica disponível.

Instale os que você pretende usar:

```bash
# Claude Code (Anthropic)
npm install -g @anthropic-ai/claude-code
claude --version

# Codex CLI (OpenAI)
npm install -g @openai/codex
codex --version

# Gemini CLI (Google)
npm install -g @google/gemini-cli
gemini --version
```

**Kimi Code (Moonshot AI)** ainda não tem um pacote npm fixado neste repositório.
Instale seguindo a documentação oficial do fornecedor e garanta que o binário
fique no `PATH` — o adaptador procura por um executável chamado `kimi`.

Autenticação: faça login em cada CLI **fora do Prometheon**, com o fluxo oficial
da ferramenta (`claude`, `codex`, `gemini` interativos). O Prometheon reaproveita
a sessão já autenticada da CLI e **não lê, copia nem armazena** suas credenciais.
Se você preferir chaves de API, guarde-as via *Prometheon: Open Settings* → cofre
de segredos; elas vão para o `SecretStorage` do VS Code.

> ⚠️ Nunca coloque chaves, tokens ou cookies em `.prometheon/`, em variáveis
> comitadas, em `.env` versionado ou em qualquer arquivo do repositório. O CI
> falha o PR quando detecta padrões de credencial no diff.

### 3. Graphify e camada de conhecimento

O Graphify é a camada **opcional** de grafo de conhecimento. Ele é uma CLI
independente (não é pacote npm deste repositório): mapeia o código e a base de
conhecimento em um grafo `graphify-out/graph.json` e se integra a agentes de
codificação instalando uma *skill* e hooks na plataforma escolhida.

```bash
graphify --version                    # confirma que está no PATH
graphify install --platform claude    # instala a skill + PreToolUse hook
graphify path "A" "B"                 # menor caminho entre dois nós do grafo
graphify explain "X"                  # explicação de um nó e seus vizinhos
graphify diagnose multigraph          # diagnóstico do grafo gerado
```

A saída `graphify-out/` é local e já está no [.gitignore](.gitignore) — não
versione o grafo gerado.

Estado da integração **dentro da extensão**: planejada, ainda não implementada.
Nenhuma versão do Graphify está fixada como dependência; até a integração entrar,
`graphify.enabled` permanece `false` e a base de conhecimento funciona como
Markdown puro, compatível com Obsidian:

```yaml
# .prometheon/prometheon.yaml
knowledge:
  graphify:
    enabled: false
  obsidian:
    enabled: true
    paths:
      - ".prometheon/knowledge"
```

Se você já tem o Graphify instalado localmente, deixe o executável `graphify`
disponível no `PATH` — o script `npm run doctor` o detecta e reporta a versão.

### 4. Verificação do ambiente

```bash
npm run doctor
```

O `doctor` verifica, sem instalar nada e sem tocar em credenciais:

- versões de Node, npm, Git e do VS Code CLI;
- quais CLIs de agente estão no `PATH` e em qual versão;
- presença do Graphify;
- se as dependências do repositório estão instaladas;
- se `extension/dist/` foi gerado.

Ele termina com código de saída `0` quando todos os itens **obrigatórios** estão
presentes — itens opcionais ausentes geram apenas aviso. Use `npm run doctor --
--json` para saída legível por máquina.

---

## Executando em desenvolvimento

1. Abra **a raiz do repositório** no VS Code (não a pasta `extension/`).
2. Pressione <kbd>F5</kbd> e escolha a configuração **Executar extensão**.
3. O VS Code inicia a task `watch` e abre uma janela *Extension Development Host*
   com o Prometheon carregado.
4. Clique no ícone do Prometheon na Activity Bar para abrir o painel.

Recarregar após uma mudança: <kbd>Ctrl</kbd>+<kbd>R</kbd> (macOS:
<kbd>Cmd</kbd>+<kbd>R</kbd>) na janela do Extension Development Host.

Empacotar um `.vsix` instalável:

```bash
npm run vsix                                   # gera dist/prometheon-<versão>.vsix
code --install-extension dist/prometheon-0.0.1.vsix
```

Logs: canal de saída **Prometheon**. Para ver mensagens `debug`, use
*Developer: Set Log Level…* e escolha `Debug` para a extensão.

---

## Scripts disponíveis

Todos rodam a partir da raiz do repositório.

| Script | O que faz |
| --- | --- |
| `npm run install:all` | Instala as dependências de todos os pacotes |
| `npm run ci:install` | `npm ci` em todos os pacotes (reprodutível, para CI) |
| `npm run doctor` | Diagnostica o ambiente de desenvolvimento |
| `npm run compile` | Build único da extensão |
| `npm run watch` | Build incremental da extensão |
| `npm run check-types` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint com correção automática |
| `npm test` | Testes de integração no Extension Host |
| `npm run verify` | `check-types` + `lint` + `test` — rode antes de abrir um PR |
| `npm run vsix` | Empacota o `.vsix` em `dist/` |

`npm run verify` é exatamente o conjunto que o CI executa. Se ele passa
localmente, o PR passa no CI.

---

## Comandos e configurações

### Comandos (paleta, prefixo `Prometheon:`)

| Comando | ID | O que faz |
| --- | --- | --- |
| Open Chat | `prometheon.openChat` | Abre o painel do Prometheon |
| New Local Chat | `prometheon.newLocalChat` | Inicia uma conversa local vazia |
| Configure Workspace | `prometheon.configureWorkspace` | Abre a configuração do workspace |
| Initialize Workspace | `prometheon.initializeWorkspace` | Cria a estrutura `.prometheon/` |
| Select Main Agent | `prometheon.selectMainAgent` | Escolhe o agente principal |
| Select Work Mode | `prometheon.selectWorkMode` | Alterna entre `Plan`, `Edit` e `Agent Team` |
| Select Autonomy | `prometheon.selectAutonomy` | Alterna entre `Manual`, `Auto` e `Bypass permissions` |
| Disable Bypass Permissions | `prometheon.disableBypassPermissions` | Revoga o bypass ativo imediatamente |
| Open Settings | `prometheon.openSettings` | Abre as configurações do Prometheon |
| Show Diagnostics | `prometheon.showDiagnostics` | Relatório do estado atual, sem dados sensíveis |

### Configurações

| Configuração | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `prometheon.hub.url` | `string` | `""` | URL base do Prometheon Hub. Vazio = somente local |
| `prometheon.chat.defaultType` | `local` \| `web` | `local` | Tipo de chat aberto por padrão |
| `prometheon.workspace.promptOnOpen` | `boolean` | `true` | Mostrar a tela de configuração quando a pasta não tem `.prometheon/prometheon.yaml` |

Para Hub remoto, apenas `https://` é aceito — `http://` é permitido somente em
`localhost` / `127.0.0.1`. **Tokens não vão para as configurações**: eles ficam
no cofre de segredos do VS Code.

---

## Configuração do workspace

A configuração compartilhável do projeto vive em `.prometheon/prometheon.yaml` e
**pode ser versionada** — ela não contém segredos:

```yaml
version: 1
workspace:
  name: "My Project"

chat:
  defaultType: local

orchestration:
  workMode: plan          # plan | edit | agent-team
  autonomy: manual        # manual | auto  (bypass nunca é persistido)
  mainAgent: mock
  maxWorkers: 3

knowledge:
  graphify:
    enabled: false
  obsidian:
    enabled: true
    paths:
      - ".prometheon/knowledge"

hub:
  enabled: false
```

O que **não** é versionado (já coberto pelo [.gitignore](.gitignore)):
`.prometheon/local/`, `cache/`, `runtime/`, `logs/`, `worktrees/`,
`sessions/raw/`, `graph/cache/`, `secrets/` e bancos `*.db`.

Camadas de persistência, por sensibilidade:

| Camada | Onde | Conteúdo |
| --- | --- | --- |
| Compartilhável | `.prometheon/prometheon.yaml` | Modo padrão, agente principal, limites, políticas do projeto |
| Local | `globalState` / `workspaceState` / `.prometheon/local/` | Conversa local, estado de interface, cache |
| Secreta | `vscode.SecretStorage` | Chaves de API, tokens, credenciais |

---

## Contrato com o Prometheon Hub

O Hub é **opcional** e ainda não foi implementado (`server/` está vazio, a
extensão usa `DisabledHubClient`). A extensão fala apenas HTTPS/WebSocket com a
API do Hub — nunca diretamente com banco de dados.

Arquitetura prevista do servidor:

```
Prometheon Hub
├── API HTTP        organizações, projetos, conversas, tarefas, auditoria
├── WebSocket       presença, eventos em tempo real, fan-out
├── MySQL           fonte de verdade relacional
└── Redis           presença, filas, locks, rate limiting, cache
```

Contrato mínimo previsto:

| Rota | Método | Resposta |
| --- | --- | --- |
| `/health` | `GET` | `200` quando o Hub está de pé |
| `/agents` | `GET` | `{ "agents": [{ "id", "name", "status", "description?" }] }` |

`status` aceita `idle`, `busy`, `error` ou `offline`. Qualquer outro valor é
tratado como `offline` pelo cliente — o Hub pode evoluir sem quebrar versões
antigas da extensão.

**Mudanças de contrato são breaking changes.** Toda alteração nessas rotas exige:
atualização desta tabela, entrada no `CHANGELOG.md` e a label `breaking-change`
no PR.

---

## Qualidade, CI e automação de pull request

Todo push e todo pull request passam pelos mesmos gates. Nenhum PR é mesclado com
check vermelho.

### Workflows

| Workflow | Gatilho | O que faz |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push em `main`, PR | Lint, tipos, validação do manifest, auditoria de dependências, testes em Linux/Windows (macOS informativo), build do `.vsix` |
| [`pr-validation.yml`](.github/workflows/pr-validation.yml) | PR aberto/atualizado | Título semântico, descrição e checklist, tamanho do PR, changelog, varredura de segredos, arquivos proibidos, labels automáticas |
| [`codeql.yml`](.github/workflows/codeql.yml) | push, PR, semanal | Análise estática de segurança (`security-extended`) |
| [`release.yml`](.github/workflows/release.yml) | tag `v*.*.*` | Verificação completa, `.vsix` + SHA-256, GitHub Release, publicação opcional no Marketplace |
| [`stale.yml`](.github/workflows/stale.yml) | diário | Marca e fecha issues/PRs sem atividade |

Cada workflow termina em um job agregador — `CI Passed` e `PR Checks Passed` —
que falha se qualquer job dele falhar. Isso mantém a branch protection estável
mesmo quando novos jobs são adicionados.

### Checks obrigatórios (branch protection de `main`)

Configure em *Settings → Branches → Branch protection rules* para `main`:

- ✅ Require a pull request before merging (**1 aprovação mínima**)
- ✅ Require review from Code Owners
- ✅ Require status checks to pass:
  - `CI Passed`
  - `PR Checks Passed`
  - `CodeQL`
- ✅ Require branches to be up to date before merging
- ✅ Require conversation resolution before merging
- ✅ Require linear history (merge por **squash**)
- ✅ Require signed commits (recomendado)
- ❌ Allow force pushes / deletions — desabilitados
- ✅ Do not allow bypassing the above settings

Labels usadas pela automação — crie-as antes de habilitar os workflows:
`skip-changelog`, `breaking-change`, `dependencies`, `ci`, `extension`,
`server`, `webview`, `permissions`, `documentation`, `build`, `tests`, `config`,
`stale`, `bug`, `enhancement`, `triage`, `design`, `security`.

### Testes automáticos de pull request

O `ci.yml` executa a suíte de integração da extensão em um VS Code real e
headless (via `xvfb` no Linux). Isso significa que testes que dependem da API do
VS Code rodam de verdade no CI, não em mock.

Ao adicionar código, adicione o teste correspondente. Áreas com cobertura
obrigatória:

- registro e seleção de adaptadores de agente;
- transição entre Local Chat e Web Chat;
- erros tipados (por exemplo `HubNotConfiguredError`);
- persistência de preferências (e a **não** persistência do Bypass);
- criação da estrutura `.prometheon/` preservando conteúdo existente;
- validação em runtime de toda mensagem vinda da Webview;
- precedência de políticas no `PermissionService`.

---

## Como contribuir

Leia o [CONTRIBUTING.md](CONTRIBUTING.md) antes do primeiro PR. Em resumo:

```bash
git checkout -b feat/nome-curto-da-mudanca
# ... suas alterações ...
npm run verify
git commit -m "feat(extension): descreve a mudança no imperativo"
git push -u origin feat/nome-curto-da-mudanca
```

Regras que o CI aplica automaticamente:

- **Título do PR** em [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/):
  `feat(extension): adiciona seletor de autonomia`.
- **Um assunto por PR.** PRs acima de ~600 linhas alteradas recebem aviso e
  podem ser recusados para divisão.
- **Changelog obrigatório** quando `extension/src/**` muda — a menos que o PR
  tenha a label `skip-changelog`.
- **Zero segredos** no diff.
- **Checklist do template de PR** preenchido.

Participar do projeto implica concordar com o
[Código de Conduta](CODE_OF_CONDUCT.md).

---

## Segurança

Não abra issue pública para vulnerabilidades. O processo de divulgação
responsável, o escopo e os prazos de resposta estão em
[SECURITY.md](SECURITY.md).

Garantias de segurança do design atual:

- CSP rigorosa na Webview: scripts apenas com `nonce`, sem `unsafe-inline`, sem
  carregamento remoto;
- nenhum comando de terminal derivado diretamente de texto da Webview;
- segredos somente em `vscode.SecretStorage`, nunca em disco no projeto;
- `Bypass permissions` exige confirmação explícita, tem escopo e duração e
  **expira** ao reiniciar a extensão ou trocar de workspace;
- Git só é inicializado após confirmação do usuário;
- logs sanitizados, sem telemetria.

---

## Releases e versionamento

O projeto segue [SemVer](https://semver.org/lang/pt-BR/). Enquanto estivermos em
`0.x`, mudanças incompatíveis podem sair em versões `minor`.

Fluxo de release:

1. Atualize `extension/CHANGELOG.md` movendo os itens de *Não publicado* para a
   nova versão.
2. Ajuste a `version` em `extension/package.json`.
3. Abra o PR de release (`chore(release): v0.1.0`) e faça o merge.
4. Crie a tag: `git tag v0.1.0 && git push origin v0.1.0`.
5. O `release.yml` roda a verificação completa, gera o `.vsix`, publica o GitHub
   Release e — se o segredo `VSCE_PAT` estiver configurado — publica no
   Marketplace.

Antes do primeiro release público, troque o campo `publisher` em
`extension/package.json` (hoje `prometheon`) pelo ID real do publisher no
Marketplace. O ID usado nos testes e no comando de abrir configurações precisa
acompanhar essa mudança.

---

## Licença

[MIT](LICENSE) © Mateus Rodrigues

Prometheon não é afiliado a Anthropic, OpenAI, Google, Moonshot AI ou Microsoft.
Nomes de produtos e marcas de terceiros pertencem aos seus respectivos donos e
são citados apenas para identificar interoperabilidade.
