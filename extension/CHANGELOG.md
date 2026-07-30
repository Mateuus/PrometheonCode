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
  (`Manual`, `Auto`, `Bypass permissions`) e **Main Agent**, em menus com ícone,
  nome e descrição de cada opção — o `<select>` nativo não mostra a descrição,
  que é justamente o que ajuda a escolher.
- Composer como um cartão único: anexos, campo e ações na mesma moldura, que
  reage ao foco com o roxo da marca.
- Fluxo de **Bypass permissions** com escopo, duração, confirmação explícita,
  indicador na barra de status, expiração no reinício e cancelamento ao trocar de
  workspace. Nunca é persistido.
- Painel recolhível **Active Agents** com nome, papel, status e tarefa.
- **Multi-Provider Agent Profiles — fundação**: contas locais de CLI com
  diretório de configuração isolado por perfil, `ClaudeCodeAdapter` (detecção,
  `auth login` no fluxo oficial em terminal, `auth status --json`, `auth logout`)
  e registro de adaptadores aberto para Codex, Gemini e Kimi. Os perfis ficam em
  `~/.prometheon/local-profiles.json`; credenciais nunca são lidas, copiadas ou
  versionadas, e remover um perfil não apaga o diretório de autenticação.
- Painel **Accounts & Usage** com provedor, método de autenticação, conta,
  organização, plano e diretório isolado de cada perfil, mais a contagem de
  tokens medida localmente (hoje, 7 dias, total). Limites de assinatura não
  aparecem: eles vivem na conta do provedor e lê-los exigiria o token do usuário.
- **Tokens por resposta** no cabeçalho de cada mensagem (`↑ entrada ↓ saída`),
  acumulados por perfil no estado local.
- **Barra de atividade** acima do composer enquanto há trabalho: fase, agente,
  provedor, conta, modo e tempo decorrido — o perfil em uso nunca fica oculto.
- Interface na **paleta do Prometheon**: roxo `#7C3AED` em botões, ícones, foco e
  seleção; ciano em conexão e atividade; laranja no agente principal; âmbar no
  aviso de bypass. Superfícies e bordas da marca entram apenas em temas escuros —
  no tema claro do VS Code, quem manda continua sendo o tema.
- **Ditado** no composer: botão de microfone e `Ctrl+D`, com toque para alternar
  e segurar para gravar enquanto a tecla estiver pressionada; `Esc` cancela. A
  captura e a transcrição ficam atrás de um `SpeechProvider` no lado da extensão,
  ainda **sem motor registrado** — o botão mostra o motivo em vez de não fazer
  nada. A webview não grava áudio: o iframe dela não tem acesso ao microfone.
- **Histórico de sessões** no cabeçalho: título da sessão aberta, botão de nova
  sessão e um popover com o seletor `Local`/`Web`, busca e a lista de sessões
  ordenada pela mais recente. A sessão nasce `Untitled` e é nomeada pela
  primeira mensagem.
- **Anexos de imagem** no composer: colar da área de transferência, arrastar e
  soltar ou escolher em disco (`png`, `jpg`, `gif`, `webp`), com miniatura,
  remoção antes do envio e visualização em tela cheia ao clicar. No composer o
  anexo aparece como uma faixa com miniatura, nome e dimensões. Até 4 imagens de
  4 MB por mensagem, validadas na fronteira da webview.
- Configuração do workspace em `.prometheon/`, incluindo `prometheon.yaml`,
  `knowledge/Home.md` e atualização do `.gitignore` preservando o conteúdo
  existente. `git init` só após confirmação.
- Camada de permissões com política pura e precedência documentada
  (política do projeto > modo de trabalho > ações seguras > bypass > autonomia).
- `SecretStore` sobre `vscode.SecretStorage`; nenhum segredo em disco ou em log.
- 10 comandos na Command Palette, incluindo `Show Diagnostics` sem dados
  sensíveis.
- Identidade visual: a malha de nós em volta da chama, em
  `media/prometheon-icon-{64,128,256,512}.png` e no logo horizontal.
  `media/prometheon-view.svg` é usado no cabeçalho do painel, onde aparece
  colorido. O ícone dos containers é o `media/prometheon-view-mono.svg`, porque
  a Activity Bar e a Secondary Side Bar usam o arquivo como máscara — cor e
  gradiente viram uma silhueta chapada.
- 67 testes de integração cobrindo isolamento de perfis por conta, leitura do
  status de autenticação, contagem de tokens, registro de agentes, transição de
  chats, histórico de sessões, anexos de imagem, ciclo do ditado, persistência
  de preferências, não persistência do bypass, criação segura de `.prometheon/`,
  preservação do `.gitignore`, validação das mensagens da webview e precedência
  de permissões.

### Notas

- O único agente disponível é o `Mock Agent`. Nenhuma CLI externa é executada.
- Sem telemetria.
- O ditado não tem motor de voz. A API `speech` do VS Code não serve: a extensão
  `ms-vscode.vscode-speech` apenas **registra** um provider para o workbench
  consumir (`contributes.speechProviders`), não expõe API pública e a proposta
  não tem lado de consumo para extensões de terceiros. As alternativas em aberto
  são um módulo nativo de captura, um comando externo configurável (ffmpeg +
  whisper local) ou o Prometheon Hub.
