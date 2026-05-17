import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeAgent } from '../src/core/runtime-agent.js';
import { createDefaultConnectorRegistry } from '../src/connectors/default-registry.js';
import { ProjectConfig } from '../src/core/types.js';
import {
  ApprovalGrantRepository,
  ConfirmationRepository,
  SessionRepository,
  ToolExecutionRepository,
} from '../src/persistence/interfaces.js';
import {
  ApprovalGrantRecord,
  ConfirmationDecisionRecord,
  ConfirmationRequestRecord,
  SessionRecord,
  SessionSnapshotRecord,
  SessionStatus,
  ToolExecutionRecord,
} from '../src/persistence/types.js';

function createConfirmationProject(): ProjectConfig {
  return {
    id: 'confirmation-demo-project',
    name: 'Confirmation Demo Project',
    description: '用于验证高风险工具确认闭环的本地演示配置',
    model: {
      provider: 'custom',
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

  async markApproved(requestId: string, _updatedAt: string): Promise<void> {
    this.approvedRequestIds.push(requestId);
  }

  async markRejected(requestId: string, _updatedAt: string): Promise<void> {
    this.rejectedRequestIds.push(requestId);
  }

  async markConsumed(requestId: string, _updatedAt: string): Promise<void> {
    this.consumedRequestIds.push(requestId);
  }

  async markExpired(requestId: string, _updatedAt: string): Promise<void> {
    this.expiredRequestIds.push(requestId);
  }

  async expirePending(_beforeOrAt: string): Promise<number> {
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
  consumedRequestIds: string[] = [];
  expiredRequestIds: string[] = [];

  async createGrant(grant: ApprovalGrantRecord): Promise<void> {
    this.grants.push(grant);
  }

  async findMatchingGrant(
    sessionId: string,
    tool: string,
    callId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ApprovalGrantRecord | null> {
    const now = new Date().toISOString();
    return this.grants.find(
      (grant) =>
        grant.sessionId === sessionId
        && grant.tool === tool
        && grant.callId === callId
        && JSON.stringify(grant.args) === JSON.stringify(args)
        && !grant.consumedAt
        && !grant.revokedAt
        && (!grant.expiresAt || grant.expiresAt > now),
    ) ?? null;
  }

  async consumeGrant(requestId: string, consumedAt: string): Promise<void> {
    this.consumedRequestIds.push(requestId);
    const grant = this.grants.find((entry) => entry.requestId === requestId);
    if (grant) {
      grant.consumedAt = consumedAt;
    }
  }

  async expireActive(beforeOrAt: string): Promise<number> {
    let count = 0;
    for (const grant of this.grants) {
      if (!grant.consumedAt && !grant.revokedAt && grant.expiresAt && grant.expiresAt <= beforeOrAt) {
        grant.revokedAt = beforeOrAt;
        this.expiredRequestIds.push(grant.requestId);
        count += 1;
      }
    }
    return count;
  }

  async listActive(sessionId?: string): Promise<ApprovalGrantRecord[]> {
    const now = new Date().toISOString();
    return this.grants.filter((grant) =>
      (!sessionId || grant.sessionId === sessionId)
      && !grant.consumedAt
      && !grant.revokedAt
      && (!grant.expiresAt || grant.expiresAt > now),
    );
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
    const matched = this.records.find((entry) => entry.id === id);
    if (matched) {
      Object.assign(matched, patch);
    }
  }

  async markInterrupted(sessionId: string, interruptedAt: string, reason = 'process interrupted before completion'): Promise<number> {
    let count = 0;
    for (const record of this.records) {
      if (record.sessionId === sessionId && record.status === 'started') {
        record.status = 'interrupted';
        record.finishedAt = record.finishedAt ?? interruptedAt;
        record.error = record.error ?? reason;
        count += 1;
      }
    }
    return count;
  }

  async listBySession(sessionId: string): Promise<ToolExecutionRecord[]> {
    return this.records.filter((record) => record.sessionId === sessionId);
  }
}

async function createAgent(options?: {
  sessionId?: string;
  project?: ProjectConfig;
  sessions?: FakeSessionRepository;
  confirmations?: FakeConfirmationRepository;
  approvalGrants?: FakeApprovalGrantRepository;
  toolExecutions?: FakeToolExecutionRepository;
}) {
  const sessions = options?.sessions ?? new FakeSessionRepository();
  const confirmations = options?.confirmations ?? new FakeConfirmationRepository();
  const approvalGrants = options?.approvalGrants ?? new FakeApprovalGrantRepository();
  const toolExecutions = options?.toolExecutions ?? new FakeToolExecutionRepository();

  const agent = new RuntimeAgent(
    {
      project: options?.project ?? createConfirmationProject(),
      sessionId: options?.sessionId,
      debug: false,
      persistence: {
        sessions,
        confirmations,
        approvalGrants,
        toolExecutions,
      },
    },
    createDefaultConnectorRegistry(),
  );

  await agent.initialize();
  return { agent, sessions, confirmations, approvalGrants, toolExecutions };
}

describe('tool confirmation flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('批准后会继续执行当前这一次工具调用', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { agent, confirmations, approvalGrants } = await createAgent();

    try {
      const first = await agent.run('请创建评论');

      expect(first.pendingConfirmation).toBeDefined();
      expect(first.pendingConfirmation?.tool).toBe('create_comment');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(confirmations.createdRequests).toHaveLength(1);
      expect(confirmations.createdRequests[0].id).toBe(first.pendingConfirmation?.id);

      await agent.approveConfirmation(first.pendingConfirmation!.id, 'approved in test');
      await agent.clearHistory();

      const resumed = await agent.run('请创建评论');

      expect(resumed.pendingConfirmation).toBeUndefined();
      expect(resumed.toolCalls).toHaveLength(1);
      expect(resumed.toolCalls[0].tool).toBe('create_comment');
      expect(resumed.toolCalls[0].result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(confirmations.approvedRequestIds).toContain(first.pendingConfirmation!.id);
      expect(confirmations.consumedRequestIds).toContain(first.pendingConfirmation!.id);
      expect(confirmations.decisions).toHaveLength(1);
      expect(approvalGrants.grants).toHaveLength(1);
      expect(approvalGrants.consumedRequestIds).toContain(first.pendingConfirmation!.id);
    } finally {
      await agent.destroy();
    }
  });

  it('uses configured confirmation timeout when creating approval requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const project = createConfirmationProject();
    project.toolPolicy = {
      ...project.toolPolicy,
      confirmationTimeoutMs: 60_000,
    };
    const { agent, confirmations } = await createAgent({ project });

    try {
      const first = await agent.run('create comment');

      expect(first.pendingConfirmation).toBeDefined();
      expect(confirmations.createdRequests).toHaveLength(1);
      expect(confirmations.createdRequests[0].expiresAt).toBe('2026-01-01T00:01:00.000Z');
    } finally {
      vi.useRealTimers();
      await agent.destroy();
    }
  });

  it('批准时会记录 actor 到 decision 与 grant', async () => {
    const { agent, confirmations, approvalGrants } = await createAgent();

    try {
      const first = await agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();

      await agent.approveConfirmation(first.pendingConfirmation!.id, 'approved in test', 'approver-user');

      expect(confirmations.decisions).toHaveLength(1);
      expect(confirmations.decisions[0].actor).toBe('approver-user');
      expect(confirmations.decisions[0].decision).toBe('approved');
      expect(approvalGrants.grants).toHaveLength(1);
      expect(approvalGrants.grants[0].approvedBy).toBe('approver-user');
      expect(approvalGrants.grants[0].reason).toBe('approved in test');
    } finally {
      await agent.destroy();
    }
  });

  it('同一工具的下一次新请求会再次要求确认', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { agent, confirmations } = await createAgent();

    try {
      const first = await agent.run('请创建评论');

      expect(first.pendingConfirmation).toBeDefined();
      const firstCallId = first.pendingConfirmation!.callId;

      await agent.approveConfirmation(first.pendingConfirmation!.id, 'approved in test');
      await agent.clearHistory();

      const resumed = await agent.run('请创建评论');
      expect(resumed.pendingConfirmation).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = await agent.run('请创建评论');

      expect(second.pendingConfirmation).toBeDefined();
      expect(second.pendingConfirmation?.tool).toBe('create_comment');
      expect(second.pendingConfirmation?.callId).not.toBe(firstCallId);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(confirmations.createdRequests).toHaveLength(2);
      expect(confirmations.createdRequests[1].id).toBe(second.pendingConfirmation?.id);
    } finally {
      await agent.destroy();
    }
  });

  it('会持久化 session lifecycle 状态与 snapshot', async () => {
    const { agent, sessions } = await createAgent();

    try {
      expect(sessions.createdSessions).toHaveLength(1);
      expect(sessions.createdSessions[0].status).toBe('idle');
      expect(sessions.snapshots).toHaveLength(1);
      expect(sessions.snapshots[0].messages[0].role).toBe('system');

      const first = await agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();

      expect(sessions.statusUpdates.some((entry) => entry.status === 'running')).toBe(true);
      const waitingUpdate = sessions.statusUpdates.findLast((entry) => entry.status === 'waiting_confirmation');
      expect(waitingUpdate).toBeDefined();
      expect(waitingUpdate?.patch?.lastInput).toBe('请创建评论');

      const snapshot = await sessions.loadSnapshot(agent.sessionId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.messages.some((message) => message.role === 'user' && message.content === '请创建评论')).toBe(true);
      expect(snapshot!.messages.some((message) => message.role === 'assistant')).toBe(true);
    } finally {
      await agent.destroy();
    }
  });

  it('批准与清空历史后会更新 session snapshot 与状态', async () => {
    const { agent, sessions } = await createAgent();

    try {
      const first = await agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();

      await agent.approveConfirmation(first.pendingConfirmation!.id, 'approved in test');
      await agent.clearHistory();

      const idleUpdate = sessions.statusUpdates.findLast((entry) => entry.status === 'idle');
      expect(idleUpdate).toBeDefined();

      const snapshot = await sessions.loadSnapshot(agent.sessionId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.messages).toHaveLength(1);
      expect(snapshot!.messages[0].role).toBe('system');
    } finally {
      await agent.destroy();
    }
  });

  it('带相同 sessionId 重建 agent 时会在 initialize 阶段自动恢复 pending confirmation', async () => {
    const sessionId = 'auto-restored-pending-session';
    const sessions = new FakeSessionRepository();
    const confirmations = new FakeConfirmationRepository();
    const approvalGrants = new FakeApprovalGrantRepository();

    const firstAgentBundle = await createAgent({ sessionId, sessions, confirmations, approvalGrants });

    try {
      const first = await firstAgentBundle.agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();
    } finally {
      await firstAgentBundle.agent.destroy();
    }

    const restoredAgentBundle = await createAgent({ sessionId, sessions, confirmations, approvalGrants });

    try {
      expect(restoredAgentBundle.agent.getPendingConfirmations()).toHaveLength(1);
      expect(restoredAgentBundle.agent.pendingConfirmation?.tool).toBe('create_comment');
    } finally {
      await restoredAgentBundle.agent.destroy();
    }
  });

  it('新 agent 可以从持久化层恢复 pending confirmation', async () => {
    const sessionId = 'restored-pending-session';
    const confirmations = new FakeConfirmationRepository();
    const approvalGrants = new FakeApprovalGrantRepository();

    const firstAgentBundle = await createAgent({ sessionId, confirmations, approvalGrants });

    try {
      const first = await firstAgentBundle.agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();
    } finally {
      await firstAgentBundle.agent.destroy();
    }

    const restoredAgentBundle = await createAgent({ sessionId, confirmations, approvalGrants });

    try {
      const restored = await restoredAgentBundle.agent.restoreSessionState();

      expect(restored.pendingConfirmations).toHaveLength(1);
      expect(restoredAgentBundle.agent.getPendingConfirmations()).toHaveLength(1);
      expect(restored.pendingConfirmations[0].tool).toBe('create_comment');
    } finally {
      await restoredAgentBundle.agent.destroy();
    }
  });

  it('新 agent 可以在批准后通过 resume 真正恢复被中断的工具执行', async () => {
    const sessionId = 'restored-resume-session';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const sessions = new FakeSessionRepository();
    const confirmations = new FakeConfirmationRepository();
    const approvalGrants = new FakeApprovalGrantRepository();
    const firstAgentBundle = await createAgent({ sessionId, sessions, confirmations, approvalGrants });

    let pendingRequestId: string;
    try {
      const first = await firstAgentBundle.agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();
      pendingRequestId = first.pendingConfirmation!.id;

      await firstAgentBundle.agent.approveConfirmation(pendingRequestId, 'approved before resume');
    } finally {
      await firstAgentBundle.agent.destroy();
    }

    const restoredAgentBundle = await createAgent({ sessionId, sessions, confirmations, approvalGrants });

    try {
      const resumed = await restoredAgentBundle.agent.resume();

      expect(resumed.pendingConfirmation).toBeUndefined();
      expect(resumed.toolCalls).toHaveLength(1);
      expect(resumed.toolCalls[0].tool).toBe('create_comment');
      expect(resumed.toolCalls[0].result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(confirmations.consumedRequestIds).toContain(pendingRequestId);
      expect(approvalGrants.consumedRequestIds).toContain(pendingRequestId);
    } finally {
      await restoredAgentBundle.agent.destroy();
    }
  });

  it('过期的 confirmation 不可再批准', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { agent, confirmations } = await createAgent();

    try {
      const runResult = await agent.run('请创建评论');
      const pending = runResult.pendingConfirmation;
      expect(pending).toBeTruthy();
      confirmations.expiredRequestIds.push(pending!.id);

      await expect(agent.approveConfirmation(pending!.id, 'late approval')).rejects.toMatchObject({
        code: 'CONFIRMATION_EXPIRED',
      });
    } finally {
      await agent.destroy();
    }
  });

  it('销毁 waiting_confirmation 会保持会话状态，不会被错误重置为 idle', async () => {
    const sessionId = 'destroy-waiting-session';
    const sessions = new FakeSessionRepository();
    const agentBundle = await createAgent({ sessionId, sessions });

    try {
      const first = await agentBundle.agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();
    } finally {
      await agentBundle.agent.destroy();
    }

    const persisted = await sessions.getById(sessionId);
    expect(persisted?.status).toBe('waiting_confirmation');
  });

  it('clear-history 会破坏基于已持久化 tool-call frame 的恢复，resume 会退回 run(lastInput) 并复用未消费 grant', async () => {
    const sessionId = 'clear-history-breaks-resume-session';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const sessions = new FakeSessionRepository();
    const confirmations = new FakeConfirmationRepository();
    const approvalGrants = new FakeApprovalGrantRepository();
    const firstAgentBundle = await createAgent({ sessionId, sessions, confirmations, approvalGrants });

    let firstPendingRequestId: string;
    try {
      const first = await firstAgentBundle.agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();
      firstPendingRequestId = first.pendingConfirmation!.id;

      await firstAgentBundle.agent.approveConfirmation(firstPendingRequestId, 'approved before history clear');
      await firstAgentBundle.agent.clearHistory();
    } finally {
      await firstAgentBundle.agent.destroy();
    }

    const restoredAgentBundle = await createAgent({ sessionId, sessions, confirmations, approvalGrants });

    try {
      const resumed = await restoredAgentBundle.agent.resume();

      expect(resumed.pendingConfirmation).toBeUndefined();
      expect(resumed.toolCalls).toHaveLength(1);
      expect(resumed.toolCalls[0].tool).toBe('create_comment');
      expect(resumed.toolCalls[0].result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(confirmations.approvedRequestIds).toContain(firstPendingRequestId);
      expect(confirmations.consumedRequestIds).toContain(firstPendingRequestId);
      expect(approvalGrants.consumedRequestIds).toContain(firstPendingRequestId);
    } finally {
      await restoredAgentBundle.agent.destroy();
    }
  });

  it('同一个 confirmation 在已批准后不可重复批准', async () => {
    const { agent } = await createAgent();

    try {
      const first = await agent.run('请创建评论');
      expect(first.pendingConfirmation).toBeDefined();

      await agent.approveConfirmation(first.pendingConfirmation!.id, 'approved once');

      await expect(agent.approveConfirmation(first.pendingConfirmation!.id, 'approved twice')).rejects.toMatchObject({
        code: 'CONFIRMATION_NOT_FOUND',
      });
    } finally {
      await agent.destroy();
    }
  });

  it('同一 session 正在 run 时，resume 会被并发保护拒绝', async () => {
    const { agent } = await createAgent();
    const runtimeAgent = agent as RuntimeAgent & {
      model: { chat: (...args: unknown[]) => Promise<unknown> };
    };
    const originalChat = runtimeAgent.model.chat.bind(runtimeAgent.model);

    let releaseChat: (() => void) | undefined;
    const chatBlocked = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });

    vi.spyOn(runtimeAgent.model, 'chat').mockImplementation(async (...args: unknown[]) => {
      await chatBlocked;
      return originalChat(...args);
    });

    const runPromise = agent.run('请创建评论');

    try {
      await expect(agent.resume()).rejects.toMatchObject({
        code: 'AGENT_ALREADY_RUNNING',
      });
    } finally {
      releaseChat?.();
      await runPromise.catch(() => undefined);
      await agent.destroy();
    }
  });

  it('restore 会把未完成 started execution 标记为 interrupted', async () => {
    const sessionId = 'restore-interrupted-session';
    const toolExecutions = new FakeToolExecutionRepository();
    const confirmations = new FakeConfirmationRepository();
    const approvalGrants = new FakeApprovalGrantRepository();

    const firstAgentBundle = await createAgent({ sessionId, toolExecutions, confirmations, approvalGrants });

    try {
      await toolExecutions.create({
        id: 'manual-started-call',
        sessionId,
        tool: 'create_comment',
        callId: 'manual-started-call',
        args: { ticketId: 'T-1', content: 'hello' },
        status: 'started',
        startedAt: '2025-01-01T00:00:00.000Z',
      });
    } finally {
      await firstAgentBundle.agent.destroy();
    }

    const restoredAgentBundle = await createAgent({ sessionId, toolExecutions, confirmations, approvalGrants });

    try {
      await restoredAgentBundle.agent.restoreSessionState();
      const restoredRecords = await toolExecutions.listBySession(sessionId);
      const interrupted = restoredRecords.find((record) => record.id === 'manual-started-call');
      expect(interrupted?.status).toBe('interrupted');
      expect(interrupted?.error).toBe('session restored after process interruption');
      expect(interrupted?.finishedAt).toBeTruthy();
    } finally {
      await restoredAgentBundle.agent.destroy();
    }
  });

  it('工具执行会写入 execution records', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true, source: 'execution-test' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { agent, toolExecutions } = await createAgent();

    try {
      const runResult = await agent.run('请创建评论');
      expect(runResult.pendingConfirmation).toBeTruthy();
      expect(toolExecutions.records).toHaveLength(1);
      expect(toolExecutions.records[0].status).toBe('waiting_confirmation');
      expect(toolExecutions.records[0].tool).toBe('create_comment');
    } finally {
      await agent.destroy();
    }
  });
});
