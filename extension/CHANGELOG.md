# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
O projeto segue [SemVer](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Adicionado

- Painel **Prometheon** como webview com CSP rigorosa (scripts apenas por
  `nonce`, sem `unsafe-inline`, sem carregamento remoto), disponível em dois
  lugares com estado compartilhado: na Activity Bar e na Secondary Side Bar,
  junto do chat nativo do VS Code.
- **Local Chat** funcional com streaming simulado, interrupção, estado vazio,
  indicador de processamento e limpeza da conversa.
- **Web Chat** com a tela de Hub não configurado e erro tipado
  `HubNotConfiguredError`.
- Seletores de **Work Mode** (`Plan`, `Edit`, `Agent Team`), **Autonomy**
  (`Manual`, `Auto`, `Bypass permissions`) e **Main Agent**.
- Fluxo de **Bypass permissions** com escopo, duração, confirmação explícita,
  indicador na barra de status, expiração no reinício e cancelamento ao trocar de
  workspace. Nunca é persistido.
- Painel recolhível **Active Agents** com nome, papel, status e tarefa.
- Configuração do workspace em `.prometheon/`, incluindo `prometheon.yaml`,
  `knowledge/Home.md` e atualização do `.gitignore` preservando o conteúdo
  existente. `git init` só após confirmação.
- Camada de permissões com política pura e precedência documentada
  (política do projeto > modo de trabalho > ações seguras > bypass > autonomia).
- `SecretStore` sobre `vscode.SecretStorage`; nenhum segredo em disco ou em log.
- 10 comandos na Command Palette, incluindo `Show Diagnostics` sem dados
  sensíveis.
- Identidade visual: a malha de nós em volta da chama, em
  `media/prometheon-icon-{64,128,256,512}.png` e no logo horizontal. O ícone do
  container (`media/prometheon-view.svg`) é a versão monocromática, porque o VS
  Code recolore esse ícone conforme o tema.
- 48 testes de integração cobrindo registro de agentes, transição de chats,
  persistência de preferências, não persistência do bypass, criação segura de
  `.prometheon/`, preservação do `.gitignore`, validação das mensagens da webview e
  precedência de permissões.

### Notas

- O único agente disponível é o `Mock Agent`. Nenhuma CLI externa é executada.
- Sem telemetria.
