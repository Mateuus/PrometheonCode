// Servidor do preview da webview: renderiza o painel real num navegador comum
// e recarrega a página a cada rebuild do esbuild. Uso: `npm run preview` na
// pasta extension/ e abrir a URL impressa (adicione `?view=settings` para o
// modal de configurações já aberto, `&lang=en`/`es` para trocar o idioma).
//
// Ferramenta de desenvolvimento apenas: nada daqui entra no VSIX (ver
// .vscodeignore) e nenhum dado real é lido — o estado vem de `fixture.ts`.
import esbuild from 'esbuild';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const PORT = 4517;

// ---------------------------------------------------------------------------
// Livereload: cada rebuild bem-sucedido avisa os navegadores abertos por SSE.
// ---------------------------------------------------------------------------
const clients = new Set();
let generation = 0;

function reloadPlugin(label) {
  return {
    name: 'preview-reload',
    setup(build) {
      build.onEnd((result) => {
        for (const error of result.errors) {
          console.error(`✘ [${label}] ${error.text}`);
          if (error.location) {
            console.error(`    ${error.location.file}:${error.location.line}`);
          }
        }
        if (result.errors.length === 0) {
          generation += 1;
          console.log(`[preview] ${label} pronto (#${generation})`);
          for (const client of clients) {
            client.write('data: reload\n\n');
          }
        }
      });
    },
  };
}

const shared = { bundle: true, sourcemap: true, logLevel: 'silent', absWorkingDir: root };

const contexts = await Promise.all([
  // A webview de verdade — o mesmo bundle que a extensão embarca.
  esbuild.context({
    ...shared,
    entryPoints: ['src/views/webview/main.ts', 'src/views/webview/styles.css'],
    outdir: 'dist/webview',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    plugins: [reloadPlugin('webview')],
  }),
  // O renderizador do template, rodando em Node com o shim no lugar do vscode.
  esbuild.context({
    ...shared,
    entryPoints: ['preview/host.ts'],
    outfile: 'preview/dist/host.mjs',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    alias: { vscode: './preview/vscode-shim.ts' },
    plugins: [reloadPlugin('host')],
  }),
  // O host de mentira que o navegador carrega antes do main.js, e o tema com
  // as variáveis que o VS Code injetaria.
  esbuild.context({
    ...shared,
    entryPoints: ['preview/client-shim.ts', 'preview/theme.css'],
    outdir: 'preview/dist',
    entryNames: '[name]',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    plugins: [reloadPlugin('client')],
  }),
]);

await Promise.all(contexts.map((context) => context.watch()));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
};

/** Só o que o preview precisa expor; nada de servir a pasta inteira. */
const STATIC_PREFIXES = ['/dist/', '/media/', '/preview/dist/'];

async function renderPage(url) {
  // Import com número de geração na query: o Node não recarrega módulo ESM já
  // importado, e sem isso o HTML ficaria preso na primeira versão do template.
  const module = await import(
    `${pathToFileURL(join(root, 'preview', 'dist', 'host.mjs')).href}?v=${generation}`
  );
  return module.renderPreviewHtml(
    root,
    url.searchParams.get('lang') ?? 'pt-br',
    url.searchParams.get('state'),
  );
}

/**
 * Moldura da raiz: o painel dentro de um quadro com a largura de uma Side Bar,
 * redimensionável pela borda. Desenhar em tela cheia engana — o painel vive
 * num corredor de ~400px, e é nessa largura que o design precisa funcionar.
 */
function renderShell(url) {
  const panelQuery = url.search ?? '';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Prometheon — preview</title>
  <style>
    html, body { margin: 0; height: 100%; background: #141414; }
    body { display: flex; align-items: stretch; justify-content: center; padding: 18px; box-sizing: border-box; font-family: 'Segoe UI', system-ui, sans-serif; }
    .frame { resize: horizontal; overflow: hidden; width: 420px; min-width: 300px; max-width: 96vw; height: 100%; border: 1px solid #2f2f2f; border-radius: 8px; display: flex; flex-direction: column; background: #1f1f1f; }
    .frame-bar { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid #2f2f2f; color: #8a8a8a; font-size: 11px; user-select: none; }
    .frame-bar b { color: #bbb; font-weight: 600; }
    .frame-bar span.hint { margin-left: auto; }
    iframe { border: 0; flex: 1; width: 100%; }
  </style>
</head>
<body>
  <div class="frame">
    <div class="frame-bar"><b>Prometheon</b> painel · arraste o canto para mudar a largura <span class="hint">/panel${panelQuery.replace(/&/g, '&amp;')} para tela cheia</span></div>
    <iframe src="/panel${panelQuery.replace(/"/g, '&quot;')}" title="Prometheon panel"></iframe>
  </div>
</body>
</html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, { 'content-type': MIME['.html'] });
      response.end(renderShell(url));
      return;
    }

    if (pathname === '/panel') {
      const html = await renderPage(url);
      response.writeHead(200, { 'content-type': MIME['.html'] });
      response.end(html);
      return;
    }

    if (pathname === '/__events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write('retry: 500\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }

    const isStatic = STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
    if (isStatic) {
      const file = normalize(join(root, pathname));
      // `normalize` acima + esta checagem barram `..` de escapar da extensão.
      if (file.startsWith(root) && existsSync(file)) {
        const extension = file.slice(file.lastIndexOf('.'));
        response.writeHead(200, {
          'content-type': MIME[extension] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        createReadStream(file).pipe(response);
        return;
      }
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`404: ${pathname}`);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(String(error && error.stack ? error.stack : error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  Preview do painel:  http://127.0.0.1:${PORT}/`);
  console.log(`  Modal de settings:  http://127.0.0.1:${PORT}/?view=settings`);
  console.log(`  Outro idioma:       http://127.0.0.1:${PORT}/?lang=en`);
  console.log('');
  console.log('  Edite src/views/webview/* e o navegador recarrega sozinho.');
});
