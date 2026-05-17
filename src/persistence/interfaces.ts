import { Message, ToolConfirmationRequest } from '../core/types.js';
import { ApiAuditEvent, ApiAuditQueryResult } from '../api-security.js';
import {
  ApprovalGrantRecord,
  ConfirmationDecisionRecord,
  ConfirmationRequestRecord,
  SessionRecord,
  SessionRestoreState,
  SessionSnapshotRecord,
  SessionStatus,
  ToolExecutionRecord,
} from './types.js';

export interface SessionRepository {
  create(session: SessionRecord): Promise<void>;
  getById(sessionId: string): Promise<SessionRecord | null>;
  list(projectId?: string): Promise<SessionRecord[]>;
  query(query?: {
    projectId?: string;
    status?: SessionStatus;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: SessionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }>;
  updateStatus(
    sessionId: string,
    status: SessionStatus,
    patch?: Partial<Pick<SessionRecord, 'updatedAt' | 'lastInput' | 'lastError'>>,
  ): Promise<void>;
  saveSnapshot(snapshot: SessionSnapshotRecord): Promise<void>;
  loadSnapshot(sessionId: string): Promise<SessionSnapshotRecord | null>;
}

export interface ConfirmationRepository {
  createRequest(request: ConfirmationRequestRecord): Promise<void>;
  getById(requestId: string): Promise<ConfirmationRequestRecord | null>;
  listPending(sessionId?: string): Promise<ConfirmationRequestRecord[]>;
  queryRequests(query?: {
    sessionId?: string;
    projectId?: string;
    tool?: string;
    riskLevel?: ConfirmationRequestRecord['riskLevel'];
    status?: ConfirmationRequestRecord['status'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: ConfirmationRequestRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }>;
  queryDecisions(query?: {
    sessionId?: string;
    requestId?: string;
    decision?: ConfirmationDecisionRecord['decision'];
    actor?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: ConfirmationDecisionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }>;
  findPendingMatch(
    sessionId: string,
    tool: string,
    callId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ConfirmationRequestRecord | null>;
  markApproved(requestId: string, updatedAt: string): Promise<void>;
  markRejected(requestId: string, updatedAt: string): Promise<void>;
  markConsumed(requestId: string, updatedAt: string): Promise<void>;
  markExpired(requestId: string, updatedAt: string): Promise<void>;
  expirePending(beforeOrAt: string): Promise<number>;
  appendDecision(decision: ConfirmationDecisionRecord): Promise<void>;
}

export interface ApprovalGrantRepository {
  createGrant(grant: ApprovalGrantRecord): Promise<void>;
  findMatchingGrant(
    sessionId: string,
    tool: string,
    callId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ApprovalGrantRecord | null>;
  consumeGrant(requestId: string, consumedAt: string): Promise<void>;
  expireActive(beforeOrAt: string): Promise<number>;
  listActive(sessionId?: string): Promise<ApprovalGrantRecord[]>;
}

export interface ToolExecutionRepository {
  create(record: ToolExecutionRecord): Promise<void>;
  finish(
    id: string,
    patch: Pick<ToolExecutionRecord, 'status' | 'finishedAt' | 'durationMs' | 'error' | 'result'>,
  ): Promise<void>;
  markInterrupted(sessionId: string, interruptedAt: string, reason?: string): Promise<number>;
  listBySession(sessionId: string): Promise<ToolExecutionRecord[]>;
  query(query?: {
    sessionId?: string;
    tool?: string;
    status?: ToolExecutionRecord['status'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: ToolExecutionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }>;
}

export interface AuditEventRepository {
  create(event: ApiAuditEvent): Promise<void>;
  query(query?: {
    sessionId?: string;
    actorId?: string;
    action?: string;
    result?: ApiAuditEvent['result'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApiAuditQueryResult>;
  listAll(): Promise<ApiAuditEvent[]>;
}

export interface AgentPersistence {
  sessions?: SessionRepository;
  confirmations?: ConfirmationRepository;
  approvalGrants?: ApprovalGrantRepository;
  toolExecutions?: ToolExecutionRepository;
  auditEvents?: AuditEventRepository;
}

export interface SessionPersistenceCoordinator {
  restore(sessionId: string): Promise<SessionRestoreState>;
  initializeSession(session: SessionRecord, messages: Message[]): Promise<void>;
}

export class NoopSessionRepository implements SessionRepository {
  async create(_session: SessionRecord): Promise<void> {}

  async getById(_sessionId: string): Promise<SessionRecord | null> {
    return null;
  }

  async list(_projectId?: string): Promise<SessionRecord[]> {
    return [];
  }

  async query(_query?: {
    projectId?: string;
    status?: SessionStatus;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: SessionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    return {
      records: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    };
  }

  async updateStatus(
    _sessionId: string,
    _status: SessionStatus,
    _patch?: Partial<Pick<SessionRecord, 'updatedAt' | 'lastInput' | 'lastError'>>,
  ): Promise<void> {}

  async saveSnapshot(_snapshot: SessionSnapshotRecord): Promise<void> {}

  async loadSnapshot(_sessionId: string): Promise<SessionSnapshotRecord | null> {
    return null;
  }
}

export class NoopConfirmationRepository implements ConfirmationRepository {
  async createRequest(_request: ConfirmationRequestRecord): Promise<void> {}

  async getById(_requestId: string): Promise<ConfirmationRequestRecord | null> {
    return null;
  }

  async listPending(_sessionId?: string): Promise<ConfirmationRequestRecord[]> {
    return [];
  }

  async queryRequests(_query?: {
    sessionId?: string;
    projectId?: string;
    tool?: string;
    riskLevel?: ConfirmationRequestRecord['riskLevel'];
    status?: ConfirmationRequestRecord['status'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: ConfirmationRequestRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    return {
      records: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    };
  }

  async queryDecisions(_query?: {
    sessionId?: string;
    requestId?: string;
    decision?: ConfirmationDecisionRecord['decision'];
    actor?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: ConfirmationDecisionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    return {
      records: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    };
  }

  async findPendingMatch(
    _sessionId: string,
    _tool: string,
    _callId: string | undefined,
    _args: Record<string, unknown>,
  ): Promise<ConfirmationRequestRecord | null> {
    return null;
  }

  async markApproved(_requestId: string, _updatedAt: string): Promise<void> {}

  async markRejected(_requestId: string, _updatedAt: string): Promise<void> {}

  async markConsumed(_requestId: string, _updatedAt: string): Promise<void> {}

  async markExpired(_requestId: string, _updatedAt: string): Promise<void> {}

  async expirePending(_beforeOrAt: string): Promise<number> {
    return 0;
  }

  async appendDecision(_decision: ConfirmationDecisionRecord): Promise<void> {}
}

export class NoopApprovalGrantRepository implements ApprovalGrantRepository {
  async createGrant(_grant: ApprovalGrantRecord): Promise<void> {}

  async findMatchingGrant(
    _sessionId: string,
    _tool: string,
    _callId: string | undefined,
    _args: Record<string, unknown>,
  ): Promise<ApprovalGrantRecord | null> {
    return null;
  }

  async consumeGrant(_requestId: string, _consumedAt: string): Promise<void> {}

  async expireActive(_beforeOrAt: string): Promise<number> {
    return 0;
  }

  async listActive(_sessionId?: string): Promise<ApprovalGrantRecord[]> {
    return [];
  }
}

export class NoopToolExecutionRepository implements ToolExecutionRepository {
  async create(_record: ToolExecutionRecord): Promise<void> {}

  async finish(
    _id: string,
    _patch: Pick<ToolExecutionRecord, 'status' | 'finishedAt' | 'durationMs' | 'error' | 'result'>,
  ): Promise<void> {}

  async markInterrupted(_sessionId: string, _interruptedAt: string, _reason?: string): Promise<number> {
    return 0;
  }

  async listBySession(_sessionId: string): Promise<ToolExecutionRecord[]> {
    return [];
  }

  async query(_query?: {
    sessionId?: string;
    tool?: string;
    status?: ToolExecutionRecord['status'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: ToolExecutionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    return {
      records: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    };
  }
}

export class NoopAuditEventRepository implements AuditEventRepository {
  async create(_event: ApiAuditEvent): Promise<void> {}

  async query(_query?: {
    sessionId?: string;
    actorId?: string;
    action?: string;
    result?: ApiAuditEvent['result'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApiAuditQueryResult> {
    return {
      events: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    };
  }

  async listAll(): Promise<ApiAuditEvent[]> {
    return [];
  }
}
