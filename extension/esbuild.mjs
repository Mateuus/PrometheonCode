import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Os marcadores impressos aqui são o que o problemMatcher da task "watch"
// (em .vscode/tasks.json) usa para saber quando o build começou e terminou.
function reporter(label) {
  return {
    name: 'reporter',
    setup(build) {
      build.onStart(() => console.log('[watch] build started'));
      build.onEnd((result) => {
        for (const { text, location } of result.errors) {
          console.error(`✘ [ERROR] ${text}`);
          if (location) {
            console.error(`    ${location.file}:${location.line}:${location.column}:`);
          }
        }
        for (const { text, location } of result.warnings) {
          console.warn(`▲ [WARNING] ${text}`);
          if (location) {
            console.warn(`    ${location.file}:${location.line}:${location.column}:`);
          }
        }
        console.log(`[watch] build finished (${label})`);
      });
    },
  };
}

/** Extensão: roda no host Node do VS Code, com "vscode" fornecido em runtime. */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [reporter('extension')],
};

/** Webview: roda no navegador da view, sem acesso a Node nem à rede. */
const webviewConfig = {
  entryPoints: ['src/views/webview/main.ts', 'src/views/webview/styles.css'],
  outdir: 'dist/webview',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [reporter('webview')],
};

const contexts = await Promise.all([
  esbuild.context(extensionConfig),
  esbuild.context(webviewConfig),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
