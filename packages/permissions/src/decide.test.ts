import { describe, expect, it } from 'vitest';
import { authorize, can } from './decide.js';
import { ROLES, ROLE_PERMISSIONS, outranks, permissionsOf } from './roles.js';

describe('precedência de autorização', () => {
  it('a política da organização nega mesmo o owner', () => {
    const decision = authorize({
      permission: 'agent.start_remote',
      role: 'owner',
      organizationPolicy: { deny: ['agent.start_remote'] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.layer).toBe('organization');
  });

  it('uma camada inferior não libera o que a superior nega', () => {
    // Concessão direta ao usuário e permissão do agente não revertem a negação
    // do projeto — é a regra central do documento de segurança.
    const decision = authorize({
      permission: 'chat.write',
      role: 'admin',
      projectPolicy: { deny: ['chat.write'] },
      userGrants: ['chat.write'],
      agentAllows: ['chat.write'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.layer).toBe('project');
  });

  it('não-membro não herda nada', () => {
    const decision = authorize({ permission: 'chat.read' });
    expect(decision.allowed).toBe(false);
    expect(decision.layer).toBe('membership');
  });

  it('o modo Plan bloqueia o que muda o estado, mas não a leitura', () => {
    expect(can({ permission: 'task.create', role: 'admin', chatMode: 'plan' })).toBe(false);
    expect(can({ permission: 'chat.read', role: 'viewer', chatMode: 'plan' })).toBe(true);
  });

  it('o perfil do agente restringe dentro do que o usuário já podia', () => {
    expect(
      can({ permission: 'agent.start_remote', role: 'admin', agentAllows: ['chat.read'] }),
    ).toBe(false);
    expect(
      can({ permission: 'chat.read', role: 'admin', agentAllows: ['chat.read'] }),
    ).toBe(true);
  });

  it('a lista allow restringe sem precisar enumerar negações', () => {
    const decision = authorize({
      permission: 'project.create',
      role: 'owner',
      organizationPolicy: { allow: ['chat.read', 'chat.write'] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('does not include');
  });

  it('concessão ao usuário complementa o papel', () => {
    expect(can({ permission: 'audit.read', role: 'developer' })).toBe(false);
    expect(can({ permission: 'audit.read', role: 'developer', userGrants: ['audit.read'] })).toBe(
      true,
    );
  });
});

describe('papéis', () => {
  it('owner tem todas as permissões', () => {
    expect(permissionsOf('owner')).toHaveLength(ROLE_PERMISSIONS.owner.length);
    for (const role of ROLES) {
      for (const permission of permissionsOf(role)) {
        expect(permissionsOf('owner')).toContain(permission);
      }
    }
  });

  it('viewer não escreve em lugar nenhum', () => {
    const writes = permissionsOf('viewer').filter((permission) => permission.includes('.write'));
    expect(writes).toEqual([]);
  });

  it('senioridade é estrita: um papel não administra o próprio nível', () => {
    expect(outranks('admin', 'developer')).toBe(true);
    expect(outranks('admin', 'admin')).toBe(false);
    expect(outranks('developer', 'admin')).toBe(false);
  });
});
