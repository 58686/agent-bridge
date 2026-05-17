import { describe, expect, it } from 'vitest';
import { PersistenceQueryService } from '../src/persistence/query.js';
import { ApiAuditEvent, filterAuditEvents } from '../src/api-security.js';
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

class FakeSessionRepository implements SessionRepository {
  constructor(
    private readonly sessions: SessionRecord[] = [],
    private readonly snapshots: SessionSnapshotRecord[] = [],
  ) {}

  async create(session: SessionRecord): Promise<void> {
    this.sessions.push(session);
  }

  async getById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }

  async list(projectId?: string): Promise<SessionRecord[]> {
    return this.sessions
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
    const filtered = this.sessions
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
    const session = this.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    session.status = status;
    session.updatedAt = patch?.updatedAt ?? session.updatedAt;
    session.lastInput = patch?.lastInput ?? session.lastInput;
    session.lastError = patch?.lastError ?? session.lastError;
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
  constructor(
    private readonly requests: ConfirmationRequestRecord[] = [],
    private readonly decisions: ConfirmationDecisionRecord[] = [],
  ) {}

  async createRequest(request: ConfirmationRequestRecord): Promise<void> {
    this.requests.push(request);
  }

  async getById(requestId: string): Promise<ConfirmationRequestRecord | null> {
    return this.requests.find((request) => request.id === requestId) ?? null;
  }

  async listPending(sessionId?: string): Promise<ConfirmationRequestRecord[]> {
    return this.requests.filter((request) => request.status === 'pending' && (!sessionId || request.sessionId === sessionId));
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
    const filtered = this.requests
      .filter((record) => {
        if (query.sessionId && record.sessionId !== query.sessionId) {
          return false;
        }
        if (query.projectId && record.projectId !== query.projectId) {
          return false;
        }
        if (query.tool && record.tool !== query.tool) {
          return false;
        }
        if (query.riskLevel && record.riskLevel !== query.riskLevel) {
          return false;
        }
        if (query.status && record.status !== query.status) {
          return false;
        }
        const createdAt = Date.parse(record.createdAt);
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
      .filter((record) => {
        if (query.sessionId && record.sessionId !== query.sessionId) {
          return false;
        }
        if (query.requestId && record.requestId !== query.requestId) {
          return false;
        }
        if (query.decision && record.decision !== query.decision) {
          return false;
        }
        if (query.actor && record.actor !== query.actor) {
          return false;
        }
        const createdAt = Date.parse(record.createdAt);
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

  async findPendingMatch(): Promise<ConfirmationRequestRecord | null> {
    return null;
  }

  async markApproved(): Promise<void> {}
  async markRejected(): Promise<void> {}
  async markConsumed(): Promise<void> {}
  async markExpired(): Promise<void> {}
  async expirePending(): Promise<number> { return 0; }
  async appendDecision(decision: ConfirmationDecisionRecord): Promise<void> {
    this.decisions.push(decision);
  }
}

class FakeApprovalGrantRepository implements ApprovalGrantRepository {
  constructor(private readonly grants: ApprovalGrantRecord[] = []) {}

  async createGrant(grant: ApprovalGrantRecord): Promise<void> {
    this.grants.push(grant);
  }

  async findMatchingGrant(): Promise<ApprovalGrantRecord | null> {
    return null;
  }

  async consumeGrant(): Promise<void> {}

  async listActive(sessionId?: string): Promise<ApprovalGrantRecord[]> {
    return this.grants.filter((grant) => !grant.consumedAt && (!sessionId || grant.sessionId === sessionId));
  }
}

class FakeToolExecutionRepository implements ToolExecutionRepository {
  constructor(private readonly records: ToolExecutionRecord[] = []) {}

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
  constructor(private readonly events: ApiAuditEvent[] = []) {}

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
    const filtered = filterAuditEvents(this.events, query);
    const result = filtered.slice(offset, offset + limit);
    return {
      events: result,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + result.length < filtered.length,
    };
  }

  async listAll(): Promise<ApiAuditEvent[]> {
    return [...this.events];
  }
}

describe('persistence query service', () => {
  it('可以列出 session 并按项目过滤', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:01:00.000Z',
      },
      {
        id: 'session-2',
        projectId: 'project-b',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations: new FakeConfirmationRepository(),
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions: new FakeToolExecutionRepository(),
    });

    const projectSessions = await service.listSessions('project-a');
    expect(projectSessions).toHaveLength(1);
    expect(projectSessions[0].id).toBe('session-1');

    const allSessions = await service.listSessions();
    expect(allSessions).toHaveLength(2);
    expect(allSessions[0].id).toBe('session-2');
  });

  it('可以返回 session state summary', async () => {
    const sessions = new FakeSessionRepository(
      [
        {
          id: 'session-1',
          projectId: 'project-a',
          status: 'waiting_confirmation',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:03:00.000Z',
          lastInput: '请创建评论',
          lastError: 'temporary error',
        },
      ],
      [
        {
          sessionId: 'session-1',
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: '请创建评论' },
            { role: 'assistant', content: '需要确认' },
          ],
          updatedAt: '2025-01-01T00:03:00.000Z',
        },
      ],
    );

    const confirmations = new FakeConfirmationRepository([
      {
        id: 'req-1',
        sessionId: 'session-1',
        projectId: 'project-a',
        tool: 'create_comment',
        riskLevel: 'high',
        args: { ticketId: 'T-1' },
        reason: 'requires confirmation',
        callId: 'call-1',
        status: 'pending',
        createdAt: '2025-01-01T00:03:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
    ]);

    const approvalGrants = new FakeApprovalGrantRepository([
      {
        requestId: 'grant-1',
        sessionId: 'session-1',
        tool: 'create_comment',
        callId: 'call-1',
        args: { ticketId: 'T-1' },
        approvedAt: '2025-01-01T00:02:00.000Z',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants,
      toolExecutions: new FakeToolExecutionRepository(),
    });

    const summary = await service.getSessionStateSummary('session-1');
    expect(summary).not.toBeNull();
    expect(summary?.sessionId).toBe('session-1');
    expect(summary?.projectId).toBe('project-a');
    expect(summary?.status).toBe('waiting_confirmation');
    expect(summary?.lastInput).toBe('请创建评论');
    expect(summary?.lastError).toBe('temporary error');
    expect(summary?.messageCount).toBe(3);
    expect(summary?.pendingConfirmationCount).toBe(1);
    expect(summary?.activeGrantCount).toBe(1);

    expect(await service.getSessionStateSummary('missing-session')).toBeNull();
  });

  it('可以返回 session tool executions', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      },
    ]);

    const toolExecutions = new FakeToolExecutionRepository([
      {
        id: 'exec-1',
        sessionId: 'session-1',
        tool: 'create_comment',
        callId: 'call-1',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:01:00.000Z',
        finishedAt: '2025-01-01T00:01:02.000Z',
        durationMs: 2000,
        result: { success: true },
      },
      {
        id: 'exec-2',
        sessionId: 'session-1',
        tool: 'sync_ticket',
        args: { ticketId: 'T-1' },
        status: 'failed',
        startedAt: '2025-01-01T00:01:03.000Z',
        finishedAt: '2025-01-01T00:01:04.000Z',
        durationMs: 1000,
        error: 'network failed',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations: new FakeConfirmationRepository(),
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions,
    });

    const executions = await service.getToolExecutions('session-1');
    expect(executions).toHaveLength(2);
    expect(executions?.[0].tool).toBe('create_comment');
    expect(executions?.[1].status).toBe('failed');

    const filtered = await service.querySessionToolExecutions('session-1', {
      status: 'failed',
      limit: 10,
      offset: 0,
    });
    expect(filtered?.total).toBe(1);
    expect(filtered?.records[0].id).toBe('exec-2');

    expect(await service.getToolExecutions('missing-session')).toBeNull();
    expect(await service.querySessionToolExecutions('missing-session', { limit: 10, offset: 0 })).toBeNull();
  });

  it('可以按过滤条件查询 sessions', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      },
      {
        id: 'session-2',
        projectId: 'project-a',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
      {
        id: 'session-3',
        projectId: 'project-b',
        status: 'failed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations: new FakeConfirmationRepository(),
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions: new FakeToolExecutionRepository(),
    });

    const byProject = await service.querySessions({ projectId: 'project-a', limit: 10, offset: 0 });
    expect(byProject.total).toBe(2);
    expect(byProject.records.map((entry) => entry.id)).toEqual(['session-2', 'session-1']);
    expect(byProject.records[0]).toMatchObject({
      messageCount: 0,
      pendingConfirmationCount: 0,
      activeGrantCount: 0,
    });

    const byStatus = await service.querySessions({ status: 'failed', limit: 10, offset: 0 });
    expect(byStatus.total).toBe(1);
    expect(byStatus.records[0].id).toBe('session-3');

    const byWindow = await service.querySessions({
      from: '2025-01-01T00:02:30.000Z',
      to: '2025-01-01T00:04:00.000Z',
      limit: 10,
      offset: 0,
    });
    expect(byWindow.total).toBe(2);
    expect(byWindow.records.map((entry) => entry.id)).toEqual(['session-3', 'session-2']);

    const paged = await service.querySessions({ limit: 1, offset: 1 });
    expect(paged.total).toBe(3);
    expect(paged.records).toHaveLength(1);
    expect(paged.records[0].id).toBe('session-2');
    expect(paged.hasMore).toBe(true);
  });

  it('sessions 查询结果会附带 summary 字段', async () => {
    const sessions = new FakeSessionRepository(
      [
        {
          id: 'session-1',
          projectId: 'project-a',
          status: 'waiting_confirmation',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:03:00.000Z',
          lastInput: '请创建评论',
        },
      ],
      [
        {
          sessionId: 'session-1',
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: '请创建评论' },
          ],
          updatedAt: '2025-01-01T00:03:00.000Z',
        },
      ],
    );

    const confirmations = new FakeConfirmationRepository([
      {
        id: 'req-1',
        sessionId: 'session-1',
        projectId: 'project-a',
        tool: 'create_comment',
        riskLevel: 'high',
        args: { ticketId: 'T-1' },
        reason: 'requires confirmation',
        status: 'pending',
        createdAt: '2025-01-01T00:03:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
    ]);

    const approvalGrants = new FakeApprovalGrantRepository([
      {
        requestId: 'grant-1',
        sessionId: 'session-1',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        approvedAt: '2025-01-01T00:02:00.000Z',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants,
      toolExecutions: new FakeToolExecutionRepository(),
    });

    const payload = await service.querySessions({ limit: 10, offset: 0 });
    expect(payload.records[0]).toMatchObject({
      id: 'session-1',
      messageCount: 2,
      pendingConfirmationCount: 1,
      activeGrantCount: 1,
      toolExecutionCount: 0,
      failedToolExecutionCount: 0,
      lastToolExecutionStatus: undefined,
      lastToolName: undefined,
      lastToolStartedAt: undefined,
    });
  });

  it('sessions 查询支持待确认与活跃 grant 布尔过滤', async () => {
    const sessions = new FakeSessionRepository(
      [
        {
          id: 'session-1',
          projectId: 'project-a',
          status: 'waiting_confirmation',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:03:00.000Z',
        },
        {
          id: 'session-2',
          projectId: 'project-a',
          status: 'completed',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:02:00.000Z',
        },
        {
          id: 'session-3',
          projectId: 'project-b',
          status: 'completed',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:01:00.000Z',
        },
      ],
      [
        {
          sessionId: 'session-1',
          messages: [{ role: 'system', content: 'a' }],
          updatedAt: '2025-01-01T00:03:00.000Z',
        },
      ],
    );

    const confirmations = new FakeConfirmationRepository([
      {
        id: 'req-1',
        sessionId: 'session-1',
        projectId: 'project-a',
        tool: 'create_comment',
        riskLevel: 'high',
        args: { ticketId: 'T-1' },
        reason: 'requires confirmation',
        status: 'pending',
        createdAt: '2025-01-01T00:03:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
    ]);

    const approvalGrants = new FakeApprovalGrantRepository([
      {
        requestId: 'grant-1',
        sessionId: 'session-2',
        tool: 'create_comment',
        args: { ticketId: 'T-2' },
        approvedAt: '2025-01-01T00:02:00.000Z',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants,
      toolExecutions: new FakeToolExecutionRepository(),
    });

    const pendingOnly = await service.querySessions({ hasPendingConfirmation: true, limit: 10, offset: 0 });
    expect(pendingOnly.total).toBe(1);
    expect(pendingOnly.records[0].id).toBe('session-1');

    const withoutPending = await service.querySessions({ hasPendingConfirmation: false, limit: 10, offset: 0 });
    expect(withoutPending.records.map((entry) => entry.id)).toEqual(['session-2', 'session-3']);

    const activeGrantOnly = await service.querySessions({ hasActiveGrant: true, limit: 10, offset: 0 });
    expect(activeGrantOnly.total).toBe(1);
    expect(activeGrantOnly.records[0].id).toBe('session-2');

    const combined = await service.querySessions({
      projectId: 'project-a',
      hasPendingConfirmation: false,
      hasActiveGrant: true,
      limit: 10,
      offset: 0,
    });
    expect(combined.total).toBe(1);
    expect(combined.records[0].id).toBe('session-2');
  });

  it('sessions 查询支持高级摘要过滤', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
      {
        id: 'session-2',
        projectId: 'project-a',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
      },
      {
        id: 'session-3',
        projectId: 'project-b',
        status: 'failed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:05:00.000Z',
      },
      {
        id: 'session-4',
        projectId: 'project-c',
        status: 'idle',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      },
    ]);

    const confirmations = new FakeConfirmationRepository(
      [
        {
          id: 'req-1',
          sessionId: 'session-1',
          projectId: 'project-a',
          tool: 'sync_comments',
          riskLevel: 'low',
          args: { ticketId: 'T-1' },
          reason: 'sync',
          status: 'approved',
          createdAt: '2025-01-01T00:03:10.000Z',
          updatedAt: '2025-01-01T00:03:15.000Z',
        },
        {
          id: 'req-2',
          sessionId: 'session-2',
          projectId: 'project-a',
          tool: 'create_comment',
          riskLevel: 'high',
          args: { ticketId: 'T-2' },
          reason: 'needs approval',
          status: 'pending',
          createdAt: '2025-01-01T00:04:10.000Z',
          updatedAt: '2025-01-01T00:04:10.000Z',
        },
        {
          id: 'req-3',
          sessionId: 'session-3',
          projectId: 'project-b',
          tool: 'delete_comment',
          riskLevel: 'medium',
          args: { ticketId: 'T-3' },
          reason: 'cleanup',
          status: 'rejected',
          createdAt: '2025-01-01T00:05:10.000Z',
          updatedAt: '2025-01-01T00:05:20.000Z',
        },
      ],
      [
        {
          id: 'decision-1',
          requestId: 'req-1',
          sessionId: 'session-1',
          decision: 'approved',
          actor: 'reviewer-1',
          createdAt: '2025-01-01T00:03:15.000Z',
        },
        {
          id: 'decision-2',
          requestId: 'req-3',
          sessionId: 'session-3',
          decision: 'rejected',
          actor: 'reviewer-2',
          createdAt: '2025-01-01T00:05:20.000Z',
        },
      ],
    );

    const toolExecutions = new FakeToolExecutionRepository([
      {
        id: 'exec-1',
        sessionId: 'session-1',
        tool: 'sync_comments',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:03:20.000Z',
      },
      {
        id: 'exec-2',
        sessionId: 'session-2',
        tool: 'create_comment',
        args: { ticketId: 'T-2' },
        status: 'waiting_confirmation',
        startedAt: '2025-01-01T00:04:20.000Z',
      },
      {
        id: 'exec-3',
        sessionId: 'session-3',
        tool: 'delete_comment',
        args: { ticketId: 'T-3' },
        status: 'failed',
        startedAt: '2025-01-01T00:05:30.000Z',
        error: 'forbidden',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions,
    });

    const waitingConfirmation = await service.querySessions({ lastToolExecutionStatus: 'waiting_confirmation', limit: 10, offset: 0 });
    expect(waitingConfirmation.records.map((entry) => entry.id)).toEqual(['session-2']);

    const highRisk = await service.querySessions({ lastConfirmationRiskLevel: 'high', limit: 10, offset: 0 });
    expect(highRisk.records.map((entry) => entry.id)).toEqual(['session-2']);

    const rejectedDecision = await service.querySessions({ lastDecision: 'rejected', limit: 10, offset: 0 });
    expect(rejectedDecision.records.map((entry) => entry.id)).toEqual(['session-3']);

    const failedOnly = await service.querySessions({ hasFailedToolExecution: true, limit: 10, offset: 0 });
    expect(failedOnly.records.map((entry) => entry.id)).toEqual(['session-3']);

    const needsAttention = await service.querySessions({ needsAttention: true, limit: 10, offset: 0 });
    expect(needsAttention.records.map((entry) => entry.id)).toEqual(['session-3', 'session-2']);

    const approvalBlocked = await service.querySessions({ approvalState: 'blocked', limit: 10, offset: 0 });
    expect(approvalBlocked.records.map((entry) => entry.id)).toEqual(['session-2']);

    const approvalApproved = await service.querySessions({ approvalState: 'approved', limit: 10, offset: 0 });
    expect(approvalApproved.records.map((entry) => entry.id)).toEqual(['session-1']);

    const executionFailed = await service.querySessions({ executionState: 'failed', limit: 10, offset: 0 });
    expect(executionFailed.records.map((entry) => entry.id)).toEqual(['session-3']);

    const executionWaiting = await service.querySessions({ executionState: 'waiting', limit: 10, offset: 0 });
    expect(executionWaiting.records.map((entry) => entry.id)).toEqual(['session-2']);

    const queueAttention = await service.querySessions({ queue: 'attention', limit: 10, offset: 0 });
    expect(queueAttention.records.map((entry) => entry.id)).toEqual(['session-3', 'session-2']);

    const queueBlocked = await service.querySessions({ queue: 'blocked', limit: 10, offset: 0 });
    expect(queueBlocked.records.map((entry) => entry.id)).toEqual(['session-2']);

    const queueFailed = await service.querySessions({ queue: 'failed', limit: 10, offset: 0 });
    expect(queueFailed.records.map((entry) => entry.id)).toEqual(['session-3']);

    const queueIdle = await service.querySessions({ queue: 'idle', limit: 10, offset: 0 });
    expect(queueIdle.records.map((entry) => entry.id)).toEqual(['session-4']);
    expect(queueIdle.records[0]).toMatchObject({
      derivedState: {
        needsAttention: false,
        approvalState: 'clear',
        executionState: 'idle',
      },
      queueMatches: ['idle'],
    });

    expect(queueFailed.records[0]).toMatchObject({
      derivedState: {
        needsAttention: true,
        approvalState: 'rejected',
        executionState: 'failed',
      },
      queueMatches: ['attention', 'failed'],
    });

    const derivedBlocked = await service.querySessions({ projectId: 'project-a', executionState: 'waiting', limit: 10, offset: 0 });
    expect(derivedBlocked.records[0]).toMatchObject({
      derivedState: {
        needsAttention: true,
        approvalState: 'blocked',
        executionState: 'waiting',
      },
      queueMatches: ['attention', 'blocked'],
    });

    const combinedQueueFilter = await service.querySessions({
      queue: 'attention',
      approvalState: 'blocked',
      projectId: 'project-a',
      limit: 10,
      offset: 0,
    });
    expect(combinedQueueFilter.records.map((entry) => entry.id)).toEqual(['session-2']);

    const combinedWithOldFilters = await service.querySessions({
      projectId: 'project-a',
      needsAttention: true,
      approvalState: 'blocked',
      executionState: 'waiting',
      lastConfirmationRiskLevel: 'high',
      limit: 10,
      offset: 0,
    });
    expect(combinedWithOldFilters.records.map((entry) => entry.id)).toEqual(['session-2']);
  });

  it('sessions 查询会附带 tool execution summary 字段', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
    ]);

    const toolExecutions = new FakeToolExecutionRepository([
      {
        id: 'exec-1',
        sessionId: 'session-1',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:01:00.000Z',
        finishedAt: '2025-01-01T00:01:02.000Z',
        durationMs: 2000,
      },
      {
        id: 'exec-2',
        sessionId: 'session-1',
        tool: 'delete_comment',
        args: { ticketId: 'T-2' },
        status: 'failed',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:01.000Z',
        durationMs: 1000,
        error: 'forbidden',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations: new FakeConfirmationRepository(),
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions,
    });

    const payload = await service.querySessions({ limit: 10, offset: 0 });
    expect(payload.records[0]).toMatchObject({
      id: 'session-1',
      toolExecutionCount: 2,
      failedToolExecutionCount: 1,
      lastToolExecutionStatus: 'failed',
      lastToolName: 'delete_comment',
      lastToolStartedAt: '2025-01-01T00:02:00.000Z',
    });
  });

  it('sessions 查询会附带 confirmation summary 字段', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
    ]);

    const confirmations = new FakeConfirmationRepository(
      [
        {
          id: 'req-1',
          sessionId: 'session-1',
          projectId: 'project-a',
          tool: 'create_comment',
          riskLevel: 'medium',
          args: { ticketId: 'T-1' },
          reason: 'needs approval',
          status: 'approved',
          createdAt: '2025-01-01T00:01:00.000Z',
          updatedAt: '2025-01-01T00:01:30.000Z',
        },
        {
          id: 'req-2',
          sessionId: 'session-1',
          projectId: 'project-a',
          tool: 'delete_comment',
          riskLevel: 'high',
          args: { ticketId: 'T-2' },
          reason: 'dangerous',
          status: 'pending',
          createdAt: '2025-01-01T00:02:00.000Z',
          updatedAt: '2025-01-01T00:02:00.000Z',
        },
      ],
      [
        {
          id: 'decision-1',
          requestId: 'req-1',
          sessionId: 'session-1',
          decision: 'approved',
          actor: 'reviewer-1',
          createdAt: '2025-01-01T00:01:30.000Z',
        },
      ],
    );

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions: new FakeToolExecutionRepository(),
    });

    const payload = await service.querySessions({ limit: 10, offset: 0 });
    expect(payload.records[0]).toMatchObject({
      id: 'session-1',
      lastConfirmationTool: 'delete_comment',
      lastConfirmationRiskLevel: 'high',
      lastConfirmationCreatedAt: '2025-01-01T00:02:00.000Z',
      lastDecision: 'approved',
      lastDecisionAt: '2025-01-01T00:01:30.000Z',
    });
  });

  it('sessions 查询支持排序参数', async () => {
    const sessions = new FakeSessionRepository(
      [
        {
          id: 'session-1',
          projectId: 'project-a',
          status: 'completed',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:03:00.000Z',
        },
        {
          id: 'session-2',
          projectId: 'project-a',
          status: 'waiting_confirmation',
          createdAt: '2025-01-01T00:01:00.000Z',
          updatedAt: '2025-01-01T00:02:00.000Z',
        },
        {
          id: 'session-3',
          projectId: 'project-a',
          status: 'completed',
          createdAt: '2025-01-01T00:02:00.000Z',
          updatedAt: '2025-01-01T00:01:00.000Z',
        },
      ],
      [
        {
          sessionId: 'session-1',
          messages: [{ role: 'system', content: 'a' }],
          updatedAt: '2025-01-01T00:03:00.000Z',
        },
        {
          sessionId: 'session-2',
          messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }],
          updatedAt: '2025-01-01T00:02:00.000Z',
        },
      ],
    );

    const confirmations = new FakeConfirmationRepository(
      [
        {
          id: 'req-1',
          sessionId: 'session-2',
          projectId: 'project-a',
          tool: 'create_comment',
          riskLevel: 'high',
          args: { ticketId: 'T-1' },
          reason: 'requires confirmation',
          status: 'pending',
          createdAt: '2025-01-01T00:02:00.000Z',
          updatedAt: '2025-01-01T00:02:00.000Z',
        },
        {
          id: 'req-2',
          sessionId: 'session-1',
          projectId: 'project-a',
          tool: 'sync_comments',
          riskLevel: 'low',
          args: { ticketId: 'T-1' },
          reason: 'sync history',
          status: 'approved',
          createdAt: '2025-01-01T00:03:20.000Z',
          updatedAt: '2025-01-01T00:03:25.000Z',
        },
        {
          id: 'req-3',
          sessionId: 'session-3',
          projectId: 'project-a',
          tool: 'delete_comment',
          riskLevel: 'medium',
          args: { ticketId: 'T-3' },
          reason: 'cleanup',
          status: 'rejected',
          createdAt: '2025-01-01T00:01:20.000Z',
          updatedAt: '2025-01-01T00:01:25.000Z',
        },
      ],
      [
        {
          id: 'decision-1',
          requestId: 'req-2',
          sessionId: 'session-1',
          decision: 'approved',
          actor: 'reviewer-1',
          createdAt: '2025-01-01T00:03:25.000Z',
        },
        {
          id: 'decision-2',
          requestId: 'req-3',
          sessionId: 'session-3',
          decision: 'rejected',
          actor: 'reviewer-2',
          createdAt: '2025-01-01T00:01:25.000Z',
        },
      ],
    );

    const approvalGrants = new FakeApprovalGrantRepository([
      {
        requestId: 'grant-1',
        sessionId: 'session-3',
        tool: 'create_comment',
        args: { ticketId: 'T-3' },
        approvedAt: '2025-01-01T00:01:30.000Z',
      },
    ]);

    const toolExecutions = new FakeToolExecutionRepository([
      {
        id: 'exec-1',
        sessionId: 'session-1',
        tool: 'sync_comments',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:03:30.000Z',
      },
      {
        id: 'exec-2',
        sessionId: 'session-2',
        tool: 'create_comment',
        args: { ticketId: 'T-2' },
        status: 'waiting_confirmation',
        startedAt: '2025-01-01T00:02:30.000Z',
      },
      {
        id: 'exec-3',
        sessionId: 'session-3',
        tool: 'delete_comment',
        args: { ticketId: 'T-3' },
        status: 'failed',
        startedAt: '2025-01-01T00:01:30.000Z',
        error: 'forbidden',
      },
      {
        id: 'exec-4',
        sessionId: 'session-3',
        tool: 'delete_comment',
        args: { ticketId: 'T-3' },
        status: 'failed',
        startedAt: '2025-01-01T00:01:40.000Z',
        error: 'forbidden-again',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants,
      toolExecutions,
    });

    const defaultSorted = await service.querySessions({ limit: 10, offset: 0 });
    expect(defaultSorted.records.map((entry) => entry.id)).toEqual(['session-1', 'session-2', 'session-3']);

    const createdAsc = await service.querySessions({ sortBy: 'createdAt', sortOrder: 'asc', limit: 10, offset: 0 });
    expect(createdAsc.records.map((entry) => entry.id)).toEqual(['session-1', 'session-2', 'session-3']);

    const messageDesc = await service.querySessions({ sortBy: 'messageCount', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(messageDesc.records.map((entry) => entry.id)).toEqual(['session-2', 'session-1', 'session-3']);

    const pendingDesc = await service.querySessions({ sortBy: 'pendingConfirmationCount', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(pendingDesc.records.map((entry) => entry.id)).toEqual(['session-2', 'session-1', 'session-3']);

    const grantDesc = await service.querySessions({ sortBy: 'activeGrantCount', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(grantDesc.records.map((entry) => entry.id)).toEqual(['session-3', 'session-1', 'session-2']);

    const toolExecutionDesc = await service.querySessions({ sortBy: 'toolExecutionCount', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(toolExecutionDesc.records.map((entry) => entry.id)).toEqual(['session-3', 'session-1', 'session-2']);

    const failedToolExecutionDesc = await service.querySessions({ sortBy: 'failedToolExecutionCount', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(failedToolExecutionDesc.records.map((entry) => entry.id)).toEqual(['session-3', 'session-1', 'session-2']);

    const lastToolStartedAtDesc = await service.querySessions({ sortBy: 'lastToolStartedAt', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(lastToolStartedAtDesc.records.map((entry) => entry.id)).toEqual(['session-1', 'session-2', 'session-3']);

    const lastConfirmationCreatedAtDesc = await service.querySessions({ sortBy: 'lastConfirmationCreatedAt', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(lastConfirmationCreatedAtDesc.records.map((entry) => entry.id)).toEqual(['session-1', 'session-2', 'session-3']);

    const lastDecisionAtDesc = await service.querySessions({ sortBy: 'lastDecisionAt', sortOrder: 'desc', limit: 10, offset: 0 });
    expect(lastDecisionAtDesc.records.map((entry) => entry.id)).toEqual(['session-1', 'session-3', 'session-2']);
  });

  it('可以按过滤条件查询全局 tool executions', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      },
      {
        id: 'session-2',
        projectId: 'project-b',
        status: 'failed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
    ]);

    const toolExecutions = new FakeToolExecutionRepository([
      {
        id: 'exec-1',
        sessionId: 'session-1',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:01:00.000Z',
        finishedAt: '2025-01-01T00:01:02.000Z',
        durationMs: 2000,
      },
      {
        id: 'exec-2',
        sessionId: 'session-2',
        tool: 'delete_comment',
        args: { ticketId: 'T-2' },
        status: 'failed',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:01.000Z',
        durationMs: 1000,
        error: 'forbidden',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations: new FakeConfirmationRepository(),
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions,
    });

    const filteredByProject = await service.queryToolExecutions({ projectId: 'project-a', limit: 10, offset: 0 });
    expect(filteredByProject.total).toBe(1);
    expect(filteredByProject.records[0].id).toBe('exec-1');

    const filteredByStatus = await service.queryToolExecutions({ status: 'failed', limit: 10, offset: 0 });
    expect(filteredByStatus.total).toBe(1);
    expect(filteredByStatus.records[0].tool).toBe('delete_comment');

    const filteredByWindow = await service.queryToolExecutions({ from: '2025-01-01T00:01:30.000Z', to: '2025-01-01T00:02:30.000Z', limit: 10, offset: 0 });
    expect(filteredByWindow.total).toBe(1);
    expect(filteredByWindow.records[0].id).toBe('exec-2');
  });

  it('可以按过滤条件查询 confirmation requests 与 decisions', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
      {
        id: 'session-2',
        projectId: 'project-b',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
      },
    ]);

    const confirmations = new FakeConfirmationRepository(
      [
        {
          id: 'req-1',
          sessionId: 'session-1',
          projectId: 'project-a',
          tool: 'create_comment',
          riskLevel: 'high',
          args: { ticketId: 'T-1' },
          reason: 'requires confirmation',
          status: 'pending',
          createdAt: '2025-01-01T00:02:00.000Z',
          updatedAt: '2025-01-01T00:02:00.000Z',
        },
        {
          id: 'req-2',
          sessionId: 'session-1',
          projectId: 'project-a',
          tool: 'delete_comment',
          riskLevel: 'medium',
          args: { ticketId: 'T-2' },
          reason: 'cleanup',
          status: 'approved',
          createdAt: '2025-01-01T00:03:00.000Z',
          updatedAt: '2025-01-01T00:03:30.000Z',
        },
        {
          id: 'req-3',
          sessionId: 'session-2',
          projectId: 'project-b',
          tool: 'sync_ticket',
          riskLevel: 'low',
          args: { ticketId: 'T-3' },
          reason: 'sync',
          status: 'rejected',
          createdAt: '2025-01-01T00:04:00.000Z',
          updatedAt: '2025-01-01T00:04:10.000Z',
        },
      ],
      [
        {
          id: 'decision-1',
          requestId: 'req-2',
          sessionId: 'session-1',
          decision: 'approved',
          actor: 'approver-1',
          reason: 'looks safe',
          createdAt: '2025-01-01T00:03:10.000Z',
        },
        {
          id: 'decision-2',
          requestId: 'req-3',
          sessionId: 'session-2',
          decision: 'rejected',
          actor: 'approver-2',
          reason: 'too risky',
          createdAt: '2025-01-01T00:04:05.000Z',
        },
      ],
    );

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants: new FakeApprovalGrantRepository(),
      toolExecutions: new FakeToolExecutionRepository(),
    });

    const requestQuery = await service.queryConfirmationRequests({
      projectId: 'project-a',
      status: 'approved',
      limit: 10,
      offset: 0,
    });
    expect(requestQuery.total).toBe(1);
    expect(requestQuery.records[0].id).toBe('req-2');

    const sessionRequestQuery = await service.querySessionConfirmationRequests('session-1', {
      tool: 'create_comment',
      limit: 10,
      offset: 0,
    });
    expect(sessionRequestQuery?.total).toBe(1);
    expect(sessionRequestQuery?.records[0].id).toBe('req-1');
    expect(await service.querySessionConfirmationRequests('missing-session', { limit: 10, offset: 0 })).toBeNull();

    const decisionQuery = await service.queryConfirmationDecisions({
      decision: 'rejected',
      limit: 10,
      offset: 0,
    });
    expect(decisionQuery.total).toBe(1);
    expect(decisionQuery.records[0].id).toBe('decision-2');

    const sessionDecisionQuery = await service.querySessionConfirmationDecisions('session-1', {
      actor: 'approver-1',
      limit: 10,
      offset: 0,
    });
    expect(sessionDecisionQuery?.total).toBe(1);
    expect(sessionDecisionQuery?.records[0].requestId).toBe('req-2');
    expect(await service.querySessionConfirmationDecisions('missing-session', { limit: 10, offset: 0 })).toBeNull();
  });

  it('可以返回系统级 metrics 摘要', async () => {
    const sessions = new FakeSessionRepository([
      {
        id: 'session-1',
        projectId: 'project-a',
        status: 'waiting_confirmation',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      },
      {
        id: 'session-2',
        projectId: 'project-a',
        status: 'completed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:03:00.000Z',
      },
      {
        id: 'session-3',
        projectId: 'project-b',
        status: 'failed',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
      },
    ]);

    const confirmations = new FakeConfirmationRepository([
      {
        id: 'req-1',
        sessionId: 'session-1',
        projectId: 'project-a',
        tool: 'create_comment',
        riskLevel: 'high',
        args: { ticketId: 'T-1' },
        reason: 'requires confirmation',
        status: 'pending',
        createdAt: '2025-01-01T00:02:00.000Z',
        updatedAt: '2025-01-01T00:02:00.000Z',
      },
      {
        id: 'req-2',
        sessionId: 'session-3',
        projectId: 'project-b',
        tool: 'delete_comment',
        riskLevel: 'high',
        args: { ticketId: 'T-9' },
        reason: 'requires confirmation',
        status: 'pending',
        createdAt: '2025-01-01T00:04:00.000Z',
        updatedAt: '2025-01-01T00:04:00.000Z',
      },
    ]);

    const approvalGrants = new FakeApprovalGrantRepository([
      {
        requestId: 'grant-1',
        sessionId: 'session-2',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        approvedAt: '2025-01-01T00:02:30.000Z',
      },
    ]);

    const toolExecutions = new FakeToolExecutionRepository([
      {
        id: 'exec-1',
        sessionId: 'session-1',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        status: 'waiting_confirmation',
        startedAt: '2025-01-01T00:01:00.000Z',
      },
      {
        id: 'exec-2',
        sessionId: 'session-2',
        tool: 'create_comment',
        args: { ticketId: 'T-1' },
        status: 'finished',
        startedAt: '2025-01-01T00:02:00.000Z',
        finishedAt: '2025-01-01T00:02:02.000Z',
        durationMs: 2000,
        result: { success: true },
      },
      {
        id: 'exec-3',
        sessionId: 'session-3',
        tool: 'delete_comment',
        args: { ticketId: 'T-9' },
        status: 'failed',
        startedAt: '2025-01-01T00:03:00.000Z',
        finishedAt: '2025-01-01T00:03:01.000Z',
        durationMs: 1000,
        error: 'forbidden',
      },
    ]);

    const auditEvents = new FakeAuditEventRepository([
      {
        timestamp: '2025-01-01T00:02:10.000Z',
        actorId: 'viewer-1',
        sessionId: 'session-1',
        action: 'session_details',
        result: 'success',
      },
      {
        timestamp: '2025-01-01T00:03:10.000Z',
        actorId: 'operator-1',
        sessionId: 'session-3',
        action: 'session_run',
        result: 'failure',
        error: 'forbidden',
      },
      {
        timestamp: '2025-01-01T00:02:20.000Z',
        actorId: 'approver-1',
        sessionId: 'session-2',
        action: 'confirmation_approve',
        result: 'success',
      },
    ]);

    const service = new PersistenceQueryService({
      sessions,
      confirmations,
      approvalGrants,
      toolExecutions,
      auditEvents,
    });

    const allMetrics = await service.getSystemMetrics();
    expect(allMetrics.window).toEqual({ from: undefined, to: undefined, bucketMinutes: 15 });
    expect(allMetrics.sessionCount).toBe(3);
    expect(allMetrics.sessionsByStatus.waiting_confirmation).toBe(1);
    expect(allMetrics.sessionsByStatus.completed).toBe(1);
    expect(allMetrics.sessionsByStatus.failed).toBe(1);
    expect(allMetrics.pendingConfirmationCount).toBe(2);
    expect(allMetrics.activeGrantCount).toBe(1);
    expect(allMetrics.toolExecutionCount).toBe(3);
    expect(allMetrics.toolExecutionByStatus.waiting_confirmation).toBe(1);
    expect(allMetrics.toolExecutionByStatus.finished).toBe(1);
    expect(allMetrics.toolExecutionByStatus.failed).toBe(1);
    expect(allMetrics.failedToolExecutionCount).toBe(1);
    expect(allMetrics.toolFailureRate).toBeCloseTo(1 / 3);
    expect(allMetrics.averageToolDurationMs).toBe(1500);
    expect(allMetrics.auditEventCount).toBe(3);
    expect(allMetrics.auditFailureCount).toBe(1);
    expect(allMetrics.auditFailureRate).toBeCloseTo(1 / 3);
    expect(allMetrics.auditEventsByAction.session_details.total).toBe(1);
    expect(allMetrics.auditEventsByAction.session_run.failure).toBe(1);
    expect(allMetrics.topActions).toHaveLength(3);
    expect(allMetrics.topActions[0]).toMatchObject({ action: 'session_run', total: 1, failure: 1, failureRate: 1 });
    expect(allMetrics.topFailedTools).toHaveLength(1);
    expect(allMetrics.topFailedTools[0]).toMatchObject({ tool: 'delete_comment', total: 1, failed: 1, failureRate: 1 });
    expect(allMetrics.slowestTools).toHaveLength(2);
    expect(allMetrics.slowestTools[0]).toMatchObject({ tool: 'create_comment', countWithDuration: 1, averageDurationMs: 2000, maxDurationMs: 2000 });
    expect(allMetrics.slowestTools[1]).toMatchObject({ tool: 'delete_comment', countWithDuration: 1, averageDurationMs: 1000, maxDurationMs: 1000 });
    expect(allMetrics.actors).toHaveLength(3);
    expect(allMetrics.actors[0]).toMatchObject({ actorId: 'operator-1', total: 1, failure: 1, failureRate: 1 });
    expect(allMetrics.actors[0].actions.session_run).toBe(1);
    expect(allMetrics.timeline).toHaveLength(1);
    expect(allMetrics.timeline[0]).toMatchObject({
      toolExecutionCount: 3,
      failedToolExecutionCount: 1,
      auditEventCount: 3,
      auditFailureCount: 1,
    });

    const projectMetrics = await service.getSystemMetrics({ projectId: 'project-a' });
    expect(projectMetrics.sessionCount).toBe(2);
    expect(projectMetrics.pendingConfirmationCount).toBe(1);
    expect(projectMetrics.activeGrantCount).toBe(1);
    expect(projectMetrics.toolExecutionCount).toBe(2);
    expect(projectMetrics.failedToolExecutionCount).toBe(0);
    expect(projectMetrics.topFailedTools).toHaveLength(0);
    expect(projectMetrics.slowestTools).toHaveLength(1);
    expect(projectMetrics.slowestTools[0].tool).toBe('create_comment');
    expect(projectMetrics.auditEventCount).toBe(2);
    expect(projectMetrics.auditFailureCount).toBe(0);

    const windowedMetrics = await service.getSystemMetrics({
      from: '2025-01-01T00:02:00.000Z',
      to: '2025-01-01T00:02:59.000Z',
      bucketMinutes: 1,
      topActionsLimit: 1,
      actorLimit: 1,
    });
    expect(windowedMetrics.window).toEqual({
      from: '2025-01-01T00:02:00.000Z',
      to: '2025-01-01T00:02:59.000Z',
      bucketMinutes: 1,
    });
    expect(windowedMetrics.toolExecutionCount).toBe(1);
    expect(windowedMetrics.failedToolExecutionCount).toBe(0);
    expect(windowedMetrics.auditEventCount).toBe(2);
    expect(windowedMetrics.auditEventsByAction.confirmation_approve.total).toBe(1);
    expect(windowedMetrics.auditEventsByAction.session_details.total).toBe(1);
    expect(windowedMetrics.topActions).toHaveLength(1);
    expect(windowedMetrics.topFailedTools).toHaveLength(0);
    expect(windowedMetrics.slowestTools).toHaveLength(1);
    expect(windowedMetrics.slowestTools[0]).toMatchObject({ tool: 'create_comment', averageDurationMs: 2000, maxDurationMs: 2000 });
    expect(windowedMetrics.actors).toHaveLength(1);
    expect(windowedMetrics.actors[0].actorId).toBe('approver-1');
    expect(windowedMetrics.timeline).toHaveLength(1);
    expect(windowedMetrics.timeline[0].startedAt).toBe('2025-01-01T00:02:00.000Z');
    expect(windowedMetrics.timeline[0].toolExecutionCount).toBe(1);
    expect(windowedMetrics.timeline[0].auditEventCount).toBe(2);
    expect(windowedMetrics.timeline[0].auditFailureCount).toBe(0);
  });
});



