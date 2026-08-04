import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Logger } from '../logger';
import { WorktreeService } from '../workspace/WorktreeService';

const run = promisify(execFile);

/**
 * Repositório de verdade num diretório temporário. Simular o git aqui não
 * provaria nada: o que precisa funcionar é `git worktree` na máquina do
 * usuário, com o git dele.
 */
async function repository(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'prometheon-wt-'));
  await run('git', ['init', '-b', 'main'], { cwd: folder });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: folder });
  await run('git', ['config', 'user.name', 'Test'], { cwd: folder });
  await writeFile(join(folder, 'a.txt'), 'primeiro\n', 'utf8');
  await run('git', ['add', '.'], { cwd: folder });
  await run('git', ['commit', '-m', 'inicial'], { cwd: folder });
  return folder;
}

suite('WorktreeService', () => {
  const created: string[] = [];

  suiteTeardown(async () => {
    for (const folder of created) {
      await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  });

  test('uma pasta sem git não vira worktree', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'prometheon-nogit-'));
    created.push(folder);
    const service = new WorktreeService(new Logger());
    assert.equal(await service.isRepository(folder), false);
  });

  test('cada agente recebe uma árvore e uma branch próprias', async () => {
    const folder = await repository();
    created.push(folder);
    const service = new WorktreeService(new Logger());

    const first = await service.create(folder, 'Pesquisador');
    const second = await service.create(folder, 'Testador');

    assert.notEqual(first.path, second.path);
    assert.notEqual(first.branch, second.branch);
    assert.ok(existsSync(join(first.path, 'a.txt')), 'a cópia começa do HEAD de quem delegou');
    assert.ok(existsSync(join(second.path, 'a.txt')));
    assert.match(first.branch, /^prometheon\//);
  });

  test('o trabalho de um agente não aparece na árvore do outro', async () => {
    // É a razão de tudo isto existir: sem isolamento, o segundo agente salvaria
    // por cima do arquivo que o primeiro está escrevendo.
    const folder = await repository();
    created.push(folder);
    const service = new WorktreeService(new Logger());

    const mine = await service.create(folder, 'Agente A');
    const other = await service.create(folder, 'Agente B');

    await writeFile(join(mine.path, 'a.txt'), 'mudado pelo A\n', 'utf8');

    const changes = await service.changes(mine);
    assert.deepEqual(changes.files, ['a.txt']);
    assert.match(changes.summary, /a\.txt/);

    // A árvore do outro continua como estava, e a de quem delegou também.
    assert.equal((await service.changes(other)).files.length, 0);
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: folder });
    assert.equal(stdout.trim(), '');
  });

  test('árvore intocada é removida; a que tem trabalho dentro fica', async () => {
    const folder = await repository();
    created.push(folder);
    const service = new WorktreeService(new Logger());

    const empty = await service.create(folder, 'Vazio');
    await service.remove(folder, empty);
    assert.equal(existsSync(empty.path), false);

    // Remover é decisão de quem chama: o serviço não julga o conteúdo, e é o
    // núcleo que só apaga o que não tem mudança.
    const busy = await service.create(folder, 'Ocupado');
    await writeFile(join(busy.path, 'a.txt'), 'trabalho\n', 'utf8');
    assert.equal((await service.changes(busy)).files.length, 1);
    assert.ok(existsSync(busy.path));
  });

  test('nomes com acento e espaço viram branch válida', async () => {
    const folder = await repository();
    created.push(folder);
    const service = new WorktreeService(new Logger());

    const worktree = await service.create(folder, 'Revisão Técnica 2');
    assert.equal(worktree.branch, 'prometheon/revisao-tecnica-2');
  });
});

suite('WorktreeService — provisionamento', () => {
  test('as dependências instaladas chegam à cópia', async () => {
    // Sem `node_modules`, o agente não roda typecheck, lint nem teste: a única
    // coisa que ele consegue dizer sobre o próprio trabalho é que o escreveu.
    const folder = await mkdtemp(join(tmpdir(), 'prometheon-dep-'));
    await run('git', ['init', '-b', 'main'], { cwd: folder });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: folder });
    await run('git', ['config', 'user.name', 'Test'], { cwd: folder });
    await writeFile(join(folder, 'a.txt'), 'x\n', 'utf8');
    await run('git', ['add', '.'], { cwd: folder });
    await run('git', ['commit', '-m', 'inicial'], { cwd: folder });

    // Uma na raiz e outra num pacote, como num monorepo. O pacote precisa ter
    // conteúdo versionado: uma pasta que só contém `node_modules` é colapsada
    // pelo git como um único item novo, e isso não acontece em repositório de
    // verdade.
    await mkdir(join(folder, 'node_modules', 'esbuild'), { recursive: true });
    await mkdir(join(folder, 'extension', 'node_modules', 'typescript'), { recursive: true });
    await writeFile(join(folder, 'extension', 'index.ts'), 'export {};\n', 'utf8');
    await run('git', ['add', 'extension/index.ts'], { cwd: folder });
    await run('git', ['commit', '-m', 'pacote'], { cwd: folder });

    const service = new WorktreeService(new Logger());
    const worktree = await service.create(folder, 'Programador');

    assert.ok(existsSync(join(worktree.path, 'node_modules', 'esbuild')));
    assert.ok(existsSync(join(worktree.path, 'extension', 'node_modules', 'typescript')));

    // E o link não vira mudança para o git: seria ruído em todo relatório.
    assert.equal((await service.changes(worktree)).files.length, 0);

    await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  });
});
