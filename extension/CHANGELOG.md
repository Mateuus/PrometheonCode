# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
O projeto segue [SemVer](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Adicionado

- **Equipe embutida**: a extensão passa a vir com Orchestrator, Coder,
  Researcher e Reviewer prontos, cada um com o próprio prompt. Eles não existem
  em disco — só viram arquivo quando alguém os edita —, a primeira conta criada
  adota os que ainda não têm vínculo, e o Orchestrator assume como agente
  principal quando ninguém escolheu um.
- **Agentes do projeto**: um agente pode ser gravado em `.prometheon/agents/`,
  que vai para o git, e assim a equipe acompanha o repositório. O vínculo com a
  conta fica de fora e continua sendo de cada máquina: quem clona recebe os
  agentes e escolhe a conta dele.
- **Dois modos de delegação**. `report` é trabalho de leitura — o agente não
  altera arquivo nenhum, porque as ferramentas de escrita saem do alcance dele.
  `changes` dá a ele uma **cópia isolada do repositório** (`git worktree`) numa
  branch própria, com as dependências já instaladas ligadas por junção, e o
  relatório volta com branch, arquivos e o resumo do diff.
- `prometheon_status`: o orquestrador passa a enxergar as delegações em
  andamento, e deixa de redelegar o que já está sendo feito.
- **Markdown nas respostas do chat**, com realce de sintaxe por família de
  linguagem e cores tiradas do tema em uso. Relatório de worker chega dobrado na
  conversa, e abre no clique.

### Corrigido

- O agente principal não recebia a pasta de trabalho: o CLI herdava o diretório
  do processo da extensão, não enxergava o repositório aberto e pedia permissão
  para ler o que deveria ser a casa dele.
- Cada mensagem abria uma sessão nova do CLI, sem histórico — o agente respondia
  "esta conversa começa na sua mensagem" no meio de um trabalho. A conversa passa
  a guardar a chave de retomada do CLI e continuar de onde parou.
- Compactar não devolvia espaço: o resumo era escrito dentro da mesma sessão
  cheia. Agora a sessão é largada e o resumo atravessa para a nova.
- Linha informativa do Codex no stderr (`Reading prompt from stdin...`) era
  apresentada como a causa da falha.

- **Orquestração multi-agente**: o agente principal delega tarefas a outros
  agentes por uma ferramenta MCP servida pela própria extensão em `127.0.0.1`,
  com porta efêmera e token de uso único. O worker roda em sessão própria —
  inclusive de outro provedor — aparece na lista de agentes ativos com tela
  própria, e o relatório dele volta pela conversa quando termina. Delegar não
  bloqueia o turno de quem delegou: a chamada devolve um bilhete, e quando
  todos os workers terminam o Prometheon retoma a conversa com os relatórios.
- Limites da delegação: tetos de execução simultânea por agente e por máquina
  (`prometheon.agents.globalConcurrency`), com a vaga reservada antes de
  qualquer espera; orçamento de delegações por pedido; e relatório longo
  gravado em arquivo em vez de ocupar a janela do orquestrador.
- Falha de agente classificada em cota esgotada, login vencido, CLI ausente ou
  erro passageiro, com a orientação correspondente para o orquestrador e um
  aviso legível para quem está olhando o painel.
- **Provedor e agente do Codex**, com isolamento de conta por `CODEX_HOME`.
- Seletor de **esforço de raciocínio** na configuração do agente e no composer,
  traduzido para o vocabulário de cada CLI.
- Prompt de sistema do agente em **arquivo `.md`** versionado.
- **Markdown nas respostas do chat** — ênfase, código, listas, títulos, citações
  e links —, montado em nós do DOM: a resposta de um agente nunca vira marcação
  executável, e link só passa com `http` ou `https`.

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
- Modal central de **Settings** no painel, com as seções `Accounts`, `Agents`,
  `Workspace` e `MCP` — abas no topo em painel estreito, barra lateral a partir
  de 520px. Abre pelo botão de conta do cabeçalho, pelos comandos
  `Configuration` e `Add Account`, e fecha com `Esc`.
- Seção **Accounts** com provedor, método de autenticação, conta, organização,
  plano e diretório isolado de cada perfil, mais a contagem de tokens medida
  localmente (hoje, 7 dias, total) e o formulário de criação de conta dentro do
  próprio painel — sem `QuickPick` nem `InputBox`. Limites de assinatura não
  aparecem: eles vivem na conta do provedor e lê-los exigiria o token do usuário.
  O `Sign in` continua abrindo o fluxo oficial do CLI em um terminal.
- Seção **Agents** com o CRUD dos Agent Profiles (papel, modelo, prompt de
  sistema, autonomia, ferramentas permitidas e negadas, concorrência e
  estratégia de contexto), gravados em `~/.prometheon/agent-profiles.json`. Cada
  agente exige um Provider Profile válido: a criação sem binding falha com erro
  tipado e a interface mostra `Agent → Provider → Account`, avisando quando a
  conta vinculada não está autenticada. O modelo é texto livre — o CLI é quem o
  valida na execução.
- Seção **MCP** para os servidores do projeto no `.mcp.json` da raiz — o mesmo
  arquivo que Claude Code, Cursor e o VS Code leem. Suporta os transportes
  `stdio`, `http` e `sse` (`type` ausente é `stdio`), permite adicionar pelo
  painel, importar e mesclar outro `.mcp.json` (sem sobrescrever nomes que já
  existem) e ligar/desligar cada servidor. A regravação preserva o resto do
  documento e os campos que não conhecemos, porque o arquivo é lido por outras
  ferramentas. `env` e `headers` com cara de credencial em texto puro geram
  aviso na interface — o arquivo do usuário nunca é reescrito nem mascarado por
  conta própria, e o valor não vai para o log.
- Seção **Workspace** com o estado do `.prometheon/` do projeto e as ações de
  inicialização, que antes só existiam na tela de primeiro uso.
- **Tokens por resposta** no cabeçalho de cada mensagem (`↑ entrada ↓ saída`),
  acumulados por perfil no estado local.
- **Barra de atividade** acima do composer enquanto há trabalho: fase, agente,
  provedor, conta, modo e tempo decorrido — o perfil em uso nunca fica oculto.
- **Timeline de trabalho na conversa**: cada uso de ferramenta vira um passo com
  bolinha de estado, nome da ferramenta, alvo, detalhe e a saída num bloco
  recolhível; o raciocínio aparece como `Thought for 3s`. Os passos são
  persistidos na mensagem, com a saída truncada em 4 KB, e sobrevivem ao recarregar
  a conversa. Passo que fica pendente quando o run é cancelado ou falha é fechado
  como falho, em vez de pulsar para sempre.
- Enquanto o agente trabalha, um indicador animado ocupa o lugar do estado vazio,
  alternando entre gerúndios e mostrando o tempo decorrido.
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
- 84 testes de integração cobrindo isolamento de perfis por conta, leitura do
  status de autenticação, contagem de tokens, registro de agentes, transição de
  chats, histórico de sessões, anexos de imagem, ciclo do ditado, persistência
  de preferências, não persistência do bypass, criação segura de `.prometheon/`,
  preservação do `.gitignore`, validação das mensagens da webview, recusa de
  Agent Profile sem conta vinculada, leitura de `agent-profiles.json` e
  `.mcp.json` malformados e precedência de permissões.
- **Skills do projeto**: a extensão lê o catálogo de `.prometheon/skills/` com o
  frontmatter validado, monta o índice por escopo e nível de risco e mostra o
  resultado no painel. Skill malformada vira um problema reportado, nunca uma
  correção silenciosa.
- **Papéis nomeados** para os Agent Profiles, com precedência projeto → Hub →
  máquina. Papel malformado é descartado inteiro; agente cujo papel sumiu é
  avisado, e não reapontado para outro.
- **Catálogo de modelos** lido de `media/models.json` — acrescentar ou corrigir
  um modelo deixou de exigir mudança de código.
- **Web Chat pelo Hub**: sessões, mensagens e histórico pela API do Hub, com os
  eventos chegando em tempo real por WebSocket em vez de polling.
- **Grafo do projeto**, configurável e reconstruído sob demanda. O custo do
  rebuild é anunciado antes de disparar, porque a reconstrução é cara.
- **Política de commit** do projeto, aplicada ao que o agente pode commitar.
- **Console do agente** no painel: a saída integral de cada passo fica guardada
  junto da sessão que a produziu. A conversa continua guardando a versão
  truncada, mas a contagem de linhas é da saída inteira e o original permanece
  recuperável.
- **Ditado por voz na própria máquina**: o Whisper local roda por
  `media/speech/prometheon_speech.py` e o áudio não sai do computador. O
  ambiente Python é conferido antes de gravar, e o que falta é dito na interface
  em vez de falhar em silêncio.

### Corrigido

- O reconhecedor de voz repetia a última palavra enquanto ninguém falava. O
  silêncio agora é tratado como silêncio.

### Notas

- O único agente disponível é o `Mock Agent`. Nenhuma CLI externa é executada.
- Sem telemetria.
- O ditado usa um motor local próprio, e não a API `speech` do VS Code: a
  extensão `ms-vscode.vscode-speech` apenas **registra** um provider para o
  workbench consumir (`contributes.speechProviders`), não expõe API pública e a
  proposta não tem lado de consumo para extensões de terceiros.
