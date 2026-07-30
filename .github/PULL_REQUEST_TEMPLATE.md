<!--
Título do PR em Conventional Commits — é validado pelo CI e vira a mensagem do
squash merge. Exemplo: feat(chat): persiste conversa local no workspaceState
-->

## O que muda

<!-- Descreva a mudança em 1–3 frases, do ponto de vista de quem usa. -->

## Por que

<!-- Problema, motivação ou decisão de produto. Link para a issue: Closes #123 -->

Closes #

## Tipo de mudança

- [ ] `feat` — nova funcionalidade
- [ ] `fix` — correção de bug
- [ ] `docs` — apenas documentação
- [ ] `refactor` — sem mudança de comportamento
- [ ] `perf` — desempenho
- [ ] `test` — apenas testes
- [ ] `build` / `ci` / `chore` — infraestrutura
- [ ] **breaking change** (adicione a label `breaking-change` e descreva a migração abaixo)

## Como testar

<!-- Passos exatos para o revisor reproduzir. Inclua o que observar. -->

1. `npm run install:all && npm run compile`
2. `F5` na raiz → Extension Development Host
3. ...

## Checklist

- [ ] `npm run verify` passa localmente (`check-types` + `lint` + `test`)
- [ ] Adicionei ou atualizei testes cobrindo a mudança (regressão, se for bug)
- [ ] Atualizei `extension/CHANGELOG.md` em `## [Não publicado]` (ou apliquei a label `skip-changelog`)
- [ ] Atualizei a documentação afetada (`README.md`, `extension/README.md`, `Docs/`)
- [ ] O PR trata de **um único assunto**
- [ ] Não há artefato de build no diff (`dist/`, `out/`, `*.vsix`, `node_modules/`)
- [ ] Não há segredo, token, chave, cookie ou dado pessoal no diff
- [ ] `package-lock.json` só mudou se `package.json` também mudou

## Segurança

- [ ] Nenhum comando de terminal, Git ou CLI é derivado de texto não validado da Webview
- [ ] Nenhum segredo é gravado em disco, em log ou em `.prometheon/`
- [ ] Toda mensagem nova entre Webview e extensão tem validação em runtime
- [ ] A CSP da Webview continua sem `unsafe-inline` e sem recurso remoto
- [ ] Nenhuma telemetria foi adicionada
- [ ] `Bypass permissions` continua limitado à sessão e ao escopo escolhido
- [ ] Não se aplica a este PR

## Impacto no contrato

- [ ] Não altera contrato HTTP nem o formato de `.prometheon/prometheon.yaml`
- [ ] Altera o contrato — atualizei a tabela no `README.md` e apliquei a label `breaking-change`

<!-- Se breaking change, descreva o caminho de migração: -->

## Notas para o revisor

<!-- Decisões de desenho, alternativas descartadas, dívida deixada de propósito,
     capturas de tela ou gravação, se houver mudança visual. -->
