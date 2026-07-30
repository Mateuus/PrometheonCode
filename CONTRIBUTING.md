# Contribuindo com o Prometheon

Obrigado pelo interesse no projeto. Este documento é a fonte da verdade sobre
**como o código entra no `main`**: o que é exigido, o que é automatizado e o que
faz um PR ser recusado.

Participar implica concordar com o [Código de Conduta](CODE_OF_CONDUCT.md).

---

## Índice

- [Antes de escrever código](#antes-de-escrever-código)
- [Preparando o ambiente](#preparando-o-ambiente)
- [Fluxo de trabalho](#fluxo-de-trabalho)
- [Nomenclatura de branches](#nomenclatura-de-branches)
- [Mensagens de commit](#mensagens-de-commit)
- [Regras de pull request](#regras-de-pull-request)
- [Checks automáticos](#checks-automáticos)
- [Revisão de código](#revisão-de-código)
- [Padrões de código](#padrões-de-código)
- [Testes](#testes)
- [Documentação e changelog](#documentação-e-changelog)
- [Regras de segurança para contribuidores](#regras-de-segurança-para-contribuidores)
- [Dependências](#dependências)
- [Release](#release)

---

## Antes de escrever código

| Situação | O que fazer |
| --- | --- |
| Correção pequena, óbvia, isolada | Abra o PR direto. |
| Nova funcionalidade | Abra uma **issue** de proposta antes. Alinhe escopo e desenho primeiro. |
| Mudança de arquitetura, contrato HTTP ou formato de `.prometheon/` | Abra issue com a label `design` e aguarde decisão antes de implementar. |
| Bug com reprodução | Abra issue usando o template de bug, mesmo que você mesmo vá corrigir. |

Trabalho não alinhado que chega como PR grande costuma ser recusado por escopo,
não por qualidade. Alinhar antes economiza o seu tempo.

---

## Preparando o ambiente

Requisitos: Node 20+, npm 10+, Git 2.40+, VS Code 1.105+.

```bash
git clone https://github.com/Mateuus/PrometheonCode.git
cd PrometheonCode
npm run install:all
npm run doctor      # confirma que o ambiente está completo
npm run compile
```

Rodar a extensão: abra **a raiz do repositório** no VS Code e pressione
<kbd>F5</kbd> (configuração *Executar extensão*).

Este monorepo **não usa npm workspaces** de propósito — o hoisting quebra o
empacotamento do `vsce`. Cada pacote tem seu `package.json` e seu
`node_modules`. Não adicione workspaces.

---

## Fluxo de trabalho

```bash
git switch main
git pull --ff-only
git switch -c feat/seletor-de-autonomia

# ... implemente + testes ...

npm run verify          # check-types + lint + test — o mesmo que o CI roda
git commit -m "feat(extension): adiciona seletor de autonomia"
git push -u origin feat/seletor-de-autonomia
gh pr create --fill     # ou abra pela interface do GitHub
```

Não faça commit direto em `main` — a branch é protegida. Não use `merge commit`
para trazer `main` para a sua branch; use `git pull --rebase origin main` para
manter o histórico linear.

---

## Nomenclatura de branches

```
<tipo>/<descricao-curta-em-kebab-case>
```

Tipos aceitos: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`,
`build`, `ci`, `revert`.

```
feat/local-chat-streaming
fix/timeout-do-cliente-http
docs/regras-de-pull-request
chore/bump-esbuild
```

---

## Mensagens de commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/):

```
<tipo>(<escopo opcional>): <assunto no imperativo>

<corpo opcional explicando o porquê, não o quê>

<rodapé opcional: BREAKING CHANGE, Refs #123, Closes #456>
```

Escopos usados no projeto: `extension`, `server`, `webview`, `agents`, `chat`,
`permissions`, `workspace`, `hub`, `docs`, `ci`, `deps`, `release`.

```
feat(chat): persiste conversa local no workspaceState
fix(agents): trata status desconhecido como offline
docs(readme): documenta instalação das CLIs de agente
ci: roda testes de integração no Windows
```

Regras:

- assunto no **imperativo**, sem ponto final, até 72 caracteres;
- **breaking change** exige `!` após o tipo (`feat(hub)!: ...`) **e** rodapé
  `BREAKING CHANGE: <explicação>`;
- um commit deve compilar e passar nos testes por conta própria — se você
  precisar de commits intermediários quebrados, faça squash antes de abrir o PR.

O **título do PR** também segue esse formato — ele é validado pelo CI e é o que
vira a mensagem do squash merge.

---

## Regras de pull request

### Obrigatório

1. **Um assunto por PR.** Refatoração + feature + correção de lint no mesmo PR
   será devolvido para divisão.
2. **Título em Conventional Commits.** Validado automaticamente.
3. **Descrição preenchida** conforme o
   [template de PR](.github/PULL_REQUEST_TEMPLATE.md): o que muda, por quê, como
   testar, riscos.
4. **`npm run verify` passando localmente** antes do push.
5. **Testes para o comportamento novo ou corrigido.** Bug corrigido sem teste de
   regressão não é mesclado.
6. **Changelog atualizado** (`extension/CHANGELOG.md`) quando houver mudança em
   `extension/src/**`. Para PRs que genuinamente não afetam o usuário, aplique a
   label `skip-changelog`.
7. **Documentação atualizada** quando o PR muda configuração, comando, contrato
   HTTP ou passo de instalação.
8. **Nenhum segredo, credencial, token, cookie ou dado pessoal** no diff.
9. **Nenhum artefato de build comitado** (`dist/`, `out/`, `*.vsix`,
   `node_modules/`, `.vscode-test/`).
10. **`draft` enquanto estiver em progresso.** Marque como *Ready for review*
    apenas quando estiver realmente pronto.

### Tamanho

| Linhas alteradas | Tratamento |
| --- | --- |
| ≤ 200 | Ideal |
| 201 – 600 | Aceitável, justifique na descrição |
| > 600 | O CI avisa; espere pedido de divisão salvo se for mudança mecânica (rename em massa, lockfile, geração de código) |

Arquivos gerados e lockfiles não contam para esse limite — mas devem estar em
**commits separados** dos alterados à mão.

### Recusa automática

Um PR é recusado (ou devolvido) quando:

- altera contrato HTTP sem atualizar a tabela no README e sem a label
  `breaking-change`;
- introduz execução de comando derivada de texto não validado da Webview;
- grava segredo em arquivo, log ou `.prometheon/`;
- adiciona telemetria;
- persiste `Bypass permissions` além da sessão;
- adiciona dependência de runtime sem justificativa na descrição;
- copia ícones, marcas ou código proprietário de terceiros.

---

## Checks automáticos

Todo PR passa por estes jobs. Nenhum merge com check vermelho.

| Check | Workflow | O que reprova |
| --- | --- | --- |
| `Lint & Types` | `ci.yml` | Erro de ESLint, de `tsc --noEmit` ou manifest inválido |
| `Test (ubuntu-latest)` | `ci.yml` | Teste de integração falhando no Linux (VS Code headless via `xvfb`) |
| `Test (windows-latest)` | `ci.yml` | Teste de integração falhando no Windows |
| `Test (macOS, informativo)` | `ci.yml` | Nada — reporta regressões sem bloquear |
| `Audit` | `ci.yml` | Vulnerabilidade alta em dependência de **runtime** (devDeps só avisam) |
| `Build VSIX` | `ci.yml` | Falha ao empacotar a extensão |
| `CI Passed` | `ci.yml` | Agregador: falha se qualquer job acima falhar |
| `PR Title` | `pr-validation.yml` | Título fora do Conventional Commits |
| `PR Body` | `pr-validation.yml` | Descrição vazia/curta ou checklist não preenchido |
| `PR Size` | `pr-validation.yml` | Aviso acima de 600 linhas |
| `Changelog` | `pr-validation.yml` | `extension/src/**` alterado sem changelog nem label `skip-changelog` |
| `Secret Scan` | `pr-validation.yml` | Padrão de credencial no diff |
| `Forbidden Files` | `pr-validation.yml` | Artefato de build, `.env` ou lockfile incoerente |
| `PR Checks Passed` | `pr-validation.yml` | Agregador das validações de PR |
| `CodeQL` | `codeql.yml` | Vulnerabilidade de severidade alta |

Rodar as validações de PR localmente, antes do push:

```bash
npm run check-manifest    # mesmas regras do job Lint & Types
npm run scan:secrets      # mesma varredura do job Secret Scan
```

Para reproduzir localmente o que o CI faz:

```bash
npm run ci:install
npm run verify
npm run vsix
```

---

## Revisão de código

- **1 aprovação** mínima, de um Code Owner (veja
  [.github/CODEOWNERS](.github/CODEOWNERS)).
- Toda conversa precisa estar **resolvida** antes do merge.
- Estratégia de merge: **squash and merge**. O histórico do `main` é linear.
- Reviews expiram quando você faz push novo — peça re-review após mudanças
  substanciais.
- O que o revisor procura, em ordem: correção → segurança → aderência à
  arquitetura → testes → clareza → estilo.

Como autor: responda a todo comentário, mesmo que só com "feito". Como revisor:
seja específico e aponte o caminho, não apenas o problema.

---

## Padrões de código

- **TypeScript estrito.** Sem `any` implícito, sem `@ts-ignore` sem comentário
  explicando o porquê e sem `!` de non-null assertion em código novo.
- **Erros tipados.** Classes de erro nomeadas (`HubNotConfiguredError`), não
  strings soltas.
- **Validação em runtime** de tudo que atravessa fronteira: mensagens da
  Webview, respostas HTTP, conteúdo de `.prometheon/prometheon.yaml`. TypeScript
  não protege em runtime.
- **Sem framework de UI** na Webview nesta fase. HTML, CSS e TS puros, bundle
  pequeno.
- **Cores por variável de tema** do VS Code (`var(--vscode-editor-background)`).
  Nunca cor fixa que quebre tema claro.
- **CSP rigorosa** na Webview: script apenas com `nonce`, sem `unsafe-inline`,
  sem recurso remoto, sem `innerHTML` com conteúdo de mensagem.
- **Escreva no idioma do arquivo.** O código, os identificadores e as APIs ficam
  em inglês; a UI, a documentação e os comentários deste repositório ficam em
  português. Siga o padrão do arquivo que você está editando.
- **Sem `console.log`.** Use o `Logger` da extensão, com log sanitizado.
- Formatação segue o [.editorconfig](.editorconfig) e o ESLint. Não reformate
  arquivos inteiros junto com uma mudança funcional — isso torna o diff
  irrevisável.

---

## Testes

```bash
npm test               # suíte completa no Extension Host
npm run compile-tests  # apenas transpila os testes
```

Os testes de integração rodam dentro de um VS Code real. Em Linux sem display,
use `xvfb-run -a npm test` (é o que o CI faz).

Escreva teste para:

- todo bug corrigido (teste de regressão que falha antes da correção);
- toda validação de entrada;
- todo caminho de erro relevante, não só o caminho felizmente feliz;
- toda regra de permissão ou de persistência.

Áreas com cobertura obrigatória, definidas no plano de implementação:

1. registro e seleção de adaptadores de agente;
2. transição entre Local Chat e Web Chat;
3. `WebChatService` retornando `HubNotConfiguredError`;
4. persistência de Work Mode e Autonomy;
5. `Bypass permissions` **não** persistindo após reinicialização;
6. criação segura da estrutura `.prometheon/`;
7. preservação do conteúdo existente do `.gitignore`;
8. validação das mensagens recebidas da Webview;
9. precedência de políticas no `PermissionService`.

Teste que depende de rede externa, de conta real ou de CLI de terceiro instalada
não entra na suíte — use adaptador simulado (`MockAgentAdapter`).

---

## Documentação e changelog

`extension/CHANGELOG.md` segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Adicione sua entrada em **`## [Não publicado]`**, na seção correta
(`Adicionado`, `Alterado`, `Corrigido`, `Removido`, `Segurança`, `Depreciado`):

```markdown
## [Não publicado]

### Adicionado

- Seletor de nível de autonomia na barra inferior do chat.
```

Escreva a entrada para quem **usa** a extensão, não para quem leu o diff.

Atualize também, quando aplicável: `README.md` (instalação, scripts,
configurações, contrato HTTP), `extension/README.md` (detalhes da extensão) e
`Docs/` (arquitetura e decisões).

---

## Regras de segurança para contribuidores

- **Nunca** comite chave, token, cookie, `.env` preenchido, dump de banco ou log
  com dado real.
- Se você expôs um segredo acidentalmente: **rotacione o segredo primeiro**,
  depois avise em [SECURITY.md](SECURITY.md). Remover o commit não é suficiente —
  ele já foi distribuído.
- Nenhum comando de terminal, chamada de Git ou leitura de arquivo pode ser
  derivada diretamente de string vinda da Webview.
- Segredos vivem só em `vscode.SecretStorage`. Nunca em `.prometheon/`, nunca em
  `globalState`, nunca em log.
- Hub remoto exige `https://`; `http://` só para `localhost` / `127.0.0.1`.
- Git só é inicializado após confirmação explícita do usuário.
- Sem telemetria. Sem coleta de dados. Sem "analytics anônimo".

Encontrou vulnerabilidade? **Não abra issue pública.** Siga o
[SECURITY.md](SECURITY.md).

---

## Dependências

- Dependência de **runtime** exige justificativa explícita na descrição do PR:
  por que não dá para resolver com a API do Node ou do VS Code, e qual o impacto
  no tamanho do bundle.
- Dependência de **desenvolvimento** é mais livre, mas prefira o que já existe
  no projeto.
- Não adicione dependência para função trivial.
- Não altere `package-lock.json` sem alterar `package.json` no mesmo PR. Bumps
  automáticos são responsabilidade do Dependabot.
- Verifique licença: só MIT, Apache-2.0, BSD ou ISC. Copyleft forte (GPL/AGPL)
  não entra.

---

## Release

Mantenedores fazem o release. O procedimento está na seção
[Releases e versionamento](README.md#releases-e-versionamento) do README.

---

Dúvida que este documento não responde? Abra uma
[discussão](https://github.com/Mateuus/PrometheonCode/discussions) ou uma issue com a
label `question`.
