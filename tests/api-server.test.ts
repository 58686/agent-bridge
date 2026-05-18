import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../src/server.js';
import { ApiAuditEvent, ApiAuditSink, ApiAuthOptions, ConsoleApiAuditSink, InMemoryApiAuditSink } from '../src/api-security.js';
import {
  ApprovalGrantRecord,
  ConfirmationDecisionRecord,
  ConfirmationRequestRecord,
  SessionRecord,
  SessionSnapshotRecord,
  SessionStatus,
  ToolExecutionRecord,
} from '../src/persistence/types.js';
import {
  ApprovalGrantRepository,
  AuditEventRepository,
  ConfirmationRepository,
  SessionRepository,
  ToolExecutionRepository,
} from '../src/persistence/interfaces.js';

function createConfirmationProject() {
  return {
    id: 'confirmation-demo-project',
    name: 'Confirmation Demo Project',
    description: '用于验证高风险工具确认闭环的本地演示配置',
    model: {
      provider: 'custom' as const,
      model: 'mock-model',
    },
    connectors: [
      {
        id: 'echo-demo',
        type: 'echo',
        name: 'Echo Demo Connector',
        config: {
          projectName: 'demo',
        },
      },
      {
        id: 'company-api',
        type: 'api',
        name: 'Company API Connector',
        config: {
          baseUrl: 'https://example.internal.api/',
          tools: [
            {
              name: 'create_comment',
              description: '为工单新增评论',
              method: 'POST',
              path: '/tickets/comment',
              bodyParams: ['ticketId', 'content'],
              parameters: {
                ticketId: {
                  type: 'string',
                  description: '工单 ID',
                  required: true,
                },
                content: {
                  type: 'string',
                  description: '评论内容',
                  required: true,
                },
              },
            },
          ],
        },
      },
    ],
    systemPrompt: '你是一个企业内部系统 Agent。当需要新增评论时，优先调用 create_comment 工具。',
    toolPolicy: {
      maxConsecutiveCalls: 5,
      requireConfirmation: true,
    },
  };
}

function createNonConfirmingEchoProject() {
  return {
    id: 'echo-direct-project',
    name: 'Echo Direct Project',
    description: '用于验证无需确认的工具执行审计',
    model: {
      provider: 'custom' as const,
      model: 'mock-model',
    },
    connectors: [
      {
        id: 'echo-demo',
        type: 'echo',
        name: 'Echo Demo Connector',
        config: {
          projectName: 'demo',
        },
      },
    ],
    systemPrompt: '你是一个会优先调用 echo_text 的 Agent。',
    toolPolicy: {
      maxConsecutiveCalls: 5,
      requireConfirmation: false,
    },
  };
}

function createNonConfirmingCommentProject() {
  return {
    id: 'comment-direct-project',
    name: 'Comment Direct Project',
    description: '用于验证工具真实异常时的运行时审计',
    model: {
      provider: 'custom' as const,
      model: 'mock-model',
    },
    connectors: [
      {
        id: 'company-api',
        type: 'api',
        name: 'Company API Connector',
        config: {
          baseUrl: 'https://example.internal.api/',
          tools: [
            {
              name: 'create_comment',
              description: '为工单新增评论',
              method: 'POST',
              path: '/tickets/comment',
              bodyParams: ['ticketId', 'content'],
              parameters: {
                ticketId: {
                  type: 'string',
                  description: '工单 ID',
                  required: true,
                },
                content: {
                  type: 'string',
                  description: '评论内容',
                  required: true,
                },
              },
            },
          ],
        },
      },
    ],
    systemPrompt: '你是一个企业内部系统 Agent。当需要新增评论时，优先调用 create_comment 工具。',
    toolPolicy: {
      maxConsecutiveCalls: 5,
      requireConfirmation: false,
    },
  };
}

class FakeSessionRepository implements SessionRepository {
  createdSessions: SessionRecord[] = [];
  statusUpdates: Array<{
    sessionId: string;
    status: SessionStatus;
    patch?: Partial<Pick<SessionRecord, 'updatedAt' | 'lastInput' | 'lastError'>>;
  }> = [];
  snapshots: SessionSnapshotRecord[] = [];

  async create(session: SessionRecord): Promise<void> {
    const existingIndex = this.createdSessions.findIndex((entry) => entry.id === session.id);
    if (existingIndex >= 0) {
      this.createdSessions[existingIndex] = session;
      return;
    }
    this.createdSessions.push(session);
  }

  async getById(sessionId: string): Promise<SessionRecord | null> {
    const created = this.createdSessions.find((session) => session.id === sessionId);
    if (!created) {
      return null;
    }

    let current = { ...created };
    for (const update of this.statusUpdates.filter((entry) => entry.sessionId === sessionId)) {
      current = {
        ...current,
        status: update.status,
        updatedAt: update.patch?.updatedAt ?? current.updatedAt,
        lastInput: update.patch?.lastInput ?? current.lastInput,
        lastError: update.patch?.lastError ?? current.lastError,
      };
    }

    return current;
  }

  async list(projectId?: string): Promise<SessionRecord[]> {
    const sessions = await Promise.all(this.createdSessions.map((session) => this.getById(session.id)));
    return sessions
      .filter((session): session is SessionRecord => Boolean(session))
      .filter((session) => !projectId || session.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async query(query: {
    projectId?: string;
    status?: SessionStatus;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    const sessions = await Promise.all(this.createdSessions.map((session) => this.getById(session.id)));
    const filtered = sessions
      .filter((session): session is SessionRecord => Boolean(session))
      .filter((session) => {
        if (query.projectId && session.projectId !== query.projectId) {
          return false;
        }
        if (query.status && session.status !== query.status) {
          return false;
        }
        const updatedAt = Date.parse(session.updatedAt);
        if (from !== undefined && updatedAt < from) {
          return false;
        }
        if (to !== undefined && updatedAt > to) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const records = filtered.slice(offset, offset + limit);
    return {
      records,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + records.length < filtered.length,
    };
  }

  async updateStatus(
    sessionId: string,
    status: SessionStatus,
    patch?: Partial<Pick<SessionRecord, 'updatedAt' | 'lastInput' | 'lastError'>>,
  ): Promise<void> {
    this.statusUpdates.push({ sessionId, status, patch });
  }

  async saveSnapshot(snapshot: SessionSnapshotRecord): Promise<void> {
    const existingIndex = this.snapshots.findIndex((entry) => entry.sessionId === snapshot.sessionId);
    if (existingIndex >= 0) {
      this.snapshots[existingIndex] = snapshot;
      return;
    }
    this.snapshots.push(snapshot);
  }

  async loadSnapshot(sessionId: string): Promise<SessionSnapshotRecord | null> {
    return this.snapshots.find((snapshot) => snapshot.sessionId === sessionId) ?? null;
  }
}

class FakeConfirmationRepository implements ConfirmationRepository {
  createdRequests: ConfirmationRequestRecord[] = [];
  approvedRequestIds: string[] = [];
  rejectedRequestIds: string[] = [];
  consumedRequestIds: string[] = [];
  expiredRequestIds: string[] = [];
  decisions: ConfirmationDecisionRecord[] = [];

  async createRequest(request: ConfirmationRequestRecord): Promise<void> {
    this.createdRequests.push(request);
  }

  async getById(requestId: string): Promise<ConfirmationRequestRecord | null> {
    const request = this.createdRequests.find((entry) => entry.id === requestId) ?? null;
    if (!request) {
      return null;
    }

    if (this.expiredRequestIds.includes(requestId)) {
      return { ...request, status: 'expired' };
    }
    if (this.consumedRequestIds.includes(requestId)) {
      return { ...request, status: 'consumed' };
    }
    if (this.approvedRequestIds.includes(requestId)) {
      return { ...request, status: 'approved' };
    }
    if (this.rejectedRequestIds.includes(requestId)) {
      return { ...request, status: 'rejected' };
    }

    return request;
  }

  async listPending(sessionId?: string): Promise<ConfirmationRequestRecord[]> {
    return this.createdRequests.filter(
      (request) =>
        (!sessionId || request.sessionId === sessionId)
        && !this.approvedRequestIds.includes(request.id)
        && !this.rejectedRequestIds.includes(request.id)
        && !this.consumedRequestIds.includes(request.id)
        && !this.expiredRequestIds.includes(request.id),
    );
  }

  async queryRequests(query: {
    sessionId?: string;
    projectId?: string;
    tool?: string;
    riskLevel?: ConfirmationRequestRecord['riskLevel'];
    status?: ConfirmationRequestRecord['status'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    const recordsWithStatus = this.createdRequests.map((request) => this.getCurrentRequest(request));
    const filtered = recordsWithStatus
      .filter((request) => {
        if (query.sessionId && request.sessionId !== query.sessionId) {
          return false;
        }
        if (query.projectId && request.projectId !== query.projectId) {
          return false;
        }
        if (query.tool && request.tool !== query.tool) {
          return false;
        }
        if (query.riskLevel && request.riskLevel !== query.riskLevel) {
          return false;
        }
        if (query.status && request.status !== query.status) {
          return false;
        }
        const createdAt = Date.parse(request.createdAt);
        if (from !== undefined && createdAt < from) {
          return false;
        }
        if (to !== undefined && createdAt > to) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const records = filtered.slice(offset, offset + limit);
    return {
      records,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + records.length < filtered.length,
    };
  }

  async queryDecisions(query: {
    sessionId?: string;
    requestId?: string;
    decision?: ConfirmationDecisionRecord['decision'];
    actor?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    const filtered = this.decisions
      .filter((decision) => {
        if (query.sessionId && decision.sessionId !== query.sessionId) {
          return false;
        }
        if (query.requestId && decision.requestId !== query.requestId) {
          return false;
        }
        if (query.decision && decision.decision !== query.decision) {
          return false;
        }
        if (query.actor && decision.actor !== query.actor) {
          return false;
        }
        const createdAt = Date.parse(decision.createdAt);
        if (from !== undefined && createdAt < from) {
          return false;
        }
        if (to !== undefined && createdAt > to) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const records = filtered.slice(offset, offset + limit);
    return {
      records,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + records.length < filtered.length,
    };
  }

  async findPendingMatch(
    sessionId: string,
    tool: string,
    callId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ConfirmationRequestRecord | null> {
    return this.createdRequests.find(
      (request) =>
        request.sessionId === sessionId
        && request.tool === tool
        && request.callId === callId
        && JSON.stringify(request.args) === JSON.stringify(args)
        && !this.approvedRequestIds.includes(request.id)
        && !this.rejectedRequestIds.includes(request.id)
        && !this.expiredRequestIds.includes(request.id),
    ) ?? null;
  }

  async markApproved(requestId: string): Promise<void> {
    this.approvedRequestIds.push(requestId);
  }

  async markRejected(requestId: string): Promise<void> {
    this.rejectedRequestIds.push(requestId);
  }

  async markConsumed(requestId: string): Promise<void> {
    this.consumedRequestIds.push(requestId);
  }

  async markExpired(requestId: string): Promise<void> {
    this.expiredRequestIds.push(requestId);
  }

  async expirePending(): Promise<number> {
    return 0;
  }

  async appendDecision(decision: ConfirmationDecisionRecord): Promise<void> {
    this.decisions.push(decision);
  }

  private getCurrentRequest(request: ConfirmationRequestRecord): ConfirmationRequestRecord {
    if (this.expiredRequestIds.includes(request.id)) {
      return { ...request, status: 'expired' };
    }
    if (this.consumedRequestIds.includes(request.id)) {
      return { ...request, status: 'consumed' };
    }
    if (this.approvedRequestIds.includes(request.id)) {
      return { ...request, status: 'approved' };
    }
    if (this.rejectedRequestIds.includes(request.id)) {
      return { ...request, status: 'rejected' };
    }
    return request;
  }
}

class FakeApprovalGrantRepository implements ApprovalGrantRepository {
  grants: ApprovalGrantRecord[] = [];

  async createGrant(grant: ApprovalGrantRecord): Promise<void> {
    this.grants.push(grant);
  }

  async findMatchingGrant(
    sessionId: string,
    tool: string,
    callId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ApprovalGrantRecord | null> {
    return this.grants.find(
      (grant) =>
        grant.sessionId === sessionId
        && grant.tool === tool
        && grant.callId === callId
        && JSON.stringify(grant.args) === JSON.stringify(args)
        && !grant.consumedAt,
    ) ?? null;
  }

  async consumeGrant(requestId: string, consumedAt: string): Promise<void> {
    const grant = this.grants.find((entry) => entry.requestId === requestId);
    if (grant) {
      grant.consumedAt = consumedAt;
    }
  }

  async listActive(sessionId?: string): Promise<ApprovalGrantRecord[]> {
    return this.grants.filter((grant) => !grant.consumedAt && (!sessionId || grant.sessionId === sessionId));
  }
}

class FakeToolExecutionRepository implements ToolExecutionRepository {
  records: ToolExecutionRecord[] = [];

  async create(record: ToolExecutionRecord): Promise<void> {
    this.records.push(record);
  }

  async finish(
    id: string,
    patch: Pick<ToolExecutionRecord, 'status' | 'finishedAt' | 'durationMs' | 'error' | 'result'>,
  ): Promise<void> {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) {
      return;
    }

    record.status = patch.status;
    record.finishedAt = patch.finishedAt;
    record.durationMs = patch.durationMs;
    record.error = patch.error;
    record.result = patch.result;
  }

  async listBySession(sessionId: string): Promise<ToolExecutionRecord[]> {
    return this.records.filter((record) => record.sessionId === sessionId);
  }

  async query(query: {
    sessionId?: string;
    tool?: string;
    status?: ToolExecutionRecord['status'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const filtered = this.records
      .filter((record) => {
        if (query.sessionId && record.sessionId !== query.sessionId) {
          return false;
        }
        if (query.tool && record.tool !== query.tool) {
          return false;
        }
        if (query.status && record.status !== query.status) {
          return false;
        }
        const startedAt = Date.parse(record.startedAt);
        if (query.from && startedAt < Date.parse(query.from)) {
          return false;
        }
        if (query.to && startedAt > Date.parse(query.to)) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const records = filtered.slice(offset, offset + limit);
    return {
      records,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + records.length < filtered.length,
    };
  }
}

class FakeAuditEventRepository implements AuditEventRepository {
  events: ApiAuditEvent[] = [];

  async create(event: ApiAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async query(query: {
    sessionId?: string;
    actorId?: string;
    action?: string;
    result?: 'success' | 'failure';
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const filtered = this.events
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) {
          return false;
        }
        if (query.actorId && event.actorId !== query.actorId) {
          return false;
        }
        if (query.action && event.action !== query.action) {
          return false;
        }
        if (query.result && event.result !== query.result) {
          return false;
        }
        const timestamp = Date.parse(event.timestamp);
        if (query.from && timestamp < Date.parse(query.from)) {
          return false;
        }
        if (query.to && timestamp > Date.parse(query.to)) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    const events = filtered.slice(offset, offset + limit);
    return {
      events,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + events.length < filtered.length,
    };
  }

  async listAll(): Promise<ApiAuditEvent[]> {
    return [...this.events];
  }
}

class CollectingAuditSink implements ApiAuditSink {
  events: ApiAuditEvent[] = [];

  emit(event: ApiAuditEvent): void {
    this.events.push(event);
  }

  query(query: {
    sessionId?: string;
    actorId?: string;
    action?: string;
    result?: 'success' | 'failure';
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
    const toTimestamp = query.to ? Date.parse(query.to) : undefined;

    const filtered = this.events
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) {
          return false;
        }
        if (query.actorId && event.actorId !== query.actorId) {
          return false;
        }
        if (query.action && event.action !== query.action) {
          return false;
        }
        if (query.result && event.result !== query.result) {
          return false;
        }

        const eventTimestamp = Date.parse(event.timestamp);
        if (fromTimestamp !== undefined && Number.isFinite(fromTimestamp) && eventTimestamp < fromTimestamp) {
          return false;
        }
        if (toTimestamp !== undefined && Number.isFinite(toTimestamp) && eventTimestamp > toTimestamp) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

    const events = filtered.slice(offset, offset + limit);
    return {
      events,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + events.length < filtered.length,
    };
  }
}

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
  143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659,
  4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

async function startTestServer(options?: {
  auth?: ApiAuthOptions;
  auditSink?: ApiAuditSink;
  auditEvents?: AuditEventRepository;
  project?: ReturnType<typeof createConfirmationProject>;
}) {
  const sessions = new FakeSessionRepository();
  const confirmations = new FakeConfirmationRepository();
  const approvalGrants = new FakeApprovalGrantRepository();
  const toolExecutions = new FakeToolExecutionRepository();
  const auditEvents = options?.auditEvents;

  const server = createApiServer({
    project: options?.project ?? createConfirmationProject(),
    persistence: {
      sessions,
      confirmations,
      approvalGrants,
      toolExecutions,
      auditEvents,
    },
    auth: options?.auth,
    auditSink: options?.auditSink,
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  if (isFetchBlockedPort(address.port)) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return startTestServer(options);
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessions,
    confirmations,
    approvalGrants,
    toolExecutions,
    auditEvents,
  };
}

describe('API server', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('可以返回最小 UI 页面', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      const body = await response.text();
      expect(body).toContain('agent-bridge Demo Console');
      expect(body).toContain('Safe runtime for connecting AI agents to company APIs, workflows, and business systems.');
      expect(body).toContain('Auto refresh every 5s');
      expect(body).toContain('Project config check');
      expect(body).toContain('Readiness checks');
      expect(body).toContain('Security redaction');
      expect(body).toContain('Project template');
      expect(body).toContain('Generate YAML');
      expect(body).toContain('Project ID');
      expect(body).toContain('Base URL env');
      expect(body).toContain('Read path');
      expect(body).toContain('Write path');
      expect(body).toContain('View default YAML');
      expect(body).toContain('Download default YAML');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('开启鉴权时 UI 与 health 仍可免 token 访问', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [{ token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' }],
      },
    });

    try {
      const uiResponse = await fetch(`${baseUrl}/`);
      expect(uiResponse.status).toBe(200);
      expect(await uiResponse.text()).toContain('agent-bridge Demo Console');

      const healthResponse = await fetch(`${baseUrl}/health`);
      expect(healthResponse.status).toBe(200);

      const projectResponse = await fetch(`${baseUrl}/project`);
      expect(projectResponse.status).toBe(401);
      const payload = await projectResponse.json() as { error: { code: string } };
      expect(payload.error.code).toBe('AUTH_REQUIRED');

      const templateResponse = await fetch(`${baseUrl}/project/template`);
      expect(templateResponse.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以返回 health 与脱敏后的 project 摘要', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const healthResponse = await fetch(`${baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      const health = await healthResponse.json() as {
        status: string;
        projectId: string;
        persistence: { enabled: boolean };
      };
      expect(health.status).toBe('ok');
      expect(health.projectId).toBe('confirmation-demo-project');
      expect(health.persistence.enabled).toBe(true);

      const projectResponse = await fetch(`${baseUrl}/project`);
      expect(projectResponse.status).toBe(200);
      const payload = await projectResponse.json() as {
        debug: boolean;
        project: {
          id: string;
          name: string;
          model: {
            provider: string;
            model: string;
            temperature?: number;
            maxTokens?: number;
            apiKey?: string;
            envApiKey?: string;
          };
          connectors: Array<{
            id: string;
            type: string;
            name: string;
            config?: unknown;
            toolCount: number;
            tools: Array<{ name: string; method?: string; path?: string }>;
          }>;
          analysis?: {
            levelsCount: number;
          };
          security?: {
            redaction?: {
              enabled: boolean;
              extraSensitiveKeys: string[];
              replacement: string;
            };
          };
          checks: Array<{ id: string; status: 'ok' | 'warning' | 'error'; message: string }>;
          toolPolicy?: {
            requireConfirmation?: boolean;
          };
        };
      };
      expect(payload.debug).toBe(false);
      expect(payload.project.id).toBe('confirmation-demo-project');
      expect(payload.project.name).toBe('Confirmation Demo Project');
      expect(payload.project.model.provider).toBe('custom');
      expect(payload.project.model.model).toBe('mock-model');
      expect(payload.project.model.apiKey).toBeUndefined();
      expect(payload.project.model.envApiKey).toBeUndefined();
      expect(payload.project.connectors).toHaveLength(2);
      expect(payload.project.connectors[0].config).toBeUndefined();
      expect(payload.project.connectors[1].toolCount).toBe(1);
      expect(payload.project.connectors[1].tools[0]).toMatchObject({ name: 'create_comment', method: 'POST', path: '/tickets/comment' });
      expect(payload.project.analysis).toBeUndefined();
      expect(payload.project.security).toBeUndefined();
      expect(payload.project.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'model', status: 'ok' }),
        expect.objectContaining({ id: 'tools', status: 'ok' }),
        expect.objectContaining({ id: 'write-confirmation', status: 'ok' }),
        expect.objectContaining({ id: 'analysis', status: 'warning' }),
        expect.objectContaining({ id: 'redaction', status: 'warning' }),
      ]));
      expect(payload.project.toolPolicy?.requireConfirmation).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('returns project template as JSON or YAML', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const jsonResponse = await fetch(`${baseUrl}/project/template?scenario=training-analysis`);
      expect(jsonResponse.status).toBe(200);
      const jsonPayload = await jsonResponse.json() as {
        template: {
          scenario: string;
          fileName: string;
          contentType: string;
          environment: string[];
          yaml: string;
        };
      };
      expect(jsonPayload.template.scenario).toBe('training-analysis');
      expect(jsonPayload.template.fileName).toBe('training-analysis-project.yaml');
      expect(jsonPayload.template.contentType).toBe('application/x-yaml');
      expect(jsonPayload.template.environment).toEqual(['OPENAI_API_KEY', 'TRAINING_API_BASE_URL', 'TRAINING_API_TOKEN']);
      expect(jsonPayload.template.yaml).toContain('save_training_analysis');
      expect(jsonPayload.template.yaml).toContain('confirmationRules:');
      expect(jsonPayload.template.yaml).toContain('type: bearer');
      expect(jsonPayload.template.yaml).toContain('token: ${TRAINING_API_TOKEN}');
      expect(jsonPayload.template.yaml).not.toContain('example-training-token');

      const yamlResponse = await fetch(`${baseUrl}/project/template?scenario=default&format=yaml`);
      expect(yamlResponse.status).toBe(200);
      expect(yamlResponse.headers.get('content-type')).toContain('application/x-yaml');
      expect(yamlResponse.headers.get('content-disposition')).toContain('training-analysis-project.yaml');
      const yamlBody = await yamlResponse.text();
      expect(yamlBody).toContain('id: training-analysis-agent');
      expect(yamlBody).toContain('token: ${TRAINING_API_TOKEN}');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('generates customized project templates from wizard input', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/project/template`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'employee-training-agent',
          projectName: 'Employee Training Agent',
          description: 'Analyze employee training data and save the result.',
          connectorId: 'hr-training-api',
          connectorName: 'HR Training API',
          apiBaseUrlEnv: 'HR_API_BASE_URL',
          apiTokenEnv: 'HR_API_TOKEN',
          userIdParam: 'employeeId',
          standardId: 'hr-compliance-2026',
          readTool: {
            name: 'fetch_employee_training',
            path: '/api/training/summary',
            queryParams: ['employeeId'],
          },
          writeTool: {
            name: 'save_employee_training_review',
            path: '/api/training/review',
            bodyParams: ['employeeId', 'standardId', 'scoreLevel', 'riskLevel', 'summary', 'recommendations', 'evidence'],
            requireConfirmation: true,
          },
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as { template: { fileName: string; environment: string[]; yaml: string } };
      expect(payload.template.fileName).toBe('employee-training-agent-project.yaml');
      expect(payload.template.environment).toEqual(['OPENAI_API_KEY', 'HR_API_BASE_URL', 'HR_API_TOKEN']);
      expect(payload.template.yaml).toContain('id: employee-training-agent');
      expect(payload.template.yaml).toContain('baseUrl: ${HR_API_BASE_URL}');
      expect(payload.template.yaml).toContain('token: ${HR_API_TOKEN}');
      expect(payload.template.yaml).toContain('name: fetch_employee_training');
      expect(payload.template.yaml).toContain('path: /api/training/summary');
      expect(payload.template.yaml).toContain('queryParams: ["employeeId"]');
      expect(payload.template.yaml).toContain('tool: save_employee_training_review');
      expect(payload.template.yaml).not.toContain('example-training-token');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects invalid project template wizard input', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/project/template`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiTokenEnv: 'not-valid-token-env' }),
      });
      expect(response.status).toBe(400);
      const payload = await response.json() as { error: { code: string } };
      expect(payload.error.code).toBe('PROJECT_TEMPLATE_INVALID');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects unsupported project template scenarios', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const response = await fetch(`${baseUrl}/project/template?scenario=unknown`);
      expect(response.status).toBe(400);
      const payload = await response.json() as { error: { code: string } };
      expect(payload.error.code).toBe('PROJECT_TEMPLATE_SCENARIO_UNSUPPORTED');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('returns analysis and security summaries for project config visualization', async () => {
    const project = {
      ...createConfirmationProject(),
      analysis: {
        standardId: 'annual-compliance-2026',
        levels: [
          { level: 'excellent', riskLevel: 'low' as const, when: { completionRate: { gte: 0.9 } } },
        ],
        fallback: { level: 'needs_attention', riskLevel: 'high' as const },
      },
      security: {
        redaction: {
          extraSensitiveKeys: ['employeeIdCard', 'mobile_phone'],
          replacement: '[MASKED]',
        },
      },
    };
    const { server, baseUrl } = await startTestServer({ project });

    try {
      const projectResponse = await fetch(`${baseUrl}/project`);
      expect(projectResponse.status).toBe(200);
      const payload = await projectResponse.json() as {
        project: {
          analysis?: { standardId?: string; levelsCount: number; fallbackLevel?: string; fallbackRiskLevel?: string };
          security?: { redaction?: { enabled: boolean; extraSensitiveKeys: string[]; replacement: string } };
          checks: Array<{ id: string; status: 'ok' | 'warning' | 'error'; message: string }>;
        };
      };

      expect(payload.project.analysis).toEqual({
        standardId: 'annual-compliance-2026',
        levelsCount: 1,
        fallbackLevel: 'needs_attention',
        fallbackRiskLevel: 'high',
      });
      expect(payload.project.security?.redaction).toEqual({
        enabled: true,
        extraSensitiveKeys: ['employeeIdCard', 'mobile_phone'],
        replacement: '[MASKED]',
      });
      expect(payload.project.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'analysis', status: 'ok' }),
        expect.objectContaining({ id: 'redaction', status: 'ok' }),
      ]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以创建 session 并列出详情', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { sessionId: string };
      expect(created.sessionId).toBeTruthy();

      const listResponse = await fetch(`${baseUrl}/sessions`);
      expect(listResponse.status).toBe(200);
      const listed = await listResponse.json() as { records: Array<{ id: string }>; total: number };
      expect(listed.records).toHaveLength(1);
      expect(listed.total).toBe(1);
      expect(listed.records[0].id).toBe(created.sessionId);

      const detailsResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}`);
      expect(detailsResponse.status).toBe(200);
      const details = await detailsResponse.json() as { session: { id: string } };
      expect(details.session.id).toBe(created.sessionId);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以运行 session 并返回 pending confirmation，再批准后继续执行', async () => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        status: string;
        result: { pendingConfirmation?: { id: string } };
      };
      expect(runResult.status).toBe('waiting_confirmation');
      expect(runResult.result.pendingConfirmation?.id).toBeTruthy();
      expect(
        fetchMock.mock.calls.filter(([input]) => {
          const url = typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          return !url.startsWith('http://127.0.0.1:');
        }),
      ).toHaveLength(0);

      const approveResponse = await fetch(
        `${baseUrl}/confirmations/${runResult.result.pendingConfirmation!.id}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'approved from api test' }),
        },
      );
      expect(approveResponse.status).toBe(200);
      const approved = await approveResponse.json() as {
        status: string;
        result: { pendingConfirmation?: unknown; toolCalls: Array<{ tool: string }> };
      };
      expect(approved.status).toBe('completed');
      expect(approved.result.pendingConfirmation).toBeUndefined();
      expect(approved.result.toolCalls[0].tool).toBe('create_comment');
      expect(
        fetchMock.mock.calls.filter(([input]) => {
          const url = typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          return !url.startsWith('http://127.0.0.1:');
        }),
      ).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('同一 session 的并发 run 会返回 AGENT_ALREADY_RUNNING', async () => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let releaseExternalFetch: (() => void) | undefined;
    const externalFetchBlocked = new Promise<void>((resolve) => {
      releaseExternalFetch = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      await externalFetchBlocked;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer({
      project: createNonConfirmingCommentProject(),
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const firstRunPromise = fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });

      await Promise.resolve();
      await Promise.resolve();

      const secondRunResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请再次创建评论' }),
      });
      expect(secondRunResponse.status).toBe(409);
      const secondRunPayload = await secondRunResponse.json() as {
        error: { code: string; message: string; requestId: string; retryable: boolean };
      };
      expect(secondRunPayload.error.code).toBe('AGENT_ALREADY_RUNNING');
      expect(secondRunPayload.error.retryable).toBe(true);
      expect(secondRunPayload.error.requestId).toBeTruthy();

      releaseExternalFetch?.();
      const firstRunResponse = await firstRunPromise;
      expect(firstRunResponse.status).toBe(200);
      const firstRunPayload = await firstRunResponse.json() as {
        status: string;
        result: { pendingConfirmation?: unknown; toolCalls: Array<{ tool: string; result: { success: boolean } }> };
      };
      expect(firstRunPayload.status).toBe('completed');
      expect(firstRunPayload.result.pendingConfirmation).toBeUndefined();
      expect(firstRunPayload.result.toolCalls[0].tool).toBe('create_comment');
      expect(firstRunPayload.result.toolCalls[0].result.success).toBe(true);
    } finally {
      releaseExternalFetch?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('HTTP approve 遇到已过期 confirmation 时返回 CONFIRMATION_EXPIRED', async () => {
    const { server, baseUrl, confirmations } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };
      const confirmationId = runResult.result.pendingConfirmation!.id;

      confirmations.expiredRequestIds.push(confirmationId);

      const approveResponse = await fetch(`${baseUrl}/confirmations/${confirmationId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'late approval' }),
      });
      expect(approveResponse.status).toBe(400);
      const approvePayload = await approveResponse.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(approvePayload.error.code).toBe('CONFIRMATION_EXPIRED');
      expect(approvePayload.error.message).toContain('expired');
      expect(approvePayload.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以查询 session messages 与 pending confirmations', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);

      const messagesResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/messages`);
      expect(messagesResponse.status).toBe(200);
      const messagesPayload = await messagesResponse.json() as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(messagesPayload.messages.length).toBeGreaterThan(0);
      expect(messagesPayload.messages.some((message) => message.role === 'user' && message.content === '请创建评论')).toBe(true);

      const pendingResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/pending-confirmations`);
      expect(pendingResponse.status).toBe(200);
      const pendingPayload = await pendingResponse.json() as {
        pendingConfirmations: Array<{ tool: string; status: string }>;
      };
      expect(pendingPayload.pendingConfirmations).toHaveLength(1);
      expect(pendingPayload.pendingConfirmations[0].tool).toBe('create_comment');
      expect(pendingPayload.pendingConfirmations[0].status).toBe('pending');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以返回 session state summary', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);

      const summaryResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/state-summary`);
      expect(summaryResponse.status).toBe(200);
      const payload = await summaryResponse.json() as {
        summary: {
          sessionId: string;
          projectId: string;
          status: string;
          lastInput?: string;
          lastError?: string;
          messageCount: number;
          pendingConfirmationCount: number;
          activeGrantCount: number;
        };
      };
      expect(payload.summary.sessionId).toBe(created.sessionId);
      expect(payload.summary.projectId).toBe('confirmation-demo-project');
      expect(payload.summary.status).toBe('waiting_confirmation');
      expect(payload.summary.lastInput).toBe('请创建评论');
      expect(payload.summary.messageCount).toBeGreaterThan(0);
      expect(payload.summary.pendingConfirmationCount).toBe(1);
      expect(payload.summary.activeGrantCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以返回 session tool executions', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };

      const approveResponse = await fetch(
        `${baseUrl}/confirmations/${runResult.result.pendingConfirmation!.id}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'approved from api test' }),
        },
      );
      expect(approveResponse.status).toBe(200);

      const executionsResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/tool-executions?status=finished&limit=10&offset=0`);
      expect(executionsResponse.status).toBe(200);
      const payload = await executionsResponse.json() as {
        records: Array<{ tool: string; status: string; durationMs?: number }>;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        query: { sessionId: string; status?: string };
      };
      expect(payload.total).toBeGreaterThan(0);
      expect(payload.records.length).toBeGreaterThan(0);
      expect(payload.records.some((entry) => entry.tool === 'create_comment')).toBe(true);
      expect(payload.records.every((entry) => entry.status === 'finished')).toBe(true);
      expect(payload.query.sessionId).toBe(created.sessionId);
      expect(payload.query.status).toBe('finished');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以返回系统级 metrics 摘要', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);

      const metricsResponse = await fetch(`${baseUrl}/metrics`);
      expect(metricsResponse.status).toBe(200);
      const payload = await metricsResponse.json() as {
        metrics: {
          sessionCount: number;
          pendingConfirmationCount: number;
          toolExecutionCount: number;
          failedToolExecutionCount: number;
          averageToolDurationMs: number;
          sessionsByStatus: Record<string, number>;
          toolExecutionByStatus: Record<string, number>;
        };
      };
      expect(payload.metrics.sessionCount).toBeGreaterThanOrEqual(1);
      expect(payload.metrics.pendingConfirmationCount).toBeGreaterThanOrEqual(1);
      expect(payload.metrics.toolExecutionCount).toBeGreaterThanOrEqual(1);
      expect(payload.metrics.sessionsByStatus.waiting_confirmation).toBeGreaterThanOrEqual(1);
      expect(payload.metrics.toolExecutionByStatus.waiting_confirmation).toBeGreaterThanOrEqual(1);
      expect(payload.metrics.failedToolExecutionCount).toBeGreaterThanOrEqual(0);
      expect(payload.metrics.averageToolDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('resume 可以在保留历史时恢复被中断的执行', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl, confirmations, approvalGrants } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        status: string;
        result: { pendingConfirmation?: { id: string; tool: string; callId?: string; args?: Record<string, unknown> } };
      };
      expect(runResult.status).toBe('waiting_confirmation');
      const pending = runResult.result.pendingConfirmation;
      expect(pending?.id).toBeTruthy();

      confirmations.approvedRequestIds.push(pending!.id);
      approvalGrants.grants.push({
        requestId: pending!.id,
        sessionId: created.sessionId,
        tool: pending!.tool,
        callId: pending!.callId,
        args: pending!.args ?? {},
        approvedAt: new Date().toISOString(),
        reason: 'approved for api resume test',
      });

      const resumeResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/resume`, {
        method: 'POST',
      });
      expect(resumeResponse.status).toBe(200);
      const resumed = await resumeResponse.json() as {
        sessionId: string;
        status: string;
        result: { pendingConfirmation?: unknown; toolCalls: Array<{ tool: string }> };
      };
      expect(resumed.sessionId).toBe(created.sessionId);
      expect(resumed.status).toBe('completed');
      expect(resumed.result.pendingConfirmation).toBeUndefined();
      expect(resumed.result.toolCalls[0].tool).toBe('create_comment');
      expect(
        fetchMock.mock.calls.filter(([input]) => {
          const url = typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          return !url.startsWith('http://127.0.0.1:');
        }),
      ).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('同一 session 的并发 resume 会返回 AGENT_ALREADY_RUNNING', async () => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let releaseExternalFetch: (() => void) | undefined;
    const externalFetchBlocked = new Promise<void>((resolve) => {
      releaseExternalFetch = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      await externalFetchBlocked;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl, confirmations, approvalGrants } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string; tool: string; callId?: string; args?: Record<string, unknown> } };
      };
      const pending = runResult.result.pendingConfirmation!;

      confirmations.approvedRequestIds.push(pending.id);
      approvalGrants.grants.push({
        requestId: pending.id,
        sessionId: created.sessionId,
        tool: pending.tool,
        callId: pending.callId,
        args: pending.args ?? {},
        approvedAt: new Date().toISOString(),
        reason: 'approved for concurrent resume test',
      });

      const firstResumePromise = fetch(`${baseUrl}/sessions/${created.sessionId}/resume`, {
        method: 'POST',
      });

      await Promise.resolve();
      await Promise.resolve();

      const secondResumeResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/resume`, {
        method: 'POST',
      });
      expect(secondResumeResponse.status).toBe(409);
      const secondResumePayload = await secondResumeResponse.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(secondResumePayload.error.code).toBe('AGENT_ALREADY_RUNNING');
      expect(secondResumePayload.error.requestId).toBeTruthy();

      releaseExternalFetch?.();
      const firstResumeResponse = await firstResumePromise;
      expect(firstResumeResponse.status).toBe(200);
      const firstResumePayload = await firstResumeResponse.json() as {
        status: string;
        result: { pendingConfirmation?: unknown; toolCalls: Array<{ tool: string; result: { success: boolean } }> };
      };
      expect(firstResumePayload.status).toBe('completed');
      expect(firstResumePayload.result.pendingConfirmation).toBeUndefined();
      expect(firstResumePayload.result.toolCalls[0].tool).toBe('create_comment');
      expect(firstResumePayload.result.toolCalls[0].result.success).toBe(true);
    } finally {
      releaseExternalFetch?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('resume 执行中再次 run 会返回 AGENT_ALREADY_RUNNING', async () => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let releaseExternalFetch: (() => void) | undefined;
    const externalFetchBlocked = new Promise<void>((resolve) => {
      releaseExternalFetch = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      await externalFetchBlocked;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl, confirmations, approvalGrants } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string; tool: string; callId?: string; args?: Record<string, unknown> } };
      };
      const pending = runResult.result.pendingConfirmation!;

      confirmations.approvedRequestIds.push(pending.id);
      approvalGrants.grants.push({
        requestId: pending.id,
        sessionId: created.sessionId,
        tool: pending.tool,
        callId: pending.callId,
        args: pending.args ?? {},
        approvedAt: new Date().toISOString(),
        reason: 'approved for resume-run race test',
      });

      const resumePromise = fetch(`${baseUrl}/sessions/${created.sessionId}/resume`, {
        method: 'POST',
      });

      await Promise.resolve();
      await Promise.resolve();

      const runWhileResumingResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请在恢复中再次创建评论' }),
      });
      expect(runWhileResumingResponse.status).toBe(409);
      const runWhileResumingPayload = await runWhileResumingResponse.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(runWhileResumingPayload.error.code).toBe('AGENT_ALREADY_RUNNING');
      expect(runWhileResumingPayload.error.requestId).toBeTruthy();

      releaseExternalFetch?.();
      const resumeResponse = await resumePromise;
      expect(resumeResponse.status).toBe(200);
      const resumedPayload = await resumeResponse.json() as {
        status: string;
        result: { pendingConfirmation?: unknown; toolCalls: Array<{ tool: string; result: { success: boolean } }> };
      };
      expect(resumedPayload.status).toBe('completed');
      expect(resumedPayload.result.pendingConfirmation).toBeUndefined();
      expect(resumedPayload.result.toolCalls[0].tool).toBe('create_comment');
      expect(resumedPayload.result.toolCalls[0].result.success).toBe(true);
    } finally {
      releaseExternalFetch?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('resume 在缺少 lastInput 时返回错误', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const resumeResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/resume`, {
        method: 'POST',
      });
      expect(resumeResponse.status).toBe(400);
      const payload = await resumeResponse.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(payload.error.code).toBe('SESSION_LAST_INPUT_MISSING');
      expect(payload.error.message).toContain('lastInput');
      expect(payload.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以查询 grants 并清空 history', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };

      const approveResponse = await fetch(
        `${baseUrl}/confirmations/${runResult.result.pendingConfirmation!.id}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'approved from api test' }),
        },
      );
      expect(approveResponse.status).toBe(200);

      const grantsResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/grants`);
      expect(grantsResponse.status).toBe(200);
      const grantsPayload = await grantsResponse.json() as {
        approvalGrants: Array<{ requestId: string }>;
      };
      expect(grantsPayload.approvalGrants).toHaveLength(0);

      const clearHistoryResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/clear-history`, {
        method: 'POST',
      });
      expect(clearHistoryResponse.status).toBe(200);
      const clearHistoryPayload = await clearHistoryResponse.json() as {
        cleared: boolean;
        messages: Array<{ role: string }>;
      };
      expect(clearHistoryPayload.cleared).toBe(true);
      expect(clearHistoryPayload.messages).toHaveLength(1);
      expect(clearHistoryPayload.messages[0].role).toBe('system');

      const messagesResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/messages`);
      const messagesPayload = await messagesResponse.json() as {
        messages: Array<{ role: string }>;
      };
      expect(messagesPayload.messages).toHaveLength(1);
      expect(messagesPayload.messages[0].role).toBe('system');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('HTTP approve 已自动 resume 并消费 grant，clear-history 后再次 resume 会重新进入 confirmation', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };
      const confirmationId = runResult.result.pendingConfirmation!.id;

      const approveResponse = await fetch(
        `${baseUrl}/confirmations/${confirmationId}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'approved before history clear' }),
        },
      );
      expect(approveResponse.status).toBe(200);
      const approved = await approveResponse.json() as {
        status: string;
        result: {
          pendingConfirmation?: unknown;
          toolCalls: Array<{ tool: string; result: { success: boolean } }>;
        };
      };
      expect(approved.status).toBe('completed');
      expect(approved.result.pendingConfirmation).toBeUndefined();
      expect(approved.result.toolCalls).toHaveLength(1);
      expect(approved.result.toolCalls[0].tool).toBe('create_comment');
      expect(approved.result.toolCalls[0].result.success).toBe(true);

      const clearHistoryResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/clear-history`, {
        method: 'POST',
      });
      expect(clearHistoryResponse.status).toBe(200);

      const resumeResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/resume`, {
        method: 'POST',
      });
      expect(resumeResponse.status).toBe(200);
      const resumed = await resumeResponse.json() as {
        status: string;
        result: {
          pendingConfirmation?: { id: string; tool: string };
          toolCalls: Array<{ tool: string; result: { success: boolean } }>;
        };
      };

      expect(resumed.status).toBe('waiting_confirmation');
      expect(resumed.result.pendingConfirmation).toBeDefined();
      expect(resumed.result.pendingConfirmation!.id).not.toBe(confirmationId);
      expect(resumed.result.pendingConfirmation!.tool).toBe('create_comment');
      expect(resumed.result.toolCalls).toHaveLength(1);
      expect(resumed.result.toolCalls[0].tool).toBe('create_comment');
      expect(resumed.result.toolCalls[0].result.metadata?.confirmationRequired).toBe(true);
      const externalCalls = fetchMock.mock.calls.filter(([input]) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        return url.startsWith('https://example.internal.api/');
      });
      expect(externalCalls).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('同一个 confirmation 在 HTTP 层已批准后不可重复 approve', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true, source: 'api-test' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };
      const confirmationId = runResult.result.pendingConfirmation!.id;

      const firstApproveResponse = await fetch(
        `${baseUrl}/confirmations/${confirmationId}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'approved once' }),
        },
      );
      expect(firstApproveResponse.status).toBe(200);

      const secondApproveResponse = await fetch(
        `${baseUrl}/confirmations/${confirmationId}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'approved twice' }),
        },
      );
      expect(secondApproveResponse.status).toBe(404);
      const secondApprovePayload = await secondApproveResponse.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(secondApprovePayload.error.code).toBe('CONFIRMATION_NOT_FOUND');
      expect(secondApprovePayload.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('开启鉴权后，缺少 token 的写操作会返回 401', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
        ],
      },
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      expect(createResponse.status).toBe(401);
      const payload = await createResponse.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(payload.error.code).toBe('AUTH_REQUIRED');
      expect(payload.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('开启鉴权后，operator 不能执行 approve', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
        ],
      },
    });

    try {
      const authHeaders = {
        authorization: 'Bearer operator-token',
        'content-type': 'application/json',
      };

      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };

      const approveResponse = await fetch(
        `${baseUrl}/confirmations/${runResult.result.pendingConfirmation!.id}/approve`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ reason: 'operator should not approve' }),
        },
      );
      expect(approveResponse.status).toBe(403);
      const approvePayload = await approveResponse.json() as {
        error: { code: string };
      };
      expect(approvePayload.error.code).toBe('AUTH_FORBIDDEN');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('approve 会把 approver actor 写入 decision 与 grant', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { server, baseUrl, confirmations, approvalGrants } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'approver-1', role: 'operator' },
          { token: 'approver-token', actorId: 'approver-1', role: 'approver' },
        ],
      },
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };

      const approveResponse = await fetch(
        `${baseUrl}/confirmations/${runResult.result.pendingConfirmation!.id}/approve`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer approver-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ reason: 'approved by approver actor' }),
        },
      );
      expect(approveResponse.status).toBe(200);

      expect(confirmations.decisions).toHaveLength(1);
      expect(confirmations.decisions[0].actor).toBe('approver-1');
      expect(confirmations.decisions[0].decision).toBe('approved');
      expect(approvalGrants.grants).toHaveLength(1);
      expect(approvalGrants.grants[0].approvedBy).toBe('approver-1');
      expect(approvalGrants.grants[0].reason).toBe('approved by approver actor');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('会记录运行时工具审计事件', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'approver-1', role: 'operator' },
          { token: 'approver-token', actorId: 'approver-1', role: 'approver' },
        ],
      },
      auditSink,
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };

      const toolStartAudit = auditSink.events.find((entry) => entry.action === 'tool_execution_started');
      expect(toolStartAudit?.actorId).toBe('approver-1');
      expect(toolStartAudit?.sessionId).toBe(created.sessionId);
      expect(toolStartAudit?.metadata?.tool).toBe('create_comment');

      const confirmationAudit = auditSink.events.find((entry) => entry.action === 'confirmation_requested');
      expect(confirmationAudit?.actorId).toBe('approver-1');
      expect(confirmationAudit?.requestTargetId).toBe(runResult.result.pendingConfirmation?.id);
      expect(confirmationAudit?.metadata?.riskLevel).toBe('medium');

      const waitingAudit = auditSink.events.find((entry) => entry.action === 'tool_execution_waiting_confirmation');
      expect(waitingAudit?.actorId).toBe('approver-1');
      expect(waitingAudit?.sessionId).toBe(created.sessionId);
      expect(waitingAudit?.metadata?.tool).toBe('create_comment');
      expect(waitingAudit?.metadata?.confirmationRequired).toBe(true);
      expect(waitingAudit?.result).toBe('success');
      expect(waitingAudit?.error).toBeUndefined();
      expect(auditSink.events.some((entry) => entry.action === 'tool_execution_failed')).toBe(false);

      const approveResponse = await fetch(
        `${baseUrl}/confirmations/${runResult.result.pendingConfirmation!.id}/approve`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer approver-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ reason: 'approved for runtime audit' }),
        },
      );
      expect(approveResponse.status).toBe(200);

      const toolFinishedAudit = auditSink.events.findLast((entry) => entry.action === 'tool_execution_finished');
      expect(toolFinishedAudit?.actorId).toBe('approver-1');
      expect(toolFinishedAudit?.sessionId).toBe(created.sessionId);
      expect(toolFinishedAudit?.metadata?.tool).toBe('create_comment');
      expect(typeof toolFinishedAudit?.metadata?.duration).toBe('number');

      const approvedAudit = auditSink.events.find((entry) => entry.action === 'confirmation_approved');
      expect(approvedAudit?.actorId).toBe('approver-1');
      expect(approvedAudit?.requestTargetId).toBe(runResult.result.pendingConfirmation?.id);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('不存在的 confirmation 会返回结构化 404 错误', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'approver-token', actorId: 'approver-1', role: 'approver' },
        ],
      },
    });

    try {
      const approveResponse = await fetch(`${baseUrl}/confirmations/non-existent-request/approve`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer approver-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'approve missing confirmation' }),
      });

      expect(approveResponse.status).toBe(404);
      const payload = await approveResponse.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(payload.error.code).toBe('CONFIRMATION_NOT_FOUND');
      expect(payload.error.message).toContain('Confirmation request not found');
      expect(payload.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('工具真实异常时会记录失败审计事件', async () => {
    const nativeFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input as RequestInfo | URL, init);
      }

      throw new Error('upstream api exploded');
    });
    vi.stubGlobal('fetch', fetchMock);

    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auditSink,
      project: createNonConfirmingCommentProject(),
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
        ],
      },
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const payload = await runResponse.json() as {
        status: string;
        result: {
          pendingConfirmation?: unknown;
          toolCalls: Array<{ tool: string; result: { success: boolean; error?: string } }>;
        };
      };

      expect(payload.status).toBe('completed');
      expect(payload.result.pendingConfirmation).toBeUndefined();
      expect(payload.result.toolCalls[0].tool).toBe('create_comment');
      expect(payload.result.toolCalls[0].result.success).toBe(false);
      expect(payload.result.toolCalls[0].result.error).toContain('upstream api exploded');

      const toolStartAudit = auditSink.events.find((entry) => entry.action === 'tool_execution_started');
      expect(toolStartAudit?.actorId).toBe('operator-1');
      expect(toolStartAudit?.sessionId).toBe(created.sessionId);
      expect(toolStartAudit?.metadata?.tool).toBe('create_comment');

      const failedAudit = auditSink.events.find((entry) => entry.action === 'tool_execution_failed');
      expect(failedAudit?.actorId).toBe('operator-1');
      expect(failedAudit?.sessionId).toBe(created.sessionId);
      expect(failedAudit?.metadata?.tool).toBe('create_comment');
      expect(typeof failedAudit?.metadata?.duration).toBe('number');
      expect(failedAudit?.metadata?.confirmationRequired).toBe(false);
      expect(failedAudit?.error).toContain('upstream api exploded');
      expect(auditSink.events.some((entry) => entry.action === 'tool_execution_waiting_confirmation')).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('会记录无需确认的工具完成审计事件', async () => {
    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auditSink,
      project: createNonConfirmingEchoProject(),
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '请调用 echo 并回显这句话' }),
      });
      expect(runResponse.status).toBe(200);
      const payload = await runResponse.json() as {
        status: string;
        result: { toolCalls: Array<{ tool: string; result: { success: boolean } }> };
      };
      expect(payload.status).toBe('completed');
      expect(payload.result.toolCalls[0].tool).toBe('echo_text');
      expect(payload.result.toolCalls[0].result.success).toBe(true);

      const toolStartAudit = auditSink.events.find((entry) => entry.action === 'tool_execution_started');
      expect(toolStartAudit?.sessionId).toBe(created.sessionId);
      expect(toolStartAudit?.metadata?.tool).toBe('echo_text');

      const toolFinishedAudit = auditSink.events.find((entry) => entry.action === 'tool_execution_finished');
      expect(toolFinishedAudit?.sessionId).toBe(created.sessionId);
      expect(toolFinishedAudit?.metadata?.tool).toBe('echo_text');
      expect(typeof toolFinishedAudit?.metadata?.duration).toBe('number');
      expect(toolFinishedAudit?.result).toBe('success');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('开启鉴权后会记录带 actor 的审计事件', async () => {
    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
          { token: 'operator-token', actorId: 'viewer-1', role: 'operator' },
        ],
      },
      auditSink,
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { sessionId: string };

      const detailsResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(detailsResponse.status).toBe(200);

      const sessionCreateAudit = auditSink.events.find((entry) => entry.action === 'session_create');
      expect(sessionCreateAudit?.actorId).toBe('viewer-1');
      expect(sessionCreateAudit?.role).toBe('operator');
      expect(sessionCreateAudit?.sessionId).toBe(created.sessionId);
      expect(sessionCreateAudit?.result).toBe('success');

      const sessionDetailsAudit = auditSink.events.find((entry) => entry.action === 'session_details');
      expect(sessionDetailsAudit?.actorId).toBe('viewer-1');
      expect(sessionDetailsAudit?.role).toBe('viewer');
      expect(sessionDetailsAudit?.sessionId).toBe(created.sessionId);
      expect(sessionDetailsAudit?.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以查询 audit events 并按过滤条件分页', async () => {
    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
          { token: 'operator-token', actorId: 'viewer-1', role: 'operator' },
        ],
      },
      auditSink,
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { sessionId: string };

      const sessionResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sessionResponse.status).toBe(200);

      const filteredResponse = await fetch(
        `${baseUrl}/audit-events?actorId=viewer-1&action=session_details&result=success&limit=1&offset=0`,
        { headers: { authorization: 'Bearer viewer-token' } },
      );
      expect(filteredResponse.status).toBe(200);
      const filteredPayload = await filteredResponse.json() as {
        events: ApiAuditEvent[];
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        query: {
          actorId?: string;
          action?: string;
          result?: 'success' | 'failure';
        };
      };
      expect(filteredPayload.total).toBeGreaterThanOrEqual(1);
      expect(filteredPayload.limit).toBe(1);
      expect(filteredPayload.offset).toBe(0);
      expect(filteredPayload.events).toHaveLength(1);
      expect(filteredPayload.events[0].actorId).toBe('viewer-1');
      expect(filteredPayload.events[0].action).toBe('session_details');
      expect(filteredPayload.events[0].result).toBe('success');
      expect(filteredPayload.query.actorId).toBe('viewer-1');
      expect(filteredPayload.query.action).toBe('session_details');
      expect(filteredPayload.query.result).toBe('success');

      const pagedResponse = await fetch(`${baseUrl}/audit-events?limit=1&offset=1`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(pagedResponse.status).toBe(200);
      const pagedPayload = await pagedResponse.json() as {
        events: ApiAuditEvent[];
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
      };
      expect(pagedPayload.limit).toBe(1);
      expect(pagedPayload.offset).toBe(1);
      expect(pagedPayload.total).toBeGreaterThanOrEqual(2);
      expect(pagedPayload.events).toHaveLength(1);
      expect(typeof pagedPayload.hasMore).toBe('boolean');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以按 session 查询 audit events', async () => {
    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
          { token: 'operator-token', actorId: 'viewer-1', role: 'operator' },
        ],
      },
      auditSink,
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      const created = await createResponse.json() as { sessionId: string };

      const detailsResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(detailsResponse.status).toBe(200);

      const auditResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/audit-events?action=session_details`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(auditResponse.status).toBe(200);
      const payload = await auditResponse.json() as {
        events: ApiAuditEvent[];
        query: { sessionId: string; action?: string };
      };
      expect(payload.events.length).toBeGreaterThanOrEqual(1);
      expect(payload.events.every((event) => event.sessionId === created.sessionId)).toBe(true);
      expect(payload.events.some((event) => event.action === 'session_details')).toBe(true);
      expect(payload.query.sessionId).toBe(created.sessionId);
      expect(payload.query.action).toBe('session_details');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('audit events 查询参数非法时返回 400', async () => {
    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink,
    });

    try {
      const response = await fetch(`${baseUrl}/audit-events?limit=0&result=maybe&from=not-a-date`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(response.status).toBe(400);
      const payload = await response.json() as {
        error: { code: string; message: string; requestId: string; retryable: boolean };
      };
      expect(payload.error.code).toBe('INVALID_QUERY_PARAM');
      expect(payload.error.retryable).toBe(false);
      expect(payload.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以通过持久化历史查询 audit events，并返回增强 metrics', async () => {
    const persistedAuditEvents = new FakeAuditEventRepository();
    const { server, baseUrl, toolExecutions, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: persistedAuditEvents,
    });

    try {
      await sessions.create({
        id: 'persisted-session-1',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await toolExecutions.create({
        id: 'exec-persisted-1',
        sessionId: 'persisted-session-1',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:02.000Z',
        durationMs: 2000,
        result: { success: true },
      });
      await persistedAuditEvents.create({
        timestamp: '2025-01-01T00:02:10.000Z',
        actorId: 'viewer-1',
        role: 'viewer',
        sessionId: 'persisted-session-1',
        action: 'session_details',
        result: 'success',
        statusCode: 200,
      });
      await persistedAuditEvents.create({
        timestamp: '2025-01-01T00:02:20.000Z',
        actorId: 'viewer-1',
        role: 'viewer',
        sessionId: 'persisted-session-1',
        action: 'system_metrics',
        result: 'failure',
        statusCode: 500,
        error: 'aggregation failed',
      });

      const auditResponse = await fetch(`${baseUrl}/audit-events?sessionId=persisted-session-1&result=success`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(auditResponse.status).toBe(200);
      const auditPayload = await auditResponse.json() as {
        events: ApiAuditEvent[];
        total: number;
      };
      expect(auditPayload.total).toBe(1);
      expect(auditPayload.events[0].action).toBe('session_details');

      const metricsResponse = await fetch(
        `${baseUrl}/metrics?from=2025-01-01T00:02:00.000Z&to=2025-01-01T00:02:59.000Z&bucketMinutes=1&topActionsLimit=1&actorLimit=1`,
        { headers: { authorization: 'Bearer viewer-token' } },
      );
      expect(metricsResponse.status).toBe(200);
      const metricsPayload = await metricsResponse.json() as {
        metrics: {
          toolExecutionCount: number;
          auditEventCount: number;
          auditFailureCount: number;
          toolFailureRate: number;
          auditFailureRate: number;
          auditEventsByAction: Record<string, { total: number; success: number; failure: number }>;
          topActions: Array<{ action: string; total: number; success: number; failure: number; failureRate: number }>;
          topFailedTools: Array<{ tool: string; total: number; failed: number; failureRate: number }>;
          slowestTools: Array<{ tool: string; countWithDuration: number; averageDurationMs: number; maxDurationMs: number }>;
          actors: Array<{ actorId: string; total: number; success: number; failure: number; failureRate: number; actions: Record<string, number> }>;
          timeline: Array<{
            startedAt: string;
            endedAt: string;
            toolExecutionCount: number;
            failedToolExecutionCount: number;
            toolFailureRate: number;
            auditEventCount: number;
            auditFailureCount: number;
            auditFailureRate: number;
          }>;
          window: { from?: string; to?: string; bucketMinutes: number };
        };
      };
      expect(metricsPayload.metrics.window.from).toBe('2025-01-01T00:02:00.000Z');
      expect(metricsPayload.metrics.window.to).toBe('2025-01-01T00:02:59.000Z');
      expect(metricsPayload.metrics.window.bucketMinutes).toBe(1);
      expect(metricsPayload.metrics.toolExecutionCount).toBe(1);
      expect(metricsPayload.metrics.auditEventCount).toBe(2);
      expect(metricsPayload.metrics.auditFailureCount).toBe(1);
      expect(metricsPayload.metrics.toolFailureRate).toBe(0);
      expect(metricsPayload.metrics.auditFailureRate).toBe(0.5);
      expect(metricsPayload.metrics.auditEventsByAction.session_details.total).toBe(1);
      expect(metricsPayload.metrics.auditEventsByAction.system_metrics.failure).toBe(1);
      expect(metricsPayload.metrics.topActions).toHaveLength(1);
      expect(metricsPayload.metrics.topActions[0]).toMatchObject({
        action: 'system_metrics',
        total: 1,
        success: 0,
        failure: 1,
        failureRate: 1,
      });
      expect(metricsPayload.metrics.topFailedTools).toHaveLength(0);
      expect(metricsPayload.metrics.slowestTools).toHaveLength(1);
      expect(metricsPayload.metrics.slowestTools[0]).toMatchObject({
        tool: 'create_comment',
        countWithDuration: 1,
        averageDurationMs: 2000,
        maxDurationMs: 2000,
      });
      expect(metricsPayload.metrics.actors).toHaveLength(1);
      expect(metricsPayload.metrics.actors[0]).toMatchObject({
        actorId: 'viewer-1',
        total: 2,
        success: 1,
        failure: 1,
      });
      expect(metricsPayload.metrics.actors[0].actions.session_details).toBe(1);
      expect(metricsPayload.metrics.timeline).toHaveLength(1);
      expect(metricsPayload.metrics.timeline[0]).toMatchObject({
        startedAt: '2025-01-01T00:02:00.000Z',
        toolExecutionCount: 1,
        failedToolExecutionCount: 0,
        auditEventCount: 2,
        auditFailureCount: 1,
        auditFailureRate: 0.5,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以查询和导出 sessions', async () => {
    const { server, baseUrl, sessions, confirmations, approvalGrants, toolExecutions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      await sessions.create({
        id: 'session-query-1',
        projectId: 'project-a',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
        lastInput: 'done',
      });
      await sessions.create({
        id: 'session-query-2',
        projectId: 'project-a',
        actorId: 'viewer-1',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await sessions.create({
        id: 'session-query-3',
        projectId: 'project-b',
        actorId: 'viewer-1',
        status: 'failed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
        lastError: 'boom',
      });
      await confirmations.createRequest({
        id: 'session-query-req-1',
        sessionId: 'session-query-2',
        projectId: 'project-a',
        tool: 'create_comment',
        riskLevel: 'medium',
        args: { ticketId: 'T-2' },
        reason: 'needs approval',
        status: 'pending',
        createdAt: '2025-01-01T00:03:05.000Z',
        updatedAt: '2025-01-01T00:03:05.000Z',
      });
      await confirmations.createRequest({
        id: 'session-query-req-2',
        sessionId: 'session-query-3',
        projectId: 'project-b',
        tool: 'delete_comment',
        riskLevel: 'high',
        args: { ticketId: 'T-3' },
        reason: 'dangerous cleanup',
        status: 'approved',
        createdAt: '2025-01-01T00:04:06.000Z',
        updatedAt: '2025-01-01T00:04:08.000Z',
      });
      await confirmations.appendDecision({
        id: 'session-query-decision-1',
        requestId: 'session-query-req-2',
        sessionId: 'session-query-3',
        decision: 'approved',
        actor: 'viewer-1',
        createdAt: '2025-01-01T00:04:08.000Z',
      });
      await confirmations.markApproved('session-query-req-2');
      await approvalGrants.createGrant({
        requestId: 'session-query-grant-1',
        sessionId: 'session-query-3',
        tool: 'create_comment',
        args: { ticketId: 'T-3' },
        approvedAt: '2025-01-01T00:04:05.000Z',
      });
      await toolExecutions.create({
        id: 'session-query-exec-1',
        sessionId: 'session-query-2',
        tool: 'create_comment',
        args: { ticketId: 'T-2' },
        status: 'waiting_confirmation',
        startedAt: '2025-01-01T00:03:10.000Z',
      });
      await toolExecutions.create({
        id: 'session-query-exec-2',
        sessionId: 'session-query-3',
        tool: 'delete_comment',
        args: { ticketId: 'T-3' },
        status: 'failed',
        startedAt: '2025-01-01T00:04:10.000Z',
        finishedAt: '2025-01-01T00:04:12.000Z',
        durationMs: 2000,
        error: 'boom',
      });
      await toolExecutions.create({
        id: 'session-query-exec-3',
        sessionId: 'session-query-3',
        tool: 'retry_delete_comment',
        args: { ticketId: 'T-3' },
        status: 'finished',
        startedAt: '2025-01-01T00:04:20.000Z',
        finishedAt: '2025-01-01T00:04:21.000Z',
        durationMs: 1000,
        result: { success: true },
      });

      const response = await fetch(`${baseUrl}/sessions?projectId=project-a&status=waiting_confirmation&limit=1&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        records: Array<{
          id: string;
          projectId: string;
          status: string;
          messageCount: number;
          pendingConfirmationCount: number;
          activeGrantCount: number;
          toolExecutionCount: number;
          failedToolExecutionCount: number;
          lastToolExecutionStatus?: string;
          lastToolName?: string;
          lastToolStartedAt?: string;
          lastConfirmationTool?: string;
          lastConfirmationRiskLevel?: string;
          lastConfirmationCreatedAt?: string;
          lastDecision?: string;
          lastDecisionAt?: string;
          derivedState: {
            needsAttention: boolean;
            approvalState: string;
            executionState: string;
          };
          queueMatches: string[];
        }>;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        query: {
          projectId?: string;
          status?: string;
          hasPendingConfirmation?: boolean;
          hasActiveGrant?: boolean;
          lastToolExecutionStatus?: string;
          lastConfirmationRiskLevel?: string;
          lastDecision?: string;
          hasFailedToolExecution?: boolean;
          needsAttention?: boolean;
          approvalState?: string;
          executionState?: string;
          queue?: string;
          sortBy?: string;
          sortOrder?: string;
          limit: number;
          offset: number;
        };
      };
      expect(payload.total).toBe(1);
      expect(payload.records).toHaveLength(1);
      expect(payload.records[0]).toMatchObject({
        id: 'session-query-2',
        projectId: 'project-a',
        status: 'waiting_confirmation',
        messageCount: 0,
        pendingConfirmationCount: 1,
        activeGrantCount: 0,
        toolExecutionCount: 1,
        failedToolExecutionCount: 0,
        lastToolExecutionStatus: 'waiting_confirmation',
        lastToolName: 'create_comment',
        lastToolStartedAt: '2025-01-01T00:03:10.000Z',
        lastConfirmationTool: 'create_comment',
        lastConfirmationRiskLevel: 'medium',
        lastConfirmationCreatedAt: '2025-01-01T00:03:05.000Z',
        derivedState: {
          needsAttention: true,
          approvalState: 'blocked',
          executionState: 'waiting',
        },
        queueMatches: ['attention', 'blocked'],
      });
      expect(payload.records[0]).not.toHaveProperty('lastDecision');
      expect(payload.records[0]).not.toHaveProperty('lastDecisionAt');
      expect(payload.hasMore).toBe(false);
      expect(payload.query).toMatchObject({ projectId: 'project-a', status: 'waiting_confirmation', limit: 1, offset: 0 });

      const exportResponse = await fetch(`${baseUrl}/sessions/export?from=2025-01-01T00:02:30.000Z&format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get('content-type')).toContain('text/csv');
      expect(exportResponse.headers.get('content-disposition')).toContain('sessions-export.csv');
      const csv = await exportResponse.text();
      expect(csv).toContain('session-query-2');
      expect(csv).toContain('session-query-3');
      expect(csv).toContain('messageCount');
      expect(csv).toContain('pendingConfirmationCount');
      expect(csv).toContain('activeGrantCount');
      expect(csv).toContain('toolExecutionCount');
      expect(csv).toContain('failedToolExecutionCount');
      expect(csv).toContain('lastToolExecutionStatus');
      expect(csv).toContain('lastToolName');
      expect(csv).toContain('lastToolStartedAt');
      expect(csv).toContain('lastConfirmationTool');
      expect(csv).toContain('lastConfirmationRiskLevel');
      expect(csv).toContain('lastConfirmationCreatedAt');
      expect(csv).toContain('lastDecision');
      expect(csv).toContain('lastDecisionAt');
      expect(csv).toContain('needsAttention');
      expect(csv).toContain('approvalState');
      expect(csv).toContain('executionState');
      expect(csv).toContain('queueMatches');
      expect(csv).toContain('attention|blocked');
      expect(csv).not.toContain('session-query-1');

      const filteredResponse = await fetch(`${baseUrl}/sessions?hasActiveGrant=false&hasPendingConfirmation=false&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(filteredResponse.status).toBe(200);
      const filteredPayload = await filteredResponse.json() as {
        records: Array<{ id: string }>;
        total: number;
        query: { hasPendingConfirmation?: boolean; hasActiveGrant?: boolean };
      };
      expect(filteredPayload.records.map((entry) => entry.id)).toEqual(['session-query-1']);
      expect(filteredPayload.query).toMatchObject({ hasPendingConfirmation: false, hasActiveGrant: false });

      const pendingResponse = await fetch(`${baseUrl}/sessions?hasPendingConfirmation=true&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(pendingResponse.status).toBe(200);
      const pendingPayload = await pendingResponse.json() as { records: Array<{ id: string }> };
      expect(pendingPayload.records.map((entry) => entry.id)).toEqual(['session-query-2']);

      const grantResponse = await fetch(`${baseUrl}/sessions?hasActiveGrant=true&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(grantResponse.status).toBe(200);
      const grantPayload = await grantResponse.json() as { records: Array<{ id: string }> };
      expect(grantPayload.records.map((entry) => entry.id)).toEqual(['session-query-3']);

      const advancedFilteredResponse = await fetch(`${baseUrl}/sessions?lastToolExecutionStatus=waiting_confirmation&lastConfirmationRiskLevel=medium&hasFailedToolExecution=false&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(advancedFilteredResponse.status).toBe(200);
      const advancedFilteredPayload = await advancedFilteredResponse.json() as {
        records: Array<{ id: string }>;
        query: {
          lastToolExecutionStatus?: string;
          lastConfirmationRiskLevel?: string;
          hasFailedToolExecution?: boolean;
        };
      };
      expect(advancedFilteredPayload.records.map((entry) => entry.id)).toEqual(['session-query-2']);
      expect(advancedFilteredPayload.query).toMatchObject({
        lastToolExecutionStatus: 'waiting_confirmation',
        lastConfirmationRiskLevel: 'medium',
        hasFailedToolExecution: false,
      });

      const rejectedDecisionResponse = await fetch(`${baseUrl}/sessions?lastDecision=approved&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(rejectedDecisionResponse.status).toBe(200);
      const rejectedDecisionPayload = await rejectedDecisionResponse.json() as { records: Array<{ id: string }> };
      expect(rejectedDecisionPayload.records.map((entry) => entry.id)).toEqual(['session-query-3']);

      const needsAttentionResponse = await fetch(`${baseUrl}/sessions?needsAttention=true&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(needsAttentionResponse.status).toBe(200);
      const needsAttentionPayload = await needsAttentionResponse.json() as {
        records: Array<{ id: string }>;
        query: { needsAttention?: boolean };
      };
      expect(needsAttentionPayload.records.map((entry) => entry.id)).toEqual(['session-query-3', 'session-query-2']);
      expect(needsAttentionPayload.query).toMatchObject({ needsAttention: true });

      const approvalStateResponse = await fetch(`${baseUrl}/sessions?approvalState=blocked&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(approvalStateResponse.status).toBe(200);
      const approvalStatePayload = await approvalStateResponse.json() as {
        records: Array<{ id: string }>;
        query: { approvalState?: string };
      };
      expect(approvalStatePayload.records.map((entry) => entry.id)).toEqual(['session-query-2']);
      expect(approvalStatePayload.query).toMatchObject({ approvalState: 'blocked' });

      const executionStateResponse = await fetch(`${baseUrl}/sessions?executionState=completed&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(executionStateResponse.status).toBe(200);
      const executionStatePayload = await executionStateResponse.json() as {
        records: Array<{ id: string }>;
        query: { executionState?: string };
      };
      expect(executionStatePayload.records.map((entry) => entry.id)).toEqual(['session-query-3']);
      expect(executionStatePayload.query).toMatchObject({ executionState: 'completed' });

      const combinedShortcutResponse = await fetch(`${baseUrl}/sessions?needsAttention=true&approvalState=blocked&executionState=waiting&lastConfirmationRiskLevel=medium&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(combinedShortcutResponse.status).toBe(200);
      const combinedShortcutPayload = await combinedShortcutResponse.json() as { records: Array<{ id: string }> };
      expect(combinedShortcutPayload.records.map((entry) => entry.id)).toEqual(['session-query-2']);

      const queueAttentionResponse = await fetch(`${baseUrl}/sessions?queue=attention&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(queueAttentionResponse.status).toBe(200);
      const queueAttentionPayload = await queueAttentionResponse.json() as {
        records: Array<{ id: string }>;
        query: { queue?: string };
      };
      expect(queueAttentionPayload.records.map((entry) => entry.id)).toEqual(['session-query-3', 'session-query-2']);
      expect(queueAttentionPayload.query).toMatchObject({ queue: 'attention' });

      const queueBlockedResponse = await fetch(`${baseUrl}/sessions?queue=blocked&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(queueBlockedResponse.status).toBe(200);
      const queueBlockedPayload = await queueBlockedResponse.json() as { records: Array<{ id: string }> };
      expect(queueBlockedPayload.records.map((entry) => entry.id)).toEqual(['session-query-2']);

      const queueFailedResponse = await fetch(`${baseUrl}/sessions?queue=failed&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(queueFailedResponse.status).toBe(200);
      const queueFailedPayload = await queueFailedResponse.json() as { records: Array<{ id: string }> };
      expect(queueFailedPayload.records).toHaveLength(0);

      const queueIdleExportResponse = await fetch(`${baseUrl}/sessions/export?queue=idle&format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(queueIdleExportResponse.status).toBe(200);
      const queueIdleCsv = await queueIdleExportResponse.text();
      expect(queueIdleCsv).toContain('session-query-1');
      expect(queueIdleCsv).not.toContain('session-query-2');
      expect(queueIdleCsv).not.toContain('session-query-3');

      const sortedByUpdatedAtAsc = await fetch(`${baseUrl}/sessions?sortBy=updatedAt&sortOrder=asc&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sortedByUpdatedAtAsc.status).toBe(200);
      const sortedByUpdatedAtAscPayload = await sortedByUpdatedAtAsc.json() as {
        records: Array<{ id: string }>;
        query: { sortBy?: string; sortOrder?: string };
      };
      expect(sortedByUpdatedAtAscPayload.records.map((entry) => entry.id)).toEqual(['session-query-1', 'session-query-2', 'session-query-3']);
      expect(sortedByUpdatedAtAscPayload.query).toMatchObject({ sortBy: 'updatedAt', sortOrder: 'asc' });

      const sortedByActiveGrant = await fetch(`${baseUrl}/sessions?sortBy=activeGrantCount&sortOrder=desc&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sortedByActiveGrant.status).toBe(200);
      const sortedByActiveGrantPayload = await sortedByActiveGrant.json() as { records: Array<{ id: string }> };
      expect(sortedByActiveGrantPayload.records.map((entry) => entry.id)).toEqual(['session-query-3', 'session-query-2', 'session-query-1']);

      const sortedByToolExecutionCount = await fetch(`${baseUrl}/sessions?sortBy=toolExecutionCount&sortOrder=desc&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sortedByToolExecutionCount.status).toBe(200);
      const sortedByToolExecutionCountPayload = await sortedByToolExecutionCount.json() as { records: Array<{ id: string }> };
      expect(sortedByToolExecutionCountPayload.records.map((entry) => entry.id)).toEqual(['session-query-3', 'session-query-2', 'session-query-1']);

      const sortedByLastToolStartedAt = await fetch(`${baseUrl}/sessions?sortBy=lastToolStartedAt&sortOrder=desc&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sortedByLastToolStartedAt.status).toBe(200);
      const sortedByLastToolStartedAtPayload = await sortedByLastToolStartedAt.json() as { records: Array<{ id: string }> };
      expect(sortedByLastToolStartedAtPayload.records.map((entry) => entry.id)).toEqual(['session-query-3', 'session-query-2', 'session-query-1']);

      const sortedByLastConfirmationCreatedAt = await fetch(`${baseUrl}/sessions?sortBy=lastConfirmationCreatedAt&sortOrder=desc&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sortedByLastConfirmationCreatedAt.status).toBe(200);
      const sortedByLastConfirmationCreatedAtPayload = await sortedByLastConfirmationCreatedAt.json() as { records: Array<{ id: string }> };
      expect(sortedByLastConfirmationCreatedAtPayload.records.map((entry) => entry.id)).toEqual(['session-query-3', 'session-query-2', 'session-query-1']);

      const sortedByLastDecisionAt = await fetch(`${baseUrl}/sessions?sortBy=lastDecisionAt&sortOrder=desc&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sortedByLastDecisionAt.status).toBe(200);
      const sortedByLastDecisionAtPayload = await sortedByLastDecisionAt.json() as { records: Array<{ id: string }> };
      expect(sortedByLastDecisionAtPayload.records.map((entry) => entry.id)).toEqual(['session-query-3', 'session-query-2', 'session-query-1']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('sessions 查询参数非法时返回 400', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      const response = await fetch(`${baseUrl}/sessions?status=unknown&limit=0&from=bad-date&hasPendingConfirmation=yes&lastToolExecutionStatus=unknown&lastConfirmationRiskLevel=critical&lastDecision=maybe&hasFailedToolExecution=nope&needsAttention=alert&approvalState=stuck&executionState=paused&queue=stalled&sortBy=unknown&sortOrder=down`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(response.status).toBe(400);
      const payload = await response.json() as {
        error: { code: string; message: string; requestId: string };
      };
      expect(payload.error.code).toBe('INVALID_QUERY_PARAM');
      expect(payload.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以查询和导出全局 tool executions', async () => {
    const { server, baseUrl, toolExecutions, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      await sessions.create({
        id: 'global-tool-session-1',
        projectId: 'project-a',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      });
      await sessions.create({
        id: 'global-tool-session-2',
        projectId: 'project-b',
        actorId: 'viewer-1',
        status: 'failed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await toolExecutions.create({
        id: 'global-exec-1',
        sessionId: 'global-tool-session-1',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:01:00.000Z',
        finishedAt: '2025-01-01T00:01:01.000Z',
        durationMs: 1000,
        result: { success: true },
      });
      await toolExecutions.create({
        id: 'global-exec-2',
        sessionId: 'global-tool-session-2',
        tool: 'delete_comment',
        args: { ticketId: 'T-2' },
        status: 'failed',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:01.000Z',
        durationMs: 1000,
        error: 'forbidden',
      });

      const queryResponse = await fetch(`${baseUrl}/tool-executions?projectId=project-b&status=failed&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(queryResponse.status).toBe(200);
      const queryPayload = await queryResponse.json() as {
        records: ToolExecutionRecord[];
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        query: { projectId?: string; status?: string };
      };
      expect(queryPayload.total).toBe(1);
      expect(queryPayload.records).toHaveLength(1);
      expect(queryPayload.records[0].id).toBe('global-exec-2');
      expect(queryPayload.query.projectId).toBe('project-b');
      expect(queryPayload.query.status).toBe('failed');

      const exportResponse = await fetch(`${baseUrl}/tool-executions/export?tool=delete_comment&format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get('content-type')).toContain('text/csv');
      expect(exportResponse.headers.get('content-disposition')).toContain('tool-executions-export.csv');
      const exportBody = await exportResponse.text();
      expect(exportBody).toContain('"global-exec-2"');
      expect(exportBody).toContain('"delete_comment"');
      expect(exportBody).not.toContain('"global-exec-1"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('不会在 tool execution 查询和导出中泄漏敏感字段', async () => {
    const { server, baseUrl, toolExecutions, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      await sessions.create({
        id: 'secret-tool-session-1',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await toolExecutions.create({
        id: 'secret-exec-1',
        sessionId: 'secret-tool-session-1',
        tool: 'create_comment',
        callId: 'call-secret-1',
        args: {
          ticketId: 'T-secret',
          apiToken: 'raw-arg-token',
          nested: {
            password: 'raw-arg-password',
            headers: {
              authorization: 'Bearer raw-arg-bearer',
            },
          },
        },
        status: 'finished',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:01.000Z',
        durationMs: 1000,
        result: {
          success: true,
          metadata: {
            apiKey: 'raw-result-api-key',
            authorization: 'Bearer raw-result-bearer',
          },
          message: 'posted with Bearer raw-message-bearer',
        },
      });

      const queryResponse = await fetch(`${baseUrl}/tool-executions?tool=create_comment&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(queryResponse.status).toBe(200);
      const queryBody = await queryResponse.text();
      expect(queryBody).toContain('[REDACTED]');
      expect(queryBody).toContain('Bearer [REDACTED]');
      expect(queryBody).not.toContain('raw-arg-token');
      expect(queryBody).not.toContain('raw-arg-password');
      expect(queryBody).not.toContain('raw-arg-bearer');
      expect(queryBody).not.toContain('raw-result-api-key');
      expect(queryBody).not.toContain('raw-result-bearer');
      expect(queryBody).not.toContain('raw-message-bearer');

      const jsonlExportResponse = await fetch(`${baseUrl}/tool-executions/export?tool=create_comment&format=jsonl`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(jsonlExportResponse.status).toBe(200);
      const jsonlExportBody = await jsonlExportResponse.text();
      expect(jsonlExportBody).toContain('[REDACTED]');
      expect(jsonlExportBody).not.toContain('raw-arg-token');
      expect(jsonlExportBody).not.toContain('raw-arg-password');
      expect(jsonlExportBody).not.toContain('raw-arg-bearer');
      expect(jsonlExportBody).not.toContain('raw-result-api-key');
      expect(jsonlExportBody).not.toContain('raw-result-bearer');
      expect(jsonlExportBody).not.toContain('raw-message-bearer');

      const csvExportResponse = await fetch(`${baseUrl}/tool-executions/export?tool=create_comment&format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(csvExportResponse.status).toBe(200);
      const csvExportBody = await csvExportResponse.text();
      expect(csvExportBody).toContain('[REDACTED]');
      expect(csvExportBody).not.toContain('raw-arg-token');
      expect(csvExportBody).not.toContain('raw-arg-password');
      expect(csvExportBody).not.toContain('raw-arg-bearer');
      expect(csvExportBody).not.toContain('raw-result-api-key');
      expect(csvExportBody).not.toContain('raw-result-bearer');
      expect(csvExportBody).not.toContain('raw-message-bearer');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('applies project-specific redaction keys to tool execution query responses', async () => {
    const project = {
      ...createConfirmationProject(),
      security: {
        redaction: {
          extraSensitiveKeys: ['employeeIdCard', 'mobile_phone'],
          replacement: '[MASKED]',
        },
      },
    } as ReturnType<typeof createConfirmationProject>;
    const { server, baseUrl, toolExecutions, sessions } = await startTestServer({
      project,
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      await sessions.create({
        id: 'project-redaction-session-1',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await toolExecutions.create({
        id: 'project-redaction-exec-1',
        sessionId: 'project-redaction-session-1',
        tool: 'create_comment',
        callId: 'call-project-redaction-1',
        args: {
          employeeIdCard: 'raw-id-card',
          mobile_phone: 'raw-mobile-phone',
          userId: 'USER-001',
        },
        status: 'finished',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:01.000Z',
        durationMs: 1000,
        result: {
          success: true,
          data: {
            mobilePhone: 'raw-result-mobile',
          },
        },
      });

      const response = await fetch(`${baseUrl}/tool-executions?tool=create_comment&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('[MASKED]');
      expect(body).toContain('USER-001');
      expect(body).not.toContain('raw-id-card');
      expect(body).not.toContain('raw-mobile-phone');
      expect(body).not.toContain('raw-result-mobile');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('不会在 confirmation 查询响应中泄漏敏感 args', async () => {
    const { server, baseUrl, confirmations, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      await sessions.create({
        id: 'secret-confirmation-session-1',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await confirmations.createRequest({
        id: 'secret-confirmation-1',
        sessionId: 'secret-confirmation-session-1',
        projectId: 'confirmation-demo-project',
        tool: 'create_comment',
        riskLevel: 'high',
        args: {
          ticketId: 'T-secret',
          accessToken: 'raw-confirmation-token',
          headers: {
            authorization: 'Bearer raw-confirmation-bearer',
          },
        },
        reason: 'requires confirmation',
        status: 'pending',
        createdAt: '2025-01-01T00:02:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      });

      const response = await fetch(`${baseUrl}/confirmations?tool=create_comment&limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('[REDACTED]');
      expect(body).not.toContain('raw-confirmation-token');
      expect(body).not.toContain('raw-confirmation-bearer');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('会在内存审计 sink 中脱敏敏感 metadata', () => {
    const sink = new InMemoryApiAuditSink();
    sink.emit({
      timestamp: '2025-01-01T00:00:00.000Z',
      action: 'secret_audit_event',
      result: 'success',
      metadata: {
        token: 'raw-audit-token',
        headers: {
          authorization: 'Bearer raw-audit-bearer',
        },
        nested: {
          apiKey: 'raw-audit-api-key',
        },
        message: 'called with Bearer raw-audit-message-bearer',
      },
    });

    const payload = JSON.stringify(sink.query().events);
    expect(payload).toContain('[REDACTED]');
    expect(payload).toContain('Bearer [REDACTED]');
    expect(payload).not.toContain('raw-audit-token');
    expect(payload).not.toContain('raw-audit-bearer');
    expect(payload).not.toContain('raw-audit-api-key');
    expect(payload).not.toContain('raw-audit-message-bearer');
  });

  it('全局 tool execution 查询参数非法时返回 400', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      const response = await fetch(`${baseUrl}/tool-executions?status=unknown`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(response.status).toBe(400);
      const payload = await response.json() as { error: { code: string } };
      expect(payload.error.code).toBe('INVALID_QUERY_PARAM');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以导出 session 级 audit events 为 jsonl 与 csv', async () => {
    const persistedAuditEvents = new FakeAuditEventRepository();
    const { server, baseUrl, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'operator-1', role: 'viewer' },
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: persistedAuditEvents,
    });

    try {
      await sessions.create({
        id: 'session-export-1',
        projectId: 'confirmation-demo-project',
        actorId: 'operator-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      });
      await sessions.create({
        id: 'session-export-2',
        projectId: 'confirmation-demo-project',
        actorId: 'operator-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await persistedAuditEvents.create({
        timestamp: '2025-01-01T00:02:10.000Z',
        actorId: 'viewer-1',
        role: 'viewer',
        sessionId: 'session-export-1',
        action: 'session_details',
        result: 'success',
        statusCode: 200,
      });
      await persistedAuditEvents.create({
        timestamp: '2025-01-01T00:03:10.000Z',
        actorId: 'viewer-1',
        role: 'viewer',
        sessionId: 'session-export-2',
        action: 'session_details',
        result: 'success',
        statusCode: 200,
      });

      const jsonlResponse = await fetch(`${baseUrl}/sessions/session-export-1/audit-events/export?format=jsonl`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(jsonlResponse.status).toBe(200);
      expect(jsonlResponse.headers.get('content-type')).toContain('application/x-ndjson');
      expect(jsonlResponse.headers.get('content-disposition')).toContain('session-session-export-1-audit-events-export.jsonl');
      const jsonlBody = await jsonlResponse.text();
      const jsonlLines = jsonlBody.trim().split('\n');
      expect(jsonlLines).toHaveLength(1);
      expect(JSON.parse(jsonlLines[0])).toMatchObject({ sessionId: 'session-export-1', action: 'session_details' });

      const csvResponse = await fetch(`${baseUrl}/sessions/session-export-1/audit-events/export?format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(csvResponse.status).toBe(200);
      expect(csvResponse.headers.get('content-type')).toContain('text/csv');
      expect(csvResponse.headers.get('content-disposition')).toContain('session-session-export-1-audit-events-export.csv');
      const csvBody = await csvResponse.text();
      expect(csvBody).toContain('"session-export-1"');
      expect(csvBody).not.toContain('"session-export-2"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以导出 session 级 tool executions 为 jsonl 与 csv', async () => {
    const { server, baseUrl, toolExecutions, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      await sessions.create({
        id: 'session-export-3',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await sessions.create({
        id: 'session-export-4',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
      });
      await toolExecutions.create({
        id: 'exec-export-1',
        sessionId: 'session-export-3',
        tool: 'create_comment',
        args: { ticketId: 'T-3' },
        status: 'finished',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:02.000Z',
        durationMs: 2000,
        result: { success: true },
      });
      await toolExecutions.create({
        id: 'exec-export-1b',
        sessionId: 'session-export-3',
        tool: 'sync_ticket',
        args: { ticketId: 'T-3' },
        status: 'failed',
        startedAt: '2025-01-01T00:02:30.000Z',
        finishedAt: '2025-01-01T00:02:31.000Z',
        durationMs: 1000,
        error: 'network failed',
      });
      await toolExecutions.create({
        id: 'exec-export-2',
        sessionId: 'session-export-4',
        tool: 'delete_comment',
        args: { ticketId: 'T-4' },
        status: 'failed',
        startedAt: '2025-01-01T00:03:00.000Z',
        finishedAt: '2025-01-01T00:03:01.000Z',
        durationMs: 1000,
        error: 'forbidden',
      });

      const jsonlResponse = await fetch(`${baseUrl}/sessions/session-export-3/tool-executions/export?tool=create_comment&format=jsonl`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(jsonlResponse.status).toBe(200);
      expect(jsonlResponse.headers.get('content-type')).toContain('application/x-ndjson');
      expect(jsonlResponse.headers.get('content-disposition')).toContain('session-session-export-3-tool-executions-export.jsonl');
      const jsonlBody = await jsonlResponse.text();
      const jsonlLines = jsonlBody.trim().split('\n');
      expect(jsonlLines).toHaveLength(1);
      expect(JSON.parse(jsonlLines[0])).toMatchObject({ sessionId: 'session-export-3', tool: 'create_comment', status: 'finished' });

      const csvResponse = await fetch(`${baseUrl}/sessions/session-export-3/tool-executions/export?status=failed&format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(csvResponse.status).toBe(200);
      expect(csvResponse.headers.get('content-type')).toContain('text/csv');
      expect(csvResponse.headers.get('content-disposition')).toContain('session-session-export-3-tool-executions-export.csv');
      const csvBody = await csvResponse.text();
      expect(csvBody).toContain('"exec-export-1b"');
      expect(csvBody).toContain('"sync_ticket"');
      expect(csvBody).not.toContain('"exec-export-1"');
      expect(csvBody).not.toContain('"exec-export-2"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以查询与导出 confirmations / confirmation decisions', async () => {
    const { server, baseUrl, confirmations } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(createResponse.status).toBe(403);

      const operatorServer = await startTestServer({
        auth: {
          enabled: true,
          tokens: [
            { token: 'viewer-token', actorId: 'operator-1', role: 'viewer' },
            { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
          ],
        },
        auditSink: new ConsoleApiAuditSink(),
        auditEvents: new FakeAuditEventRepository(),
      });

      try {
        const realCreateResponse = await fetch(`${operatorServer.baseUrl}/sessions`, {
          method: 'POST',
          headers: { authorization: 'Bearer operator-token' },
        });
        expect(realCreateResponse.status).toBe(201);
        const created = await realCreateResponse.json() as { sessionId: string };

        operatorServer.confirmations.createdRequests.push(
          {
            id: 'req-query-1',
            sessionId: created.sessionId,
            projectId: 'confirmation-demo-project',
            tool: 'create_comment',
            riskLevel: 'high',
            args: { ticketId: 'T-1' },
            reason: 'requires confirmation',
            status: 'pending',
            createdAt: '2025-01-01T00:02:00.000Z',
            updatedAt: '2025-01-01T00:02:00.000Z',
          },
          {
            id: 'req-query-2',
            sessionId: created.sessionId,
            projectId: 'confirmation-demo-project',
            tool: 'delete_comment',
            riskLevel: 'medium',
            args: { ticketId: 'T-2' },
            reason: 'cleanup',
            status: 'approved',
            createdAt: '2025-01-01T00:03:00.000Z',
            updatedAt: '2025-01-01T00:03:10.000Z',
          },
          {
            id: 'req-query-3',
            sessionId: 'session-query-2',
            projectId: 'confirmation-demo-project',
            tool: 'sync_ticket',
            riskLevel: 'low',
            args: { ticketId: 'T-3' },
            reason: 'sync',
            status: 'rejected',
            createdAt: '2025-01-01T00:04:00.000Z',
            updatedAt: '2025-01-01T00:04:10.000Z',
          },
        );
        operatorServer.confirmations.decisions.push(
          {
            id: 'decision-query-1',
            requestId: 'req-query-2',
            sessionId: created.sessionId,
            decision: 'approved',
            actor: 'approver-1',
            reason: 'safe',
            createdAt: '2025-01-01T00:03:05.000Z',
          },
          {
            id: 'decision-query-2',
            requestId: 'req-query-3',
            sessionId: 'session-query-2',
            decision: 'rejected',
            actor: 'approver-2',
            reason: 'too risky',
            createdAt: '2025-01-01T00:04:05.000Z',
          },
        );

        const globalResponse = await fetch(`${operatorServer.baseUrl}/confirmations?status=approved&limit=10&offset=0`, {
          headers: { authorization: 'Bearer viewer-token' },
        });
        expect(globalResponse.status).toBe(200);
        const globalPayload = await globalResponse.json() as {
          total: number;
          records: Array<{ id: string; tool: string }>;
        };
        expect(globalPayload.total).toBe(1);
        expect(globalPayload.records[0]).toMatchObject({ id: 'req-query-2', tool: 'delete_comment' });

        const sessionResponse = await fetch(`${operatorServer.baseUrl}/sessions/${created.sessionId}/confirmations?tool=create_comment&limit=10&offset=0`, {
          headers: { authorization: 'Bearer viewer-token' },
        });
        expect(sessionResponse.status).toBe(200);
        const sessionPayload = await sessionResponse.json() as {
          total: number;
          records: Array<{ id: string }>;
        };
        expect(sessionPayload.total).toBe(1);
        expect(sessionPayload.records[0].id).toBe('req-query-1');

        const decisionsResponse = await fetch(`${operatorServer.baseUrl}/confirmations/decisions?decision=rejected&limit=10&offset=0`, {
          headers: { authorization: 'Bearer viewer-token' },
        });
        expect(decisionsResponse.status).toBe(200);
        const decisionsPayload = await decisionsResponse.json() as {
          total: number;
          records: Array<{ id: string; actor?: string }>;
        };
        expect(decisionsPayload.total).toBe(0);
        expect(decisionsPayload.records).toEqual([]);

        const exportResponse = await fetch(`${operatorServer.baseUrl}/sessions/${created.sessionId}/confirmation-decisions/export?format=csv&actor=approver-1`, {
          headers: { authorization: 'Bearer viewer-token' },
        });
        expect(exportResponse.status).toBe(200);
        expect(exportResponse.headers.get('content-type')).toContain('text/csv');
        expect(exportResponse.headers.get('content-disposition')).toContain(`session-${created.sessionId}-confirmation-decisions-export.csv`);
        const exportBody = await exportResponse.text();
        expect(exportBody).toContain('"decision-query-1"');
        expect(exportBody).toContain('"approver-1"');
        expect(exportBody).not.toContain('"decision-query-2"');
      } finally {
        await new Promise<void>((resolve, reject) => operatorServer.server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('session 级导出在 session 不存在时返回 404', async () => {
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: new FakeAuditEventRepository(),
    });

    try {
      const toolExportResponse = await fetch(`${baseUrl}/sessions/missing-session/tool-executions/export?format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(toolExportResponse.status).toBe(404);
      const toolExportPayload = await toolExportResponse.json() as { error: { code: string } };
      expect(toolExportPayload.error.code).toBe('SESSION_NOT_FOUND');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以导出 audit events 为 jsonl 与 csv', async () => {
    const persistedAuditEvents = new FakeAuditEventRepository();
    const { server, baseUrl, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: persistedAuditEvents,
    });

    try {
      await sessions.create({
        id: 'persisted-session-1',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      });
      await persistedAuditEvents.create({
        timestamp: '2025-01-01T00:02:10.000Z',
        actorId: 'viewer-1',
        role: 'viewer',
        sessionId: 'persisted-session-1',
        action: 'session_details',
        result: 'success',
        statusCode: 200,
        metadata: { source: 'test' },
      });

      const jsonlResponse = await fetch(`${baseUrl}/audit-events/export?sessionId=persisted-session-1&format=jsonl`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(jsonlResponse.status).toBe(200);
      expect(jsonlResponse.headers.get('content-type')).toContain('application/x-ndjson');
      expect(jsonlResponse.headers.get('content-disposition')).toContain('audit-events-export.jsonl');
      const jsonlBody = await jsonlResponse.text();
      const jsonlLines = jsonlBody.trim().split('\n');
      expect(jsonlLines).toHaveLength(1);
      expect(JSON.parse(jsonlLines[0])).toMatchObject({
        sessionId: 'persisted-session-1',
        action: 'session_details',
        result: 'success',
      });

      const csvResponse = await fetch(`${baseUrl}/audit-events/export?sessionId=persisted-session-1&format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(csvResponse.status).toBe(200);
      expect(csvResponse.headers.get('content-type')).toContain('text/csv');
      expect(csvResponse.headers.get('content-disposition')).toContain('audit-events-export.csv');
      const csvBody = await csvResponse.text();
      expect(csvBody).toContain('"timestamp","requestId","method"');
      expect(csvBody).toContain('"persisted-session-1"');
      expect(csvBody).toContain('"session_details"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('可以导出 metrics 为 jsonl 与 csv', async () => {
    const persistedAuditEvents = new FakeAuditEventRepository();
    const { server, baseUrl, toolExecutions, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: persistedAuditEvents,
    });

    try {
      await sessions.create({
        id: 'persisted-session-2',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await toolExecutions.create({
        id: 'exec-persisted-2',
        sessionId: 'persisted-session-2',
        tool: 'create_comment',
        args: { ticketId: 'T-2' },
        status: 'finished',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:01.000Z',
        durationMs: 1000,
        result: { success: true },
      });
      await toolExecutions.create({
        id: 'exec-persisted-3',
        sessionId: 'persisted-session-2',
        tool: 'delete_comment',
        args: { ticketId: 'T-3' },
        status: 'failed',
        startedAt: '2025-01-01T00:02:10.000Z',
        finishedAt: '2025-01-01T00:02:13.000Z',
        durationMs: 3000,
        error: 'forbidden',
      });
      await persistedAuditEvents.create({
        timestamp: '2025-01-01T00:02:20.000Z',
        actorId: 'viewer-1',
        role: 'viewer',
        sessionId: 'persisted-session-2',
        action: 'system_metrics',
        result: 'success',
        statusCode: 200,
      });

      const jsonlResponse = await fetch(`${baseUrl}/metrics/export?from=2025-01-01T00:02:00.000Z&to=2025-01-01T00:02:59.000Z&bucketMinutes=1&format=jsonl`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(jsonlResponse.status).toBe(200);
      expect(jsonlResponse.headers.get('content-type')).toContain('application/x-ndjson');
      expect(jsonlResponse.headers.get('content-disposition')).toContain('metrics-export.jsonl');
      const jsonlBody = await jsonlResponse.text();
      expect(JSON.parse(jsonlBody)).toMatchObject({
        toolExecutionCount: 2,
        failedToolExecutionCount: 1,
        auditEventCount: 1,
        topFailedTools: [
          { tool: 'delete_comment', total: 1, failed: 1, failureRate: 1 },
        ],
        slowestTools: [
          { tool: 'delete_comment', countWithDuration: 1, averageDurationMs: 3000, maxDurationMs: 3000 },
          { tool: 'create_comment', countWithDuration: 1, averageDurationMs: 1000, maxDurationMs: 1000 },
        ],
        window: { from: '2025-01-01T00:02:00.000Z', to: '2025-01-01T00:02:59.000Z', bucketMinutes: 1 },
      });

      const csvResponse = await fetch(`${baseUrl}/metrics/export?from=2025-01-01T00:02:00.000Z&to=2025-01-01T00:02:59.000Z&bucketMinutes=1&format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(csvResponse.status).toBe(200);
      expect(csvResponse.headers.get('content-type')).toContain('text/csv');
      expect(csvResponse.headers.get('content-disposition')).toContain('metrics-export.csv');
      const csvBody = await csvResponse.text();
      expect(csvBody).toContain('"window.from"');
      expect(csvBody).toContain('"window.bucketMinutes"');
      expect(csvBody).toContain('"toolExecutionCount"');
      expect(csvBody).toContain('"topFailedTools"');
      expect(csvBody).toContain('"slowestTools"');
      expect(csvBody).toContain('"delete_comment"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('导出 format 非法时返回 400', async () => {
    const persistedAuditEvents = new FakeAuditEventRepository();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink: new ConsoleApiAuditSink(),
      auditEvents: persistedAuditEvents,
    });

    try {
      const auditExportResponse = await fetch(`${baseUrl}/audit-events/export?format=xml`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(auditExportResponse.status).toBe(400);
      const auditExportPayload = await auditExportResponse.json() as {
        error: { code: string; message: string };
      };
      expect(auditExportPayload.error.code).toBe('INVALID_QUERY_PARAM');

      const metricsExportResponse = await fetch(`${baseUrl}/metrics/export?format=xml`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(metricsExportResponse.status).toBe(400);
      const metricsExportPayload = await metricsExportResponse.json() as {
        error: { code: string; message: string };
      };
      expect(metricsExportPayload.error.code).toBe('INVALID_QUERY_PARAM');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('创建 session 时会持久化 actorId', async () => {
    const { server, baseUrl, sessions } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
        ],
      },
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { sessionId: string };
      const persisted = await sessions.getById(created.sessionId);
      expect(persisted?.actorId).toBe('operator-1');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('会拒绝跨 actor 访问 session，并在失败审计中带上目标 session', async () => {
    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink,
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { sessionId: string };

      const detailsResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(detailsResponse.status).toBe(403);
      const payload = await detailsResponse.json() as { error: { code: string } };
      expect(payload.error.code).toBe('FORBIDDEN');

      const rejectedAudit = [...auditSink.events].reverse().find((event) => event.action === 'request_rejected');
      expect(rejectedAudit).toMatchObject({
        actorId: 'viewer-1',
        sessionId: created.sessionId,
        result: 'failure',
        statusCode: 403,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('会拒绝跨 actor 访问其余 session 级查询与导出路由', async () => {
    const auditSink = new CollectingAuditSink();
    const persistedAuditEvents = new FakeAuditEventRepository();
    const { server, baseUrl, sessions, confirmations, toolExecutions, auditEvents } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
          { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        ],
      },
      auditSink,
      auditEvents: persistedAuditEvents,
    });

    try {
      await sessions.create({
        id: 'owned-session-1',
        projectId: 'confirmation-demo-project',
        actorId: 'operator-1',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      });
      await confirmations.createRequest({
        id: 'owned-request-1',
        sessionId: 'owned-session-1',
        projectId: 'confirmation-demo-project',
        tool: 'create_comment',
        riskLevel: 'medium',
        args: { ticketId: 'T-owned' },
        reason: 'needs approval',
        status: 'pending',
        createdAt: '2025-01-01T00:03:05.000Z',
        updatedAt: '2025-01-01T00:03:05.000Z',
      });
      confirmations.decisions.push({
        id: 'owned-decision-1',
        requestId: 'owned-request-1',
        sessionId: 'owned-session-1',
        decision: 'approved',
        actor: 'approver-1',
        reason: 'safe',
        createdAt: '2025-01-01T00:03:10.000Z',
      });
      await toolExecutions.create({
        id: 'owned-exec-1',
        sessionId: 'owned-session-1',
        tool: 'create_comment',
        args: { ticketId: 'T-owned' },
        status: 'finished',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:01.000Z',
        durationMs: 1000,
        result: { success: true },
      });
      await sessions.create({
        id: 'viewer-session-1',
        projectId: 'confirmation-demo-project',
        actorId: 'viewer-1',
        status: 'completed',
        createdAt: '2025-01-01T00:01:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
      });
      await confirmations.createRequest({
        id: 'viewer-request-1',
        sessionId: 'viewer-session-1',
        projectId: 'confirmation-demo-project',
        tool: 'viewer_tool',
        riskLevel: 'low',
        args: { ticketId: 'T-viewer' },
        reason: 'viewer owned request',
        status: 'approved',
        createdAt: '2025-01-01T00:04:05.000Z',
        updatedAt: '2025-01-01T00:04:10.000Z',
      });
      confirmations.decisions.push({
        id: 'viewer-decision-1',
        requestId: 'viewer-request-1',
        sessionId: 'viewer-session-1',
        decision: 'approved',
        actor: 'viewer-1',
        reason: 'own request approved',
        createdAt: '2025-01-01T00:04:15.000Z',
      });
      await toolExecutions.create({
        id: 'viewer-exec-1',
        sessionId: 'viewer-session-1',
        tool: 'viewer_tool',
        args: { ticketId: 'T-viewer' },
        status: 'finished',
        startedAt: '2025-01-01T00:04:20.000Z',
        finishedAt: '2025-01-01T00:04:21.000Z',
        durationMs: 1000,
        result: { success: true },
      });
      await auditEvents.create({
        timestamp: '2025-01-01T00:04:30.000Z',
        actorId: 'viewer-1',
        role: 'viewer',
        sessionId: 'viewer-session-1',
        action: 'session_details',
        result: 'success',
        statusCode: 200,
      });

      const guardedPaths = [
        `/sessions/owned-session-1/messages`,
        `/sessions/owned-session-1/pending-confirmations`,
        `/sessions/owned-session-1/grants`,
        `/sessions/owned-session-1/confirmations?limit=10&offset=0`,
        `/sessions/owned-session-1/confirmations/export?format=csv`,
        `/sessions/owned-session-1/confirmation-decisions?limit=10&offset=0`,
        `/sessions/owned-session-1/confirmation-decisions/export?format=csv`,
        `/sessions/owned-session-1/tool-executions?limit=10&offset=0`,
        `/sessions/owned-session-1/tool-executions/export?format=csv`,
        `/sessions/owned-session-1/state-summary`,
        `/sessions/owned-session-1/audit-events?limit=10&offset=0`,
        `/sessions/owned-session-1/audit-events/export?format=csv`,
      ];

      for (const guardedPath of guardedPaths) {
        const response = await fetch(`${baseUrl}${guardedPath}`, {
          headers: { authorization: 'Bearer viewer-token' },
        });
        expect(response.status).toBe(403);
        const payload = await response.json() as { error: { code: string } };
        expect(payload.error.code).toBe('FORBIDDEN');
      }

      const sessionsResponse = await fetch(`${baseUrl}/sessions?limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sessionsResponse.status).toBe(200);
      const sessionsPayload = await sessionsResponse.json() as {
        records: Array<{ id: string }>;
        total: number;
      };
      expect(sessionsPayload.records.map((entry) => entry.id)).toEqual(['viewer-session-1']);
      expect(sessionsPayload.total).toBe(1);

      const sessionsExportResponse = await fetch(`${baseUrl}/sessions/export?format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(sessionsExportResponse.status).toBe(200);
      const sessionsCsv = await sessionsExportResponse.text();
      expect(sessionsCsv).toContain('viewer-session-1');
      expect(sessionsCsv).not.toContain('owned-session-1');

      const confirmationsResponse = await fetch(`${baseUrl}/confirmations?limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(confirmationsResponse.status).toBe(200);
      const confirmationsPayload = await confirmationsResponse.json() as {
        records: Array<{ id: string; sessionId: string }>;
        total: number;
      };
      expect(confirmationsPayload.records).toEqual([
        expect.objectContaining({ id: 'viewer-request-1', sessionId: 'viewer-session-1' }),
      ]);
      expect(confirmationsPayload.total).toBe(1);

      const confirmationDecisionsResponse = await fetch(`${baseUrl}/confirmations/decisions?limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(confirmationDecisionsResponse.status).toBe(200);
      const confirmationDecisionsPayload = await confirmationDecisionsResponse.json() as {
        records: Array<{ id: string; sessionId: string }>;
        total: number;
      };
      expect(confirmationDecisionsPayload.records).toEqual([
        expect.objectContaining({ id: 'viewer-decision-1', sessionId: 'viewer-session-1' }),
      ]);
      expect(confirmationDecisionsPayload.total).toBe(1);

      const toolExecutionsResponse = await fetch(`${baseUrl}/tool-executions?limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(toolExecutionsResponse.status).toBe(200);
      const toolExecutionsPayload = await toolExecutionsResponse.json() as {
        records: Array<{ id: string; sessionId: string }>;
        total: number;
      };
      expect(toolExecutionsPayload.records).toEqual([
        expect.objectContaining({ id: 'viewer-exec-1', sessionId: 'viewer-session-1' }),
      ]);
      expect(toolExecutionsPayload.total).toBe(1);

      const auditEventsResponse = await fetch(`${baseUrl}/audit-events?limit=10&offset=0`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(auditEventsResponse.status).toBe(200);
      const auditEventsPayload = await auditEventsResponse.json() as {
        events: Array<{ sessionId?: string }>;
        total: number;
      };
      expect(auditEventsPayload.events).toEqual([
        expect.objectContaining({ sessionId: 'viewer-session-1' }),
      ]);
      expect(auditEventsPayload.total).toBe(1);

      const auditExportResponse = await fetch(`${baseUrl}/audit-events/export?format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(auditExportResponse.status).toBe(200);
      const auditCsv = await auditExportResponse.text();
      expect(auditCsv).toContain('viewer-session-1');
      expect(auditCsv).not.toContain('owned-session-1');

      const metricsResponse = await fetch(`${baseUrl}/metrics`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(metricsResponse.status).toBe(200);
      const metricsPayload = await metricsResponse.json() as {
        metrics: {
          sessionCount: number;
          toolExecutionCount: number;
          pendingConfirmationCount: number;
          auditEventCount: number;
        };
      };
      expect(metricsPayload.metrics.sessionCount).toBe(1);
      expect(metricsPayload.metrics.toolExecutionCount).toBe(1);
      expect(metricsPayload.metrics.pendingConfirmationCount).toBe(1);
      expect(metricsPayload.metrics.auditEventCount).toBeGreaterThanOrEqual(1);

      const metricsExportResponse = await fetch(`${baseUrl}/metrics/export?format=csv`, {
        headers: { authorization: 'Bearer viewer-token' },
      });
      expect(metricsExportResponse.status).toBe(200);
      const metricsCsv = await metricsExportResponse.text();
      expect(metricsCsv).toContain('"sessionCount"');
      expect(metricsCsv).toContain('"toolExecutionCount"');
      expect(metricsCsv).toContain('"auditEventCount"');

      const rejectedAudits = auditSink.events.filter(
        (event) => event.action === 'request_rejected' && event.sessionId === 'owned-session-1',
      );
      expect(rejectedAudits.length).toBeGreaterThanOrEqual(guardedPaths.length);
      expect(rejectedAudits.at(-1)).toMatchObject({
        actorId: 'viewer-1',
        sessionId: 'owned-session-1',
        result: 'failure',
        statusCode: 403,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('confirmation 跨 actor 操作失败时审计会带 requestTargetId 与 sessionId', async () => {
    const auditSink = new CollectingAuditSink();
    const { server, baseUrl } = await startTestServer({
      auth: {
        enabled: true,
        tokens: [
          { token: 'operator-token', actorId: 'operator-1', role: 'operator' },
          { token: 'approver-token', actorId: 'approver-2', role: 'approver' },
        ],
      },
      auditSink,
    });

    try {
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token' },
      });
      const created = await createResponse.json() as { sessionId: string };

      const runResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer operator-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: '请创建评论' }),
      });
      expect(runResponse.status).toBe(200);
      const runResult = await runResponse.json() as {
        result: { pendingConfirmation?: { id: string } };
      };
      const requestId = runResult.result.pendingConfirmation!.id;

      const approveResponse = await fetch(`${baseUrl}/confirmations/${requestId}/approve`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer approver-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'cross actor should fail' }),
      });
      expect(approveResponse.status).toBe(403);

      const rejectedAudit = [...auditSink.events].reverse().find(
        (event) => event.action === 'request_rejected' && event.requestTargetId === requestId,
      );
      expect(rejectedAudit).toMatchObject({
        actorId: 'approver-2',
        sessionId: created.sessionId,
        requestTargetId: requestId,
        result: 'failure',
        statusCode: 403,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
