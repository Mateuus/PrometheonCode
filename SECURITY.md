# Política de Segurança

## Versões suportadas

O Prometheon está em estágio pré-alfa. Apenas a versão mais recente da branch
`main` e o último release publicado recebem correções de segurança.

| Versão | Suporte |
| --- | --- |
| `main` | ✅ |
| Último release `0.x` | ✅ |
| Releases `0.x` anteriores | ❌ |

## Como relatar uma vulnerabilidade

**Não abra issue pública, pull request ou discussão para vulnerabilidades.**

Use um destes canais privados:

1. **GitHub Security Advisories** (preferido) —
   [Report a vulnerability](https://github.com/Mateuus/PrometheonCode/security/advisories/new).
2. **E-mail** — `muvucasbars@gmail.com`, assunto começando com
   `[Prometheon Security]`.

Inclua, na medida do possível:

- descrição do problema e do impacto;
- versão da extensão, do VS Code e do sistema operacional;
- passos de reprodução ou prova de conceito mínima;
- configuração relevante (sem incluir suas credenciais reais);
- se você já divulgou a falha em algum outro lugar.

### Prazos de resposta

| Etapa | Prazo alvo |
| --- | --- |
| Confirmação de recebimento | 3 dias úteis |
| Avaliação inicial e classificação de severidade | 7 dias corridos |
| Correção ou plano de mitigação para severidade crítica/alta | 30 dias corridos |
| Correção para severidade média/baixa | próximo release planejado |

Mantemos você informado ao longo do processo. Pedimos coordenação da divulgação
pública: publique depois da correção estar disponível, ou após 90 dias, o que
vier primeiro.

## Escopo

### Dentro do escopo

- Execução de código não autorizada a partir de conteúdo da Webview, de resposta
  do servidor ou de arquivo de workspace.
- Vazamento de segredos: gravação em disco, em log, em `.prometheon/`, em
  `globalState`/`workspaceState`, ou envio a terceiros.
- Contorno do modelo de permissões — em especial escapar do escopo ou da duração
  do `Bypass permissions`.
- Falha da CSP da Webview que permita script injetado ou carregamento remoto.
- Escrita de arquivo fora do workspace autorizado; path traversal.
- Execução de comando derivada de entrada não validada (terminal, Git, CLI).
- Aceitação de `http://` para Hub remoto, ou falha na validação de URL/TLS.
- Injeção de comando via nome de branch, caminho de arquivo ou nome de agente.

### Fora do escopo

- Vulnerabilidades em CLIs de terceiros (Claude Code, Codex CLI, Gemini CLI,
  Kimi) — relate ao fornecedor correspondente.
- Vulnerabilidades no VS Code ou no Node.js — relate à Microsoft / ao projeto
  Node.
- Comportamento resultante de o usuário conceder `Bypass permissions`
  intencionalmente no escopo escolhido.
- Ataques que exigem acesso físico à máquina ou privilégio de administrador já
  obtido.
- Engenharia social, spam, phishing contra mantenedores.
- Achados de scanner automatizado sem impacto demonstrado.
- Ausência de hardening que não gere vulnerabilidade explorável (por exemplo,
  cabeçalho de segurança faltando em rota de desenvolvimento local).

## Se você expôs um segredo

Se um token, chave de API ou credencial foi comitado — neste repositório ou em
qualquer fork:

1. **Rotacione o segredo imediatamente** no provedor. Reescrever o histórico do
   Git **não** invalida um segredo já distribuído.
2. Avise pelos canais acima.
3. Só depois cuide da limpeza do histórico.

## Garantias de design

Estes invariantes são verificados em revisão e, quando possível, em testes:

- segredos apenas em `vscode.SecretStorage`;
- nenhuma telemetria e nenhuma coleta de dados;
- Local Chat nunca envia dados a servidor;
- Webview não executa terminal, Git, CLI, rede nem leitura arbitrária de
  arquivo — apenas envia mensagens tipadas e validadas em runtime;
- CSP com `nonce`, sem `unsafe-inline`, sem recurso remoto;
- `Bypass permissions` exige confirmação explícita, tem escopo e duração, expira
  ao reiniciar a extensão e é cancelado ao trocar de workspace;
- Git é inicializado somente após confirmação do usuário;
- logs sanitizados, sem segredo.

## Reconhecimento

Com sua permissão, creditamos quem relatou a falha no advisory e no
`CHANGELOG.md`. Não há programa de recompensa financeira.
