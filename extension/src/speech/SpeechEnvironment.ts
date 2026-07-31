import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import { t } from '../i18n';
import type { Logger } from '../logger';

const run = promisify(execFile);

/**
 * Ambiente Python do ditado.
 *
 * O motor precisa de `faster-whisper`, `sounddevice` e `webrtcvad`. Instalá-los
 * no Python do sistema seria mexer num ambiente que não é nosso — quem tem
 * projetos Python na máquina sabe o estrago que uma dependência inesperada
 * causa. Em vez disso a extensão mantém um ambiente virtual próprio dentro do
 * armazenamento global dela, e ali pode instalar o que precisar sem afetar
 * nada.
 *
 * Deliberadamente **sem** `torch`: o CTranslate2, que roda o modelo por baixo
 * do faster-whisper, não depende dele. São algumas centenas de megabytes em vez
 * de vários gigabytes, e é o que torna aceitável a extensão preparar isso
 * sozinha.
 */

/** Mínimo suportado pelo faster-whisper e pelas rodas do CTranslate2. */
const MIN_PYTHON = [3, 9] as const;

/** Candidatos a Python do sistema, na ordem em que valem a tentativa. */
const PYTHON_CANDIDATES =
  process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];

/**
 * O que o motor precisa.
 *
 * As duas bibliotecas da NVIDIA entram sempre, e não só em máquina com placa:
 * descobrir que faltam exigiria detectar a GPU antes de instalar, e elas são
 * inertes onde não há CUDA. Numa Radeon ou sem placa nenhuma, o motor roda em
 * CPU e estes pacotes apenas ocupam disco.
 */
const REQUIREMENTS = [
  'faster-whisper>=1.1.0',
  'sounddevice>=0.4.6',
  'webrtcvad-wheels>=2.0.14',
  'nvidia-cublas-cu12',
  'nvidia-cudnn-cu12',
] as const;

/** Módulos conferidos para decidir se o ambiente já está pronto. */
const REQUIRED_MODULES = ['faster_whisper', 'sounddevice', 'webrtcvad', 'numpy'] as const;

export class SpeechEnvironment {
  private readonly root: vscode.Uri;
  private preparing: Promise<string | null> | null = null;
  private systemPython: Promise<string | null> | null = null;

  constructor(
    context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.root = vscode.Uri.joinPath(context.globalStorageUri, 'speech-env');
  }

  /** Python do ambiente, exista ele ou não ainda. */
  private get pythonPath(): string {
    return process.platform === 'win32'
      ? join(this.root.fsPath, 'Scripts', 'python.exe')
      : join(this.root.fsPath, 'bin', 'python');
  }

  /** Ambiente pronto, sem instalar nada. Barato o bastante para a interface. */
  async isReady(): Promise<boolean> {
    if (!existsSync(this.pythonPath)) {
      return false;
    }

    return this.hasModules(this.pythonPath);
  }

  /**
   * Se o ditado é utilizável nesta máquina, preparando ou não.
   *
   * É o que a interface pergunta para decidir entre um microfone ativo e um
   * desabilitado com o motivo. Responder exigiria preparar o ambiente — e
   * preparar custa centenas de megabytes —, então a pergunta é outra: já está
   * pronto, ou existe um Python que dê conta de prepará-lo quando alguém
   * clicar?
   */
  async canUse(): Promise<boolean> {
    if (await this.isReady()) {
      return true;
    }

    return (await this.findSystemPython()) !== null;
  }

  /**
   * Devolve o Python pronto para uso, preparando o ambiente se preciso.
   *
   * A primeira chamada baixa algumas centenas de megabytes, então acontece com
   * barra de progresso e pode ser cancelada. As seguintes só conferem e voltam.
   *
   * Chamadas concorrentes compartilham a mesma preparação: dois `pip install`
   * no mesmo ambiente virtual se atrapalham, e o segundo costuma terminar com
   * uma instalação pela metade.
   */
  async ensure(): Promise<string | null> {
    if (await this.isReady()) {
      return this.pythonPath;
    }

    this.logger.info('Ditado: ambiente Python ainda não existe; preparando agora.');

    this.preparing ??= this.prepare().finally(() => {
      this.preparing = null;
    });

    return this.preparing;
  }

  private async prepare(): Promise<string | null> {
    const systemPython = await this.findSystemPython();

    if (systemPython === null) {
      this.logger.warn('Ditado: nenhum Python 3.9 ou superior encontrado.');
      void vscode.window.showWarningMessage(t('Dictation needs Python 3.9 or newer installed.'));

      return null;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Preparing the dictation engine…'),
        cancellable: true,
      },
      async (progress, token) => {
        try {
          if (!existsSync(this.pythonPath)) {
            progress.report({ message: t('Creating the Python environment') });
            await run(systemPython, ['-m', 'venv', this.root.fsPath], { timeout: 120_000 });
          }

          if (token.isCancellationRequested) {
            return null;
          }

          progress.report({ message: t('Downloading the speech model dependencies') });
          await run(
            this.pythonPath,
            ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...REQUIREMENTS],
            // Generoso: são centenas de megabytes, e numa conexão ruim o
            // download legítimo passa fácil de dez minutos. Falhar antes disso
            // desperdiçaria o que já baixou.
            { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 },
          );

          if (!(await this.hasModules(this.pythonPath))) {
            this.logger.error('Ditado: instalação terminou sem as dependências esperadas.');

            return null;
          }

          this.logger.info('Ditado: ambiente Python pronto.');

          return this.pythonPath;
        } catch (error) {
          this.logger.error(`Ditado: falha ao preparar o ambiente: ${String(error)}`);
          void vscode.window.showErrorMessage(t('Could not prepare the dictation engine.'));

          return null;
        }
      },
    );
  }

  /**
   * Primeiro Python do sistema que atenda à versão mínima.
   *
   * O resultado é lembrado porque a busca executa até três processos, e a
   * interface pergunta pela disponibilidade a cada mudança de estado do painel
   * — sem o cache, seriam três `spawn` por atualização de tela. Python não
   * aparece nem some da máquina durante uma sessão do editor.
   */
  private async findSystemPython(): Promise<string | null> {
    this.systemPython ??= this.searchSystemPython();

    return this.systemPython;
  }

  private async searchSystemPython(): Promise<string | null> {
    const configured = vscode.workspace
      .getConfiguration('prometheon')
      .get<string>('speech.pythonPath');

    const candidates = configured ? [configured, ...PYTHON_CANDIDATES] : [...PYTHON_CANDIDATES];

    for (const candidate of candidates) {
      if (await this.satisfiesVersion(candidate)) {
        this.logger.info(`Ditado: usando ${candidate} para criar o ambiente.`);

        return candidate;
      }
    }

    return null;
  }

  private async satisfiesVersion(python: string): Promise<boolean> {
    try {
      const { stdout } = await run(
        python,
        ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'],
        { timeout: 15_000 },
      );

      const [major, minor] = stdout.trim().split(/\s+/).map(Number);

      if (major === undefined || minor === undefined) {
        return false;
      }

      return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
    } catch {
      // Candidato ausente do PATH, ou que não é Python. Segue para o próximo.
      return false;
    }
  }

  private async hasModules(python: string): Promise<boolean> {
    try {
      await run(python, ['-c', `import ${REQUIRED_MODULES.join(', ')}`], { timeout: 60_000 });

      return true;
    } catch {
      return false;
    }
  }
}
