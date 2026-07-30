import { describe, expect, it } from 'vitest';

import { auditListQuerySchema, auditLogSchema } from './audit.js';
import {
  deviceAuthorizationRequestSchema,
  deviceAuthorizationResponseSchema,
  deviceCredentialSchema,
  loginRequestSchema,
  meResponseSchema,
  passwordResetConfirmSchema,
  registerRequestSchema,
  tokenPairSchema,
} from './auth.js';
import {
  changePlanRequestSchema,
  FREE_PLAN,
  planListSchema,
  planSchema,
  subscriptionOverviewSchema,
} from './billing.js';
import { createConversationRequestSchema, conversationSchema } from './conversations.js';
import {
  deviceHeartbeatRequestSchema,
  registerDeviceRequestSchema,
} from './devices.js';
import {
  ERROR_CODES,
  errorEnvelopeSchema,
  responseMetaSchema,
  successEnvelope,
} from './envelope.js';
import {
  createKnowledgeProposalSchema,
  knowledgeReviewRequestSchema,
} from './knowledge.js';
import {
  createMessageRequestSchema,
  messagePartSchema,
  messageSchema,
} from './messages.js';
import {
  createOrganizationRequestSchema,
  createInvitationRequestSchema,
  organizationMemberSchema,
  updateMemberRequestSchema,
} from './organizations.js';
import {
  cursorPageQuerySchema,
  cursorPageSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './pagination.js';
import {
  ORGANIZATION_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleHasPermission,
} from './permissions.js';
import {
  emailSchema,
  isoDateTimeSchema,
  moneySchema,
  slugSchema,
  ulidSchema,
} from './primitives.js';
import { createProjectRequestSchema, projectSchema } from './projects.js';
import {
  clientMessageSchema,
  REALTIME_EVENT_TYPES,
  realtimeEventSchema,
  serverMessageSchema,
} from './realtime.js';
import {
  claimTaskRequestSchema,
  createTaskRequestSchema,
  taskSchema,
} from './tasks.js';

const ULID_A = '01JAV3B8QK5Z9TQW2M4X6YFHNP';
const ULID_B = '01JAV3B8QK5Z9TQW2M4X6YFHNQ';
const ULID_C = '01JAV3B8QK5Z9TQW2M4X6YFHNR';
const NOW = '2026-07-30T15:00:00.000Z';

const publicUser = {
  id: ULID_A,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  avatarUrl: null,
};

describe('primitives', () => {
  it('accepts a canonical ULID and rejects anything else', () => {
    expect(ulidSchema.safeParse(ULID_A).success).toBe(true);
    expect(ulidSchema.safeParse('not-an-ulid').success).toBe(false);
    // Letras excluídas do alfabeto Crockford.
    expect(ulidSchema.safeParse('01JAV3B8QK5Z9TQW2M4X6YFHNI').success).toBe(false);
    // 25 caracteres.
    expect(ulidSchema.safeParse(ULID_A.slice(0, 25)).success).toBe(false);
    expect(ulidSchema.safeParse(ULID_A.toLowerCase()).success).toBe(false);
  });

  it('requires UTC on date-times', () => {
    expect(isoDateTimeSchema.safeParse(NOW).success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-07-30T15:00:00-03:00').success).toBe(
      false,
    );
    expect(isoDateTimeSchema.safeParse('30/07/2026').success).toBe(false);
  });

  it('normalises email and slug', () => {
    expect(emailSchema.parse('  ADA@Example.COM ')).toBe('ada@example.com');
    expect(slugSchema.parse('My-Project')).toBe('my-project');
    expect(slugSchema.safeParse('my project').success).toBe(false);
    expect(slugSchema.safeParse('-leading').success).toBe(false);
  });

  it('keeps money as an integer in the smallest unit', () => {
    expect(moneySchema.parse({ amount: 0, currency: 'usd' })).toEqual({
      amount: 0,
      currency: 'USD',
    });
    expect(moneySchema.safeParse({ amount: 9.9, currency: 'USD' }).success).toBe(
      false,
    );
    expect(moneySchema.safeParse({ amount: 100, currency: 'DOLLAR' }).success).toBe(
      false,
    );
  });
});

describe('envelopes', () => {
  it('wraps data with the request id', () => {
    const envelope = successEnvelope(projectSchema.pick({ id: true }));
    const parsed = envelope.parse({
      data: { id: ULID_A },
      meta: { requestId: 'req_01JAV3' },
    });

    expect(parsed.meta.requestId).toBe('req_01JAV3');
  });

  it('rejects a success envelope without meta', () => {
    const envelope = successEnvelope(responseMetaSchema);

    expect(envelope.safeParse({ data: { requestId: 'x' } }).success).toBe(false);
  });

  it('validates the error envelope and its code', () => {
    const parsed = errorEnvelopeSchema.parse({
      error: {
        code: 'PROJECT_ACCESS_DENIED',
        message: 'You do not have access to this project.',
        requestId: 'req_01JAV3',
      },
    });

    expect(parsed.error.code).toBe('PROJECT_ACCESS_DENIED');
    expect(
      errorEnvelopeSchema.safeParse({
        error: { code: 'WHATEVER', message: 'x', requestId: 'y' },
      }).success,
    ).toBe(false);
  });

  it('keeps the error code list free of duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('cursor pagination', () => {
  it('applies defaults and coerces the limit from the query string', () => {
    expect(cursorPageQuerySchema.parse({})).toEqual({
      limit: DEFAULT_PAGE_SIZE,
      direction: 'desc',
    });
    expect(cursorPageQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('refuses a page larger than the maximum', () => {
    expect(
      cursorPageQuerySchema.safeParse({ limit: String(MAX_PAGE_SIZE + 1) }).success,
    ).toBe(false);
    expect(cursorPageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('validates a page of items', () => {
    const page = cursorPageSchema(projectSchema.pick({ id: true }));

    expect(
      page.parse({
        items: [{ id: ULID_A }],
        pageInfo: { nextCursor: 'c2', previousCursor: null, hasMore: true },
      }).items,
    ).toHaveLength(1);
    expect(
      page.safeParse({ items: [], pageInfo: { hasMore: false } }).success,
    ).toBe(false);
  });
});

describe('roles and permissions', () => {
  it('gives the owner every permission', () => {
    expect(ROLE_PERMISSIONS.owner).toHaveLength(PERMISSIONS.length);

    for (const permission of PERMISSIONS) {
      expect(roleHasPermission('owner', permission)).toBe(true);
    }
  });

  it('keeps the viewer read only', () => {
    expect(roleHasPermission('viewer', 'chat.read')).toBe(true);
    expect(roleHasPermission('viewer', 'chat.write')).toBe(false);
    expect(roleHasPermission('viewer', 'organization.manage')).toBe(false);
  });

  it('never grants organization.manage outside the owner', () => {
    for (const role of ORGANIZATION_ROLES) {
      if (role !== 'owner') {
        expect(roleHasPermission(role, 'organization.manage')).toBe(false);
      }
    }
  });

  it('lets the reviewer review but not approve', () => {
    expect(roleHasPermission('reviewer', 'knowledge.review')).toBe(true);
    expect(roleHasPermission('reviewer', 'knowledge.approve')).toBe(false);
    expect(roleHasPermission('maintainer', 'knowledge.approve')).toBe(true);
  });
});

describe('auth contracts', () => {
  it('accepts a complete registration', () => {
    const parsed = registerRequestSchema.parse({
      name: 'Ada Lovelace',
      email: 'ADA@example.com',
      password: 'correct horse battery staple',
      organizationName: 'Analytical Engines',
      acceptedTerms: true,
    });

    expect(parsed.email).toBe('ada@example.com');
  });

  it('refuses a short password and unaccepted terms', () => {
    const base = {
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
      acceptedTerms: true,
    };

    expect(registerRequestSchema.safeParse({ ...base, password: 'short' }).success).toBe(
      false,
    );
    expect(
      registerRequestSchema.safeParse({ ...base, acceptedTerms: false }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ ...base, email: 'not-an-email' }).success,
    ).toBe(false);
  });

  it('validates login and the token pair', () => {
    expect(
      loginRequestSchema.safeParse({
        email: 'ada@example.com',
        password: 'correct horse battery staple',
      }).success,
    ).toBe(true);

    const tokens = tokenPairSchema.parse({
      tokenType: 'Bearer',
      accessToken: 'at',
      expiresIn: 900,
    });

    expect(tokens.refreshToken).toBeUndefined();
    expect(
      tokenPairSchema.safeParse({
        tokenType: 'Token',
        accessToken: 'at',
        expiresIn: 900,
      }).success,
    ).toBe(false);
  });

  it('describes the current session', () => {
    const parsed = meResponseSchema.parse({
      user: {
        ...publicUser,
        emailVerified: true,
        locale: 'pt-BR',
        timeZone: 'America/Sao_Paulo',
        createdAt: NOW,
        updatedAt: NOW,
      },
      organizations: [
        { id: ULID_B, name: 'Analytical Engines', slug: 'analytical-engines', role: 'owner' },
      ],
      activeOrganizationId: ULID_B,
    });

    expect(parsed.organizations[0]?.role).toBe('owner');
  });

  it('validates the password recovery flow', () => {
    expect(
      passwordResetConfirmSchema.safeParse({
        token: 'a'.repeat(32),
        password: 'correct horse battery staple',
      }).success,
    ).toBe(true);
    expect(
      passwordResetConfirmSchema.safeParse({ token: 'short', password: 'correct horse battery staple' })
        .success,
    ).toBe(false);
  });

  it('validates the device flow round trip', () => {
    expect(
      deviceAuthorizationRequestSchema.safeParse({
        deviceName: 'Notebook do Mateus',
        deviceKind: 'vscode',
        clientVersion: '0.1.0',
      }).success,
    ).toBe(true);

    expect(
      deviceAuthorizationRequestSchema.safeParse({
        deviceName: 'x',
        deviceKind: 'toaster',
      }).success,
    ).toBe(false);

    expect(
      deviceAuthorizationResponseSchema.safeParse({
        deviceCode: 'd'.repeat(40),
        userCode: 'ABCD-1234',
        verificationUri: 'https://hub.example.com/device',
        verificationUriComplete: 'https://hub.example.com/device?code=ABCD-1234',
        expiresIn: 600,
        interval: 5,
      }).success,
    ).toBe(true);

    expect(
      deviceCredentialSchema.safeParse({
        deviceId: ULID_A,
        deviceToken: 'token',
        expiresAt: null,
        organizationId: ULID_B,
        user: publicUser,
      }).success,
    ).toBe(true);
  });
});

describe('organization contracts', () => {
  it('creates an organization with an optional slug', () => {
    expect(createOrganizationRequestSchema.parse({ name: 'Acme' }).slug).toBeUndefined();
    expect(
      createOrganizationRequestSchema.parse({ name: 'Acme', slug: 'ACME' }).slug,
    ).toBe('acme');
  });

  it('requires the version when changing a member', () => {
    expect(updateMemberRequestSchema.safeParse({ role: 'admin' }).success).toBe(
      false,
    );
    expect(
      updateMemberRequestSchema.safeParse({ role: 'admin', version: 3 }).success,
    ).toBe(true);
    expect(
      updateMemberRequestSchema.safeParse({ role: 'root', version: 3 }).success,
    ).toBe(false);
  });

  it('defaults invitation projects to an empty list', () => {
    const parsed = createInvitationRequestSchema.parse({
      email: 'new@example.com',
      role: 'developer',
    });

    expect(parsed.projectIds).toEqual([]);
  });

  it('validates a member record', () => {
    expect(
      organizationMemberSchema.safeParse({
        id: ULID_A,
        organizationId: ULID_B,
        user: publicUser,
        role: 'maintainer',
        status: 'active',
        invitedBy: null,
        joinedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
      }).success,
    ).toBe(true);
  });
});

describe('project, conversation and message contracts', () => {
  it('applies project defaults', () => {
    const parsed = createProjectRequestSchema.parse({ name: 'Hub' });

    expect(parsed.visibility).toBe('organization');
    expect(parsed.tags).toEqual([]);
  });

  it('validates a conversation envelope', () => {
    expect(
      conversationSchema.safeParse({
        id: ULID_A,
        organizationId: ULID_B,
        projectId: ULID_C,
        title: 'Refatorar o parser',
        status: 'open',
        origin: 'web',
        participants: [],
        lastSequence: 4,
        lastMessageAt: NOW,
        messageCount: 5,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: ULID_A,
        version: 2,
      }).success,
    ).toBe(true);

    expect(createConversationRequestSchema.parse({}).origin).toBe('web');
  });

  it('accepts every documented message part type', () => {
    const parts = [
      { index: 0, type: 'text', text: 'olá' },
      { index: 1, type: 'reasoning_summary', summary: 'planejou os passos' },
      {
        index: 2,
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'read_file',
        arguments: { path: 'src/index.ts' },
      },
      {
        index: 3,
        type: 'tool_result',
        toolCallId: 'call_1',
        status: 'ok',
        result: { bytes: 120 },
        output: 'conteúdo',
      },
      {
        index: 4,
        type: 'artifact_reference',
        artifactId: ULID_A,
        kind: 'diff',
        title: 'patch',
        byteSize: 42,
      },
      { index: 5, type: 'task_reference', taskId: ULID_B, relation: 'created' },
      { index: 6, type: 'error', code: 'TOOL_FAILED', message: 'falhou', retryable: true },
    ];

    for (const part of parts) {
      expect(messagePartSchema.safeParse(part).success).toBe(true);
    }
  });

  it('rejects an unknown part type and a malformed part', () => {
    expect(
      messagePartSchema.safeParse({ index: 0, type: 'video', url: 'x' }).success,
    ).toBe(false);
    expect(
      messagePartSchema.safeParse({ index: 0, type: 'tool_call', toolName: 'x' })
        .success,
    ).toBe(false);
  });

  it('validates a full message envelope with parts', () => {
    expect(
      messageSchema.safeParse({
        id: ULID_A,
        conversationId: ULID_B,
        organizationId: ULID_C,
        authorType: 'agent',
        authorUser: null,
        authorAgentRunId: ULID_A,
        status: 'complete',
        sequence: 7,
        parts: [{ index: 0, type: 'text', text: 'pronto' }],
        contextRefs: [{ kind: 'file', reference: 'src/app.ts', label: null }],
        attachments: [],
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
  });

  it('creates a message without asking the client for the part index', () => {
    const parsed = createMessageRequestSchema.parse({
      parts: [{ type: 'text', text: 'olá' }],
    });

    expect(parsed.parts).toHaveLength(1);
    expect(parsed.contextRefs).toEqual([]);
    expect(createMessageRequestSchema.safeParse({ parts: [] }).success).toBe(false);
  });
});

describe('task and knowledge contracts', () => {
  it('applies task defaults and validates the claim', () => {
    const parsed = createTaskRequestSchema.parse({ title: 'Migrar o schema' });

    expect(parsed.priority).toBe('normal');
    expect(parsed.dependsOn).toEqual([]);
    expect(claimTaskRequestSchema.parse({}).leaseSeconds).toBe(900);
    expect(claimTaskRequestSchema.safeParse({ leaseSeconds: 0 }).success).toBe(
      false,
    );
  });

  it('validates a task with a scope reservation', () => {
    expect(
      taskSchema.safeParse({
        id: ULID_A,
        organizationId: ULID_B,
        projectId: ULID_C,
        title: 'Migrar o schema',
        description: null,
        status: 'claimed',
        priority: 'high',
        tags: ['db'],
        assigneeType: 'agent',
        assignee: null,
        assignedAgentProfileId: ULID_A,
        dependsOn: [],
        scope: { paths: ['packages/database/**'], exclusive: true },
        claim: {
          claimedBy: 'agent',
          userId: null,
          agentRunId: ULID_B,
          deviceId: ULID_C,
          claimedAt: NOW,
          expiresAt: NOW,
        },
        conversationId: null,
        dueAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: ULID_A,
        version: 1,
      }).success,
    ).toBe(true);
  });

  it('validates a knowledge proposal and its review', () => {
    const proposal = createKnowledgeProposalSchema.parse({
      title: 'Usar ULID em todos os IDs',
      kind: 'decision',
      content: '# Decisão\n\nULID em string.',
    });

    expect(proposal.sources).toEqual([]);
    expect(
      knowledgeReviewRequestSchema.safeParse({ decision: 'approve', version: 1 })
        .success,
    ).toBe(true);
    expect(
      knowledgeReviewRequestSchema.safeParse({ decision: 'maybe', version: 1 })
        .success,
    ).toBe(false);
    expect(
      createKnowledgeProposalSchema.safeParse({
        title: 'x',
        kind: 'unknown-kind',
        content: 'y',
      }).success,
    ).toBe(false);
  });
});

describe('device and audit contracts', () => {
  it('validates registration and heartbeat', () => {
    expect(
      registerDeviceRequestSchema.safeParse({
        name: 'Notebook',
        kind: 'vscode',
        installationId: 'inst-0123456789',
      }).success,
    ).toBe(true);

    expect(deviceHeartbeatRequestSchema.parse({ status: 'online' })).toEqual({
      status: 'online',
      projectIds: [],
      activeAgentRunIds: [],
    });

    expect(
      deviceHeartbeatRequestSchema.safeParse({ status: 'offline' }).success,
    ).toBe(false);
  });

  it('validates an audit entry and its filters', () => {
    expect(
      auditLogSchema.safeParse({
        id: ULID_A,
        organizationId: ULID_B,
        actorType: 'user',
        actorUser: publicUser,
        actorDeviceId: null,
        action: 'project.created',
        resourceType: 'project',
        resourceId: ULID_C,
        projectId: ULID_C,
        ipAddress: '203.0.113.9',
        userAgent: null,
        requestId: 'req_1',
        metadata: { name: 'Hub' },
        createdAt: NOW,
      }).success,
    ).toBe(true);

    expect(auditListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(
      auditListQuerySchema.safeParse({ resourceType: 'spaceship' }).success,
    ).toBe(false);
  });
});

describe('plans and subscription', () => {
  it('ships a single free plan that already fits a multi plan catalogue', () => {
    expect(planSchema.safeParse(FREE_PLAN).success).toBe(true);
    expect(FREE_PLAN.price.amount).toBe(0);
    expect(FREE_PLAN.isDefault).toBe(true);

    const catalogue = planListSchema.parse({
      plans: [
        FREE_PLAN,
        {
          ...FREE_PLAN,
          code: 'team',
          name: 'Team',
          price: { amount: 4900, currency: 'USD' },
          limits: { ...FREE_PLAN.limits, maxMembers: null },
          isDefault: false,
          sortOrder: 1,
        },
      ],
    });

    expect(catalogue.plans).toHaveLength(2);
    expect(catalogue.plans[1]?.limits.maxMembers).toBeNull();
  });

  it('rejects a fractional price', () => {
    expect(
      planSchema.safeParse({ ...FREE_PLAN, price: { amount: 49.9, currency: 'USD' } })
        .success,
    ).toBe(false);
  });

  it('validates the subscription overview and a plan change', () => {
    expect(
      subscriptionOverviewSchema.safeParse({
        subscription: {
          id: ULID_A,
          organizationId: ULID_B,
          planCode: 'free',
          status: 'active',
          seats: null,
          currentPeriodStart: NOW,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          createdAt: NOW,
          updatedAt: NOW,
          version: 1,
        },
        plan: FREE_PLAN,
        usage: {
          members: 2,
          projects: 1,
          devices: 3,
          concurrentAgentRuns: 0,
          monthlyAgentMinutes: 12,
          storageBytes: 1024,
          measuredAt: NOW,
        },
      }).success,
    ).toBe(true);

    expect(
      changePlanRequestSchema.safeParse({ planCode: 'team', version: 1 }).success,
    ).toBe(true);
  });
});

describe('realtime protocol', () => {
  const envelope = {
    id: ULID_A,
    version: 1,
    organizationId: ULID_B,
    projectId: ULID_C,
    occurredAt: NOW,
    cursor: '00000000000000000042',
  };

  it('lists exactly the documented event types', () => {
    expect(REALTIME_EVENT_TYPES).toContain('scope.conflict');
    expect(REALTIME_EVENT_TYPES).toContain('git.webhook.processed');
    expect(new Set(REALTIME_EVENT_TYPES).size).toBe(REALTIME_EVENT_TYPES.length);
  });

  it('validates a task event envelope', () => {
    const parsed = realtimeEventSchema.parse({
      ...envelope,
      type: 'task.updated',
      data: {
        taskId: ULID_A,
        status: 'in_progress',
        version: 3,
        actor: { type: 'agent', id: ULID_B },
      },
    });

    expect(parsed.type).toBe('task.updated');
    expect(parsed.cursor).toBe('00000000000000000042');
  });

  it('rejects an unknown event type and a payload from another event', () => {
    expect(
      realtimeEventSchema.safeParse({ ...envelope, type: 'task.exploded', data: {} })
        .success,
    ).toBe(false);

    expect(
      realtimeEventSchema.safeParse({
        ...envelope,
        type: 'message.created',
        data: { taskId: ULID_A, status: 'in_progress', version: 1 },
      }).success,
    ).toBe(false);
  });

  it('accepts an organization wide event without a project', () => {
    expect(
      realtimeEventSchema.safeParse({
        ...envelope,
        projectId: null,
        type: 'device.changed',
        data: { deviceId: ULID_A, status: 'offline' },
      }).success,
    ).toBe(true);
  });

  it('validates the handshake in both directions', () => {
    const hello = clientMessageSchema.parse({
      type: 'hello',
      protocolVersion: 1,
      deviceId: ULID_A,
      clientVersion: '0.1.0',
      subscriptions: [
        { organizationId: ULID_B, projectId: ULID_C, eventTypes: ['task.updated'] },
      ],
      cursor: null,
    });

    expect(hello.type).toBe('hello');

    expect(
      serverMessageSchema.safeParse({
        type: 'welcome',
        protocolVersion: 1,
        sessionId: ULID_A,
        serverTime: NOW,
        heartbeatIntervalMs: 30_000,
        resumeCursor: null,
        resumeGap: false,
        subscriptions: [],
      }).success,
    ).toBe(true);

    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'TOKEN_EXPIRED',
        message: 'realtime token expired',
        retryable: true,
      }).success,
    ).toBe(true);
  });

  it('refuses a hello without subscriptions', () => {
    expect(
      clientMessageSchema.safeParse({
        type: 'hello',
        protocolVersion: 1,
        deviceId: null,
        clientVersion: null,
        subscriptions: [],
        cursor: null,
      }).success,
    ).toBe(false);
  });
});
