# Prometheon Code

**One workspace. Every agent.**

Extensão do VS Code que coordena vários agentes de IA de codificação a partir de
um único painel. Esta é a primeira versão funcional: a interface, os contratos e
a camada de permissões estão prontos, e o agente que responde é um **adaptador
simulado** (`Mock Agent`). Nenhuma CLI real é acionada ainda.

## O que já funciona

| Recurso | Estado |
| --- | --- |
| Painel na Activity Bar **e** na Secondary Side Bar, junto do chat nativo | ✅ |
| Local Chat com streaming (via `Mock Agent`) | ✅ |
| Web Chat exibindo o estado "Hub não configurado" | ✅ |
| Seletores de Work Mode, Autonomy e Main Agent | ✅ |
| `Bypass permissions` com escopo, duração e confirmação | ✅ |
| Painel recolhível *Active Agents* | ✅ |
| Configuração do workspace em `.prometheon/` | ✅ |
| 10 comandos na Command Palette | ✅ |
| Adaptadores reais (Claude Code, Codex, Gemini, Kimi) | 🚧 |
| Prometheon Hub (Web Chat, times, memória compartilhada) | 🚧 |

## Como executar

Rode a partir **da raiz do repositório** (não desta pasta):

```bash
npm run install:all     # instala dependências
npm run compile          # gera dist/extension.js e dist/webview/
```

Depois abra a raiz do repositório no VS Code e pressione <kbd>F5</kbd>
(configuração **Executar extensão**). Isso inicia a task `watch` e abre uma
janela *Extension Development Host* com o Prometheon carregado.

Na janela nova o painel está em dois lugares, com o mesmo estado nos dois:

- o ícone do Prometheon na **Activity Bar**;
- a aba **Prometheon** na **Secondary Side Bar**, ao lado de *Chat* — abra com
  *View: Toggle Secondary Side Bar* (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd>).

### Como testar o Local Chat

1. Digite qualquer coisa no campo inferior e pressione <kbd>Enter</kbd>
   (<kbd>Shift</kbd>+<kbd>Enter</kbd> insere uma nova linha).
2. A resposta aparece em streaming, palavra por palavra:
   `Prometheon está funcionando. Recebi sua mensagem no modo Plan, com autonomia Manual.`
3. Durante a resposta, o botão **Stop** interrompe o run — a mensagem parcial é
   mantida.
4. **Clear** apaga apenas a conversa local. **New Local Chat** (ícone `+` no
   título da view) começa outra.

### Como testar os modos

Na barra inferior do painel, ou pela Command Palette:

- **Mode** → `Plan`, `Edit`, `Agent Team`. A escolha aparece na resposta simulada
  e é persistida.
- **Autonomy** → `Manual`, `Auto`, `Bypass permissions`.
- **Main** → o agente principal (hoje apenas `Mock Agent`).

Ao escolher **Bypass permissions**, o fluxo exige: confirmação do aviso, escolha
de escopo (`Agent worktrees`, `Current project`, `Selected workspace`), escolha de
duração (`One task`, `Current session`) e uma confirmação final. Enquanto ativo,
um indicador amarelo aparece na barra de status. Ele **desaparece** se você
recarregar a janela — bypass nunca é persistido.

### Como testar o Web Chat

Clique na aba **Web Chat**. Como não há Hub configurado, o painel explica a
situação e oferece **Connect to Prometheon Hub**. Informar uma URL guarda a
configuração e rejeita a conexão com um erro tipado (`HubNotConfiguredError`) —
nada é enviado para fora.

### Como testar a configuração do workspace

Abra uma pasta sem `.prometheon/`. O painel mostra *Set up Prometheon for this
workspace* com três opções. **Initialize in current workspace** cria:

```
.prometheon/
├── prometheon.yaml
├── agents/         brain/        graph/
├── knowledge/Home.md
├── tasks/{active,completed}/
├── sessions/summaries/
├── mcp/            local/
```

e acrescenta ao `.gitignore` as entradas do Prometheon **sem apagar** o que já
existia. Se a pasta não for um repositório Git, um diálogo pergunta antes de
rodar `git init` — nada é executado sem confirmação.

## Comandos

| Comando | O que faz |
| --- | --- |
| `Prometheon: Open Chat` | Abre o painel |
| `Prometheon: New Local Chat` | Cria uma conversa local |
| `Prometheon: Configure Workspace` | Escolhe como configurar o workspace |
| `Prometheon: Initialize Workspace` | Cria `.prometheon/` na pasta aberta |
| `Prometheon: Select Main Agent` | Troca o agente principal |
| `Prometheon: Select Work Mode` | Troca o modo de trabalho |
| `Prometheon: Select Autonomy` | Troca o nível de autonomia |
| `Prometheon: Disable Bypass Permissions` | Revoga o bypass imediatamente |
| `Prometheon: Open Settings` | Abre as configurações da extensão |
| `Prometheon: Show Diagnostics` | Relatório do estado atual, sem dados sensíveis |

## Configurações

| Configuração | Padrão | Descrição |
| --- | --- | --- |
| `prometheon.hub.url` | `""` | URL do Hub. HTTPS obrigatório fora de `localhost` |
| `prometheon.chat.defaultType` | `local` | Chat aberto por padrão |
| `prometheon.workspace.promptOnOpen` | `true` | Mostrar a tela de configuração do workspace |

Logs vão para o canal de saída **Prometheon**. Para ver mensagens `debug`, use
*Developer: Set Log Level…*.

## Estrutura do código

```
src/
├── extension.ts                    ativação e injeção de dependências
├── constants.ts                    ids estáveis (extensão, view)
├── commands/                       registro dos comandos
├── core/                           PrometheonCore, EventBus, tipos e estado
├── chat/                           ChatService, LocalChatService, WebChatService
├── agents/                         AgentAdapter, MockAgentAdapter, AgentRegistry
├── permissions/                    PermissionPolicy (pura) e PermissionService
├── workspace/                      WorkspaceService e WorkspaceInitializer
├── storage/                        SettingsStore, SecretStore, LocalStateStore
├── hub/                            HubClient e DisabledHubClient
├── views/                          provider, mensagens validadas e webview
└── test/                           testes de integração
```

**Regra arquitetural:** a webview nunca executa terminal, Git, CLI, leitura de
arquivo, chamada ao Hub ou acesso a segredos. Ela envia mensagens tipadas, que
passam por validação de runtime em `src/views/messages.ts`, e o `PrometheonCore`
decide o que fazer.

## Desenvolvimento

```bash
npm run watch          # build incremental (extensão + webview)
npm run check-types    # tsc --noEmit
npm run lint
npm test               # 48 testes de integração em um VS Code real
npm run vsix           # empacota o .vsix em ../dist/
```

## Decisões desta primeira versão

Registradas aqui porque diferem do documento de implementação ou resolvem pontos
que ele deixou abertos:

1. **A extensão vive em `extension/`**, não em `prometheon-code/`. O repositório é
   um monorepo e vai receber o Hub como pasta irmã.
2. **Confirmação de Bypass via diálogos nativos** (modal + Quick Picks) em vez de
   um formulário dentro da webview. Menos superfície na webview e o usuário
   reconhece o padrão do VS Code.
3. **Escopo e duração do bypass no `PermissionService`**, com política pura e
   testável em `permissions/PermissionPolicy.ts`. `git.init` e `hub.network`
   sempre pedem confirmação, mesmo com bypass ativo.
4. **Precedência das preferências:** `.prometheon/prometheon.yaml` (config do
   projeto) > estado local do usuário > padrão. Assim um projeto pode fixar
   `Plan` para o time. Bypass não vem de nenhuma das fontes.
5. **`.gitkeep` nas pastas que nascem vazias**, para a estrutura sobreviver a um
   clone. O documento não pedia, mas sem isso o Git não versiona a árvore.
6. **`yaml` como única dependência de runtime**, para ler e escrever
   `prometheon.yaml` preservando os comentários da equipe.
7. **Um único `tsconfig.json`** com a lib `DOM` incluída, já que o cliente da
   webview é compilado pelo mesmo projeto. O código da extensão não usa DOM.
8. **Testes na infraestrutura oficial** (`@vscode/test-cli`), não em Vitest, para
   rodar contra a API real do VS Code.
9. **Interface em inglês, código e documentação em português** — o produto é
   internacional, o time é brasileiro.

## Limitações conhecidas

- Nenhum agente real: só o `Mock Agent`.
- `Agent Team` altera o estado e as permissões, mas não delega de fato.
- Nenhum Git worktree é criado.
- Web Chat não conecta: o Hub não existe.
- Graphify e MCP aparecem na configuração, sem integração.
- O histórico local vive em `workspaceState`, não em arquivo.

## Antes de publicar

O `publisher` é provisório (`prometheon`). Troque pelo ID real do Marketplace; o
`EXTENSION_ID` em [src/constants.ts](src/constants.ts) precisa acompanhar — o
`npm run check-manifest` na raiz falha se os dois saírem de sincronia.
