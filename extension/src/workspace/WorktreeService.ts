import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import type { Logger } from '../logger';

const run = promisify(execFile);

/**
 * Cópias isoladas do repositório, uma por agente que edita arquivos.
 *
 * Dois agentes trabalhando na mesma árvore se sobrescrevem sem aviso: o
 * segundo lê o arquivo que o primeiro ainda está escrevendo, salva por cima, e
 * ninguém vê o que se perdeu. O `git worktree` resolve isso do jeito que o
 * `agent-orchestrator` resolve — cada um recebe uma árvore física própria, com
 * a sua branch, e o encontro do trabalho acontece no merge, onde o git sabe
 * mostrar conflito em vez de escolher um vencedor em silêncio.
 *
 * O que isto **não** faz é permitir que dois agentes editem a mesma função ao
 * mesmo tempo: cada um vê apenas a própria cópia. Trabalho que se cruza no
 * mesmo trecho precisa ser sequenciado, ou dividido em pedaços que não se
 * tocam — isolamento evita a perda silenciosa, não a colisão de intenção.
 */

export interface Worktree {
  /** Caminho absoluto da árvore isolada. */
  readonly path: string;
  readonly branch: string;
}

export interface WorktreeChanges {
  /** Arquivos tocados, como o git os reporta. */
  readonly files: readonly string[];
  /** Resumo de linhas por arquivo, pronto para exibir. */
  readonly summary: string;
  readonly commits: number;
}

/** Pasta das cópias, dentro do estado local do workspace (fora do versionamento). */
const WORKTREE_ROOT = join('.prometheon', 'worktrees');

export class WorktreeService {
  constructor(private readonly logger: Logger) {}

  /** Há repositório git aqui? Sem ele não existe worktree. */
  async isRepository(folder: string): Promise<boolean> {
    try {
      const { stdout } = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: folder });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Cria a cópia isolada e a branch do agente.
   *
   * A branch nasce do `HEAD` de quem delegou: o worker começa exatamente do
   * código que o orquestrador está vendo, e não de um ponto qualquer da
   * história.
   */
  async create(folder: string, label: string): Promise<Worktree> {
    const branch = `prometheon/${slug(label)}`;
    const path = join(folder, WORKTREE_ROOT, slug(label));

    await this.hideFromGit(folder);
    // `--force` cobre o caso de a pasta ter sobrado de uma execução anterior
    // que morreu antes de limpar; a branch com `-B` é recriada no HEAD atual.
    await run('git', ['worktree', 'add', '--force', '-B', branch, path, 'HEAD'], { cwd: folder });
    await this.provision(folder, path);
    this.logger.info(`Worktree: ${branch} em ${path}.`);
    return { path, branch };
  }

  /**
   * Liga as dependências já instaladas à cópia nova.
   *
   * Um worktree nasce com o código versionado e nada mais — sem `node_modules`,
   * o agente não roda typecheck, lint nem teste, e a única coisa que ele pode
   * dizer sobre o próprio trabalho é que o escreveu. Instalar de novo custaria
   * minutos e gigabytes por delegação; um link resolve em milissegundos.
   *
   * No Windows a junção dispensa privilégio de administrador, ao contrário do
   * link simbólico — é a diferença entre funcionar na máquina de todo mundo e
   * funcionar só em modo desenvolvedor.
   */
  private async provision(folder: string, target: string): Promise<void> {
    for (const relative of await this.dependencyFolders(folder)) {
      const source = join(folder, relative);
      const link = join(target, relative);
      try {
        await mkdir(dirname(link), { recursive: true });
        // `symlink` já falha quando o destino existe: checar antes só criaria
        // uma janela entre a checagem e a criação.
        await symlink(source, link, 'junction');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          continue;
        }
        // Sem as dependências o agente ainda trabalha; ele é que não vai
        // conseguir provar que o trabalho compila, e vai dizer isso.
        this.logger.warn(`Worktree: não consegui ligar ${relative} (${String(error)}).`);
      }
    }
  }

  /**
   * Onde há `node_modules` neste repositório: na raiz e um nível abaixo. Basta
   * para monorepos como este, em que cada app instala o seu.
   */
  private async dependencyFolders(folder: string): Promise<readonly string[]> {
    const found: string[] = [];
    if (existsSync(join(folder, 'node_modules'))) {
      found.push('node_modules');
    }
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      if (existsSync(join(folder, entry.name, 'node_modules'))) {
        found.push(join(entry.name, 'node_modules'));
      }
    }
    return found;
  }

  /** O que o agente mudou na cópia dele. */
  async changes(worktree: Worktree): Promise<WorktreeChanges> {
    const [status, diff, log] = await Promise.all([
      this.git(worktree.path, ['status', '--porcelain']),
      this.git(worktree.path, ['diff', '--stat', 'HEAD']),
      this.git(worktree.path, ['rev-list', '--count', `HEAD@{upstream}..HEAD`]).catch(() => ''),
    ]);

    const files = status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== '')
      // As dependências que ligamos não são trabalho do agente. No Linux e no
      // macOS o link aparece como arquivo novo, e sem isto todo relatório
      // começaria dizendo que ele criou `node_modules`.
      .filter((file) => !file.split('/').includes('node_modules'));

    return {
      files,
      summary: diff.trim(),
      commits: Number.parseInt(log.trim(), 10) || 0,
    };
  }

  /**
   * Remove a cópia. Só é chamado quando nada foi alterado — trabalho de agente
   * não é apagado por conta própria.
   *
   * No Windows, `worktree remove` falha com "Filename too long" quando a cópia
   * tem `node_modules` aninhado. Aqui isso não acontece porque só removemos
   * árvores intocadas, mas a falha é registrada e engolida: uma pasta órfã é
   * um incômodo, não um motivo para derrubar a delegação inteira.
   */
  async remove(folder: string, worktree: Worktree): Promise<void> {
    try {
      await run('git', ['worktree', 'remove', '--force', worktree.path], { cwd: folder });
      await run('git', ['branch', '-D', worktree.branch], { cwd: folder });
    } catch (error) {
      this.logger.warn(`Worktree: não consegui remover ${worktree.path} (${String(error)}).`);
    }
  }

  /**
   * Faz o git ignorar as cópias, sem tocar na configuração do usuário.
   *
   * Um `.gitignore` com `*` **dentro** da própria pasta esconde tudo o que há
   * ali, inclusive a si mesmo. É a alternativa a editar o `.gitignore` do
   * repositório de quem nos usa — coisa que uma extensão não deveria fazer.
   * Sem isto, cada agente que trabalha deixa uma pasta pendurada no `git
   * status` de quem só queria ver as próprias mudanças.
   */
  private async hideFromGit(folder: string): Promise<void> {
    const root = join(folder, WORKTREE_ROOT);
    await mkdir(root, { recursive: true });
    try {
      // `wx` cria ou falha; perguntar antes se existe abriria uma janela entre
      // a pergunta e a escrita — e nela cabe o arquivo que alguém acabou de
      // ajustar à mão, sobrescrito sem aviso.
      await writeFile(join(root, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await run('git', [...args], { cwd, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
}

/** Nome de pasta e de branch a partir do rótulo do agente. */
function slug(label: string): string {
  const cleaned = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'agent' : cleaned;
}
