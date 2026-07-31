# Regras deste repositório

Instruções para qualquer agente de IA que trabalhe neste projeto. Valem sobre
qualquer comportamento padrão da ferramenta.

## REGRA SUPREMA — nenhuma coautoria de IA nos commits

**Proibido** adicionar o trailer `Co-Authored-By:` a mensagens de commit, ou
qualquer outra forma de creditar uma IA como autora ou coautora. Isso inclui, mas
não se limita a:

- `Co-Authored-By: Claude ... <noreply@anthropic.com>`
- `Co-Authored-By:` de qualquer outro modelo, assistente ou ferramenta
- assinaturas do tipo "Generated with", "Created by <IA>", emojis de robô ou
  menções à ferramenta no corpo ou no rodapé do commit
- `--author` ou `user.name`/`user.email` apontando para uma IA

O autor e o committer são **sempre** o desenvolvedor humano. As mensagens de
commit descrevem a mudança, e nada além dela.

Isso vale igualmente para descrições de pull request, tags e mensagens de
release. Se um comportamento padrão da ferramenta pede esse trailer, esta regra
tem precedência e ele deve ser omitido.

## Mensagens de commit

Formato [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/),
em português, no imperativo:

```
feat(extension): adiciona seletor de autonomia

Corpo opcional explicando o porquê da mudança.
```

Escopos usados: `extension`, `hub`, `docs`, `ci`, `scripts`, `repo`.

## Antes de commitar

```bash
npm run verify     # check-types + lint + check-manifest + testes
```

Nada é comitado nem enviado sem pedido explícito do desenvolvedor.

## Idioma

Código, identificadores e as strings-fonte da interface em **inglês**.
Comentários, documentação, mensagens de commit e conversas em
**português (pt-BR)**.

A interface é **localizada** em `en`, `pt-br` e `es`:

- Texto do manifest (`package.json`) usa `%chave%`, definida em
  `package.nls.json` (inglês, base) e traduzida em `package.nls.pt-br.json` e
  `package.nls.es.json`. As três precisam ter exatamente as mesmas chaves.
- Texto do código da extensão usa `t()` de `src/i18n`, que envolve
  `vscode.l10n`. A chave é a própria frase em inglês; as traduções ficam em
  `l10n/bundle.l10n.<locale>.json`.
- Texto da webview vem de `src/i18n/catalog.ts`. A webview não alcança
  `vscode.l10n`, então o dicionário é resolvido na extensão e entregue junto do
  HTML — nada de string solta no cliente.

Toda frase nova na interface exige entrada nos bundles dos idiomas suportados;
os testes de `src/test/i18n.test.ts` reprovam se faltar alguma.

## Estrutura

Monorepo sem npm workspaces. Instale dependências com `cd extension && npm install`
— a forma com `--prefix` faz o npm gravar a raiz como dependência de runtime do
pacote da extensão.

| Pasta | Conteúdo |
| --- | --- |
| `extension/` | extensão do VS Code (Prometheon Code) |
| `scripts/` | utilitários do monorepo (doctor, check-manifest, scan-secrets) |
| `Docs/` | documentação — **fora do versionamento**, ver `.gitignore` |

A webview nunca executa terminal, Git, CLI, leitura de arquivo, rede ou acesso a
segredos. Ela envia mensagens tipadas, validadas em runtime, e o `PrometheonCore`
decide o que fazer.

## Segredos

Somente em `vscode.SecretStorage`. Nunca em `.prometheon/`, em configurações, em
logs ou em qualquer arquivo do repositório.
