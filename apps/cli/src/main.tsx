#!/usr/bin/env node
/**
 * `prometheon` — o Prometheon fora do editor.
 *
 * Duas regras governam a saída deste programa:
 *
 * 1. **A interface bonita só aparece num terminal de verdade.** Quando a saída
 *    é canalizada para um arquivo ou para outro comando, ela vira texto simples.
 *    Códigos de cor e redesenho de tela num log deixam o arquivo ilegível e
 *    quebram quem tentar processá-lo.
 *
 * 2. **O código de saída é a resposta para quem automatiza.** Zero é sucesso,
 *    e qualquer outro valor não é — sempre, em todo comando.
 */

import { render } from 'ink';
import { runDoctor, type CheckResult } from './doctor.js';
import { Doctor } from './ui/Doctor.js';

const VERSION = '0.0.1';

/** Terminal de verdade, e ninguém pediu o contrário. */
function interactive(): boolean {
  return process.stdout.isTTY && process.env['PROMETHEON_PLAIN'] === undefined;
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');

  switch (command) {
    case 'doctor':
      await doctorCommand(json);
      return;

    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return;

    default:
      printHelp();
      // `help` pedido é sucesso; comando desconhecido não é — quem digitou
      // errado num script precisa que o script pare.
      process.exitCode = command === 'help' || command === '--help' ? 0 : 2;
  }
}

async function doctorCommand(json: boolean): Promise<void> {
  // JSON tem precedência sobre tudo: quem pediu dados estruturados não quer
  // nem cor, nem spinner, nem banner no meio da saída.
  if (json) {
    const results = await runDoctor();

    process.stdout.write(`${JSON.stringify({ version: VERSION, checks: results }, null, 2)}\n`);

    if (results.some((result) => result.status === 'fail')) {
      process.exitCode = 1;
    }

    return;
  }

  if (!interactive()) {
    printPlain(await runDoctor());
    return;
  }

  const app = render(<Doctor version={VERSION} />);

  await app.waitUntilExit();
}

/** A mesma informação, sem cor nem redesenho. */
function printPlain(results: readonly CheckResult[]): void {
  for (const result of results) {
    const mark = result.status === 'ok' ? 'ok  ' : result.status === 'warn' ? 'aviso' : 'FALHA';
    const detail = result.detail === undefined ? '' : ` — ${result.detail}`;

    process.stdout.write(`${mark} ${result.label}${detail}\n`);

    if (result.fix !== undefined) {
      process.stdout.write(`      ${result.fix}\n`);
    }
  }

  if (results.some((result) => result.status === 'fail')) {
    process.exitCode = 1;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'prometheon — orquestração de agentes',
      '',
      'Uso:',
      '  prometheon doctor [--json]   Verifica o que esta máquina precisa',
      '  prometheon version           Mostra a versão',
      '',
      'Variáveis:',
      '  PROMETHEON_PLAIN             Desliga a interface interativa',
      '  NO_COLOR                     Desliga as cores',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
