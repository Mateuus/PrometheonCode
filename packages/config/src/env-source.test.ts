import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectRawEnv,
  findWorkspaceRoot,
  WORKSPACE_MARKER,
} from './env-source.js';

/** Cria uma raiz de workspace falsa com um pacote aninhado. */
function makeWorkspace(): { root: string; packageDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'prometheon-config-'));
  const packageDir = join(root, 'packages', 'sample');

  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(root, WORKSPACE_MARKER), 'packages:\n  - "packages/*"\n');

  return { root, packageDir };
}

describe('findWorkspaceRoot', () => {
  it('walks up until it finds the workspace marker', () => {
    const { root, packageDir } = makeWorkspace();

    expect(findWorkspaceRoot(packageDir)).toBe(root);
  });

  it('returns undefined when there is no marker above', () => {
    expect(findWorkspaceRoot(tmpdir())).toBeUndefined();
  });
});

describe('collectRawEnv', () => {
  it('reads the root .env from a nested package directory', () => {
    const { root, packageDir } = makeWorkspace();

    writeFileSync(join(root, '.env'), 'FROM_FILE=yes\nSHARED=file\n');

    const result = collectRawEnv({
      cwd: packageDir,
      processEnv: {},
      nodeEnv: 'development',
    });

    expect(result.workspaceRoot).toBe(root);
    expect(result.raw['FROM_FILE']).toBe('yes');
    expect(result.envFiles).toEqual([join(root, '.env')]);
  });

  it('lets process.env win over the file', () => {
    const { root, packageDir } = makeWorkspace();

    writeFileSync(join(root, '.env'), 'SHARED=file\n');

    const result = collectRawEnv({
      cwd: packageDir,
      processEnv: { SHARED: 'process' },
      nodeEnv: 'development',
    });

    expect(result.raw['SHARED']).toBe('process');
  });

  it('lets .env.<NODE_ENV> win over .env', () => {
    const { root, packageDir } = makeWorkspace();

    writeFileSync(join(root, '.env'), 'SHARED=base\n');
    writeFileSync(join(root, '.env.test'), 'SHARED=test\n');

    const result = collectRawEnv({
      cwd: packageDir,
      processEnv: {},
      nodeEnv: 'test',
    });

    expect(result.raw['SHARED']).toBe('test');
    expect(result.envFiles).toHaveLength(2);
  });

  it('drops empty values so they count as missing', () => {
    const { root, packageDir } = makeWorkspace();

    writeFileSync(join(root, '.env'), 'BLANK=\nSPACES=   \n');

    const result = collectRawEnv({
      cwd: packageDir,
      processEnv: {},
      nodeEnv: 'development',
    });

    expect(result.raw['BLANK']).toBeUndefined();
    expect(result.raw['SPACES']).toBeUndefined();
  });

  it('ignores files entirely in production', () => {
    const { root, packageDir } = makeWorkspace();

    writeFileSync(join(root, '.env'), 'FROM_FILE=yes\n');

    const result = collectRawEnv({
      cwd: packageDir,
      processEnv: { NODE_ENV: 'production' },
    });

    expect(result.raw['FROM_FILE']).toBeUndefined();
    expect(result.envFiles).toEqual([]);
  });
});
