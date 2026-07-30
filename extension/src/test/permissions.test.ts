import * as assert from 'node:assert/strict';
import { evaluatePermission } from '../permissions/PermissionPolicy';
import {
  EMPTY_PROJECT_POLICY,
  type PermissionContext,
  type ProjectPolicy,
} from '../permissions/types';
import type { BypassGrant } from '../core/types';

function context(patch: Partial<PermissionContext> = {}): PermissionContext {
  return {
    workMode: 'edit',
    autonomy: 'manual',
    bypass: null,
    projectPolicy: EMPTY_PROJECT_POLICY,
    ...patch,
  };
}

const projectBypass: BypassGrant = {
  scope: 'current-project',
  duration: 'current-session',
  grantedAt: 0,
  workspaceKey: null,
};

suite('Precedência de permissões', () => {
  test('a política do projeto nega mesmo com bypass ativo', () => {
    const policy: ProjectPolicy = { deny: ['terminal.run'], ask: [] };
    const result = evaluatePermission(
      { action: 'terminal.run' },
      context({ autonomy: 'bypass', bypass: projectBypass, projectPolicy: policy }),
    );

    assert.equal(result.decision, 'deny');
    assert.equal(result.source, 'project-policy');
  });

  test('o modo Plan bloqueia qualquer mutação, inclusive com bypass', () => {
    for (const action of ['file.write', 'terminal.run', 'git.write'] as const) {
      const result = evaluatePermission(
        { action },
        context({ workMode: 'plan', autonomy: 'bypass', bypass: projectBypass }),
      );
      assert.equal(result.decision, 'deny', `esperava deny para ${action}`);
      assert.equal(result.source, 'work-mode');
    }
  });

  test('leitura é liberada em qualquer modo', () => {
    const result = evaluatePermission({ action: 'file.read' }, context({ workMode: 'plan' }));
    assert.equal(result.decision, 'allow');
    assert.equal(result.source, 'safe-action');
  });

  test('o "ask" do projeto vence o bypass', () => {
    const policy: ProjectPolicy = { deny: [], ask: ['file.write'] };
    const result = evaluatePermission(
      { action: 'file.write' },
      context({ autonomy: 'bypass', bypass: projectBypass, projectPolicy: policy }),
    );

    assert.equal(result.decision, 'ask');
    assert.equal(result.source, 'project-policy');
  });

  test('git.init e hub.network sempre pedem confirmação', () => {
    for (const action of ['git.init', 'hub.network'] as const) {
      const result = evaluatePermission(
        { action },
        context({ autonomy: 'bypass', bypass: projectBypass }),
      );
      assert.equal(result.decision, 'ask', `esperava ask para ${action}`);
      assert.equal(result.source, 'always-ask');
    }
  });

  test('bypass no escopo do projeto libera escrita e terminal', () => {
    for (const action of ['file.write', 'terminal.run'] as const) {
      const result = evaluatePermission(
        { action },
        context({ autonomy: 'bypass', bypass: projectBypass }),
      );
      assert.equal(result.decision, 'allow', `esperava allow para ${action}`);
      assert.equal(result.source, 'bypass');
    }
  });

  test('o escopo agent-worktrees só cobre alvos dentro de um worktree', () => {
    const worktreeBypass: BypassGrant = { ...projectBypass, scope: 'agent-worktrees' };

    const inside = evaluatePermission(
      { action: 'file.write', target: 'C:/repo/.prometheon/worktrees/task-1/src/a.ts' },
      context({ autonomy: 'bypass', bypass: worktreeBypass }),
    );
    assert.equal(inside.decision, 'allow');
    assert.equal(inside.source, 'bypass');

    const outside = evaluatePermission(
      { action: 'file.write', target: 'C:/repo/src/a.ts' },
      context({ autonomy: 'bypass', bypass: worktreeBypass }),
    );
    assert.equal(outside.decision, 'ask');

    const withoutTarget = evaluatePermission(
      { action: 'file.write' },
      context({ autonomy: 'bypass', bypass: worktreeBypass }),
    );
    assert.equal(withoutTarget.decision, 'ask', 'sem alvo não se pode assumir worktree');
  });

  test('autonomia Auto libera escrita e pausa em ações de risco', () => {
    const write = evaluatePermission({ action: 'file.write' }, context({ autonomy: 'auto' }));
    assert.equal(write.decision, 'allow');
    assert.equal(write.source, 'autonomy');

    const terminal = evaluatePermission({ action: 'terminal.run' }, context({ autonomy: 'auto' }));
    assert.equal(terminal.decision, 'ask');
  });

  test('autonomia Manual pergunta em tudo que não é seguro', () => {
    const result = evaluatePermission({ action: 'file.write' }, context({ autonomy: 'manual' }));
    assert.equal(result.decision, 'ask');
    assert.equal(result.source, 'autonomy');
  });

  test('autonomia bypass sem concessão volta a perguntar', () => {
    // É o estado após um reinício: o nível ficou registrado em algum lugar, mas
    // a concessão não existe mais.
    const result = evaluatePermission(
      { action: 'file.write' },
      context({ autonomy: 'bypass', bypass: null }),
    );
    assert.equal(result.decision, 'ask');
    assert.equal(result.source, 'autonomy');
  });

  test('delegar exige o modo Agent Team', () => {
    assert.equal(
      evaluatePermission({ action: 'agent.delegate' }, context({ workMode: 'edit' })).decision,
      'deny',
    );
    assert.equal(
      evaluatePermission({ action: 'agent.delegate' }, context({ workMode: 'agent-team' })).decision,
      'ask',
    );
    assert.equal(
      evaluatePermission(
        { action: 'agent.delegate' },
        context({ workMode: 'agent-team', autonomy: 'bypass', bypass: projectBypass }),
      ).decision,
      'allow',
    );
  });
});
