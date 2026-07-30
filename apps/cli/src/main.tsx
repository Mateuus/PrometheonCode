#!/usr/bin/env node
/**
 * `prometheon` — o Prometheon fora do editor.
 *
 * Duas regras governam a saída deste programa:
 *
 * 1. **A interface rica só aparece num terminal de verdade.** Quando a saída é
 *    canalizada para um arquivo ou para outro comando, ela vira texto simples.
 *    Códigos de cor e redesenho de tela num log deixam o arquivo ilegível e
 *    quebram quem tentar processá-lo.
 *
 * 2. **O código de saída é a resposta para quem automatiza.** Zero é sucesso, e
 *    qualquer outro valor não é — sempre, em todo comando.
 */

import { render } from 'ink';
import type { Autonomy, WorkMode } from '@prometheon/agent-runtime';
import { runDoctor, type CheckResult } from './doctor.js';
import { forgetCredential, readCredential, whoami } from './hub.js';
import { activeProfile } from './profiles.js';
import { Doctor } from './ui/Doctor.js';
import { Login } from './ui/Login.js';
import { Run } from './ui/Run.js';

const VERSION = '0.0.1';
const DEFAULT_HUB = 'https://api.prometheoncode.xyz';

/** Terminal de verdade, e ninguém pediu o contrário. */
function interactive(): boolean {
  return process.stdout.isTTY && process.env['PROMETHEON_PLAIN'] === undefined;
}

/** Valor de uma opção `--nome valor`, ou indefinido. */
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);

  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');

  switch (command) {
    case 'doctor':
      await doctorCommand(json);
      return;

    case 'run':
      await runCommand(rest);
      return;

    case 'login':
      await loginCommand(rest);
      return;

    case 'logout':
      await forgetCredential();
      process.stdout.write('Credencial do Hub removida desta máquina.\n');
      return;

    case 'whoami':
      await whoamiCommand(json);
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

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function doctorCommand(json: boolean): Promise<void> {
  // JSON tem precedência sobre tudo: quem pediu dados estruturados não quer nem
  // cor, nem spinner, nem banner no meio da saída.
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

  await render(<Doctor version={VERSION} />).waitUntilExit();
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runCommand(args: readonly string[]): Promise<void> {
  // A tarefa é tudo que não começa com `--`, junto: aspas no shell são fáceis
  // de esquecer, e falhar por isso seria hostil sem necessidade.
  const prompt = args.filter((argument) => !argument.startsWith('--')).join(' ').trim();

  if (prompt === '') {
    process.stderr.write('Diga o que fazer: prometheon run "corrija o teste que falha"\n');
    process.exitCode = 2;
    return;
  }

  const profile = await activeProfile();

  if (profile === undefined) {
    process.stderr.write(
      'Nenhuma conta de provedor configurada.\nConfigure uma no painel do VS Code, ou rode: prometheon doctor\n',
    );
    process.exitCode = 1;
    return;
  }

  const workMode = (option(args, 'mode') ?? 'edit') as WorkMode;
  const autonomy = (option(args, 'autonomy') ?? 'manual') as Autonomy;

  if (!interactive()) {
    // Sem terminal, a execução ainda acontece — só não há tela. Quem chamou de
    // um script quer o resultado, não a animação.
    const { runClaude } = await import('@prometheon/agent-runtime');
    const run = runClaude({
      prompt,
      workMode,
      autonomy,
      cwd: process.cwd(),
      executable: profile.executablePath,
      configDirectory: profile.configDirectory,
    });

    for await (const event of run.events) {
      if (event.type === 'delta') {
        process.stdout.write(event.text);
      }

      if (event.type === 'completed') {
        process.stdout.write(event.text === '' ? '\n' : `${event.text}\n`);
      }

      if (event.type === 'failed') {
        process.stderr.write(`${event.error.message}\n`);
        process.exitCode = 1;
      }
    }

    return;
  }

  await render(
    <Run
      version={VERSION}
      prompt={prompt}
      workMode={workMode}
      autonomy={autonomy}
      cwd={process.cwd()}
      executable={profile.executablePath}
      configDirectory={profile.configDirectory}
      provider="Claude Code"
      account={profile.name}
    />,
  ).waitUntilExit();
}

// ---------------------------------------------------------------------------
// hub
// ---------------------------------------------------------------------------

async function loginCommand(args: readonly string[]): Promise<void> {
  const url = option(args, 'hub') ?? process.env['PROMETHEON_HUB_URL'] ?? DEFAULT_HUB;

  if (!interactive()) {
    process.stderr.write(
      'O login precisa de um terminal interativo: ele mostra um código para você confirmar no navegador.\n',
    );
    process.exitCode = 2;
    return;
  }

  await render(<Login version={VERSION} url={url} />).waitUntilExit();
}

async function whoamiCommand(json: boolean): Promise<void> {
  const credential = await readCredential();

  if (credential === null) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ connected: false }, null, 2)}\n`);
    } else {
      process.stdout.write('Nenhum Hub conectado. Rode: prometheon login\n');
    }

    // Não estar conectado não é falha: o CLI funciona local. Sair com erro faria
    // um script tratar o uso normal como problema.
    return;
  }

  const user = await whoami(credential);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ connected: user !== null, hub: credential.url, user }, null, 2)}\n`,
    );
  } else if (user === null) {
    process.stdout.write(
      `A credencial de ${credential.url} não vale mais, ou o Hub não respondeu.\nRode: prometheon login\n`,
    );
  } else {
    process.stdout.write(`${user.name} (${user.email}) em ${credential.url}\n`);
  }

  if (user === null) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// saída simples
// ---------------------------------------------------------------------------

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
      '  prometheon run "tarefa"       Executa o agente nesta pasta',
      '  prometheon doctor [--json]    Verifica o que esta máquina precisa',
      '  prometheon login [--hub URL]  Conecta este dispositivo ao Hub',
      '  prometheon whoami [--json]    Mostra a conta conectada',
      '  prometheon logout             Esquece a credencial do Hub',
      '  prometheon version            Mostra a versão',
      '',
      'Opções de `run`:',
      '  --mode plan|edit|agent-team   Padrão: edit',
      '  --autonomy manual|auto|bypass Padrão: manual',
      '',
      'Variáveis:',
      '  PROMETHEON_HUB_URL            Hub padrão do `login`',
      '  PROMETHEON_PLAIN              Desliga a interface interativa',
      '  NO_COLOR                      Desliga as cores',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
