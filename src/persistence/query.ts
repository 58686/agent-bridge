import { Message } from '../core/types.js';
import { ApiAuditEvent, ApiAuditQuery } from '../api-security.js';
import { AgentPersistence } from './interfaces.js';
import {
  ApprovalGrantRecord,
  ConfirmationDecisionRecord,
  ConfirmationRequestRecord,
  SessionRecord,
  SessionSnapshotRecord,
  ToolExecutionRecord,
} from './types.js';

interface PersistenceQueryDependencies {
  sessions: NonNullable<AgentPersistence['sessions']>;
  confirmations: NonNullable<AgentPersistence['confirmations']>;
  approvalGrants: NonNullable<AgentPersistence['approvalGrants']>;
  toolExecutions: NonNullable<AgentPersistence['toolExecutions']>;
  auditEvents?: AgentPersistence['auditEvents'];
}

export interface SessionDetails {
  session: SessionRecord;
  snapshot?: SessionSnapshotRecord;
  pendingConfirmations: ConfirmationRequestRecord[];
  approvalGrants: ApprovalGrantRecord[];
}

export interface SessionStateSummary {
  sessionId: string;
  projectId: string;
  status: SessionRecord['status'];
  createdAt: string;
  updatedAt: string;
  lastInput?: string;
  lastError?: string;
  messageCount: number;
  pendingConfirmationCount: number;
  activeGrantCount: number;
}

export interface SessionListItem extends SessionRecord {
  messageCount: number;
  pendingConfirmationCount: number;
  activeGrantCount: number;
  toolExecutionCount: number;
  failedToolExecutionCount: number;
  lastToolExecutionStatus?: ToolExecutionRecord['status'];
  lastToolName?: string;
  lastToolStartedAt?: string;
  lastConfirmationTool?: string;
  lastConfirmationRiskLevel?: ConfirmationRequestRecord['riskLevel'];
  lastConfirmationCreatedAt?: string;
  lastDecision?: ConfirmationDecisionRecord['decision'];
  lastDecisionAt?: string;
  derivedState: {
    needsAttention: boolean;
    approvalState: 'blocked' | 'approved' | 'rejected' | 'clear';
    executionState: 'waiting' | 'failed' | 'completed' | 'idle';
  };
  queueMatches: Array<'attention' | 'blocked' | 'failed' | 'idle'>;
}

export interface SystemMetricsQuery {
  projectId?: string;
  from?: string;
  to?: string;
  bucketMinutes?: number;
  topActionsLimit?: number;
  actorLimit?: number;
}

export interface ToolExecutionQuery {
  sessionId?: string;
  projectId?: string;
  tool?: string;
  status?: ToolExecutionRecord['status'];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface SessionDerivedStateSource {
  pendingConfirmationCount: number;
  failedToolExecutionCount: number;
  lastToolExecutionStatus?: ToolExecutionRecord['status'];
  lastDecision?: ConfirmationDecisionRecord['decision'];
}

export interface SessionQuery {
  projectId?: string;
  status?: SessionRecord['status'];
  from?: string;
  to?: string;
  hasPendingConfirmation?: boolean;
  hasActiveGrant?: boolean;
  lastToolExecutionStatus?: ToolExecutionRecord['status'];
  lastConfirmationRiskLevel?: ConfirmationRequestRecord['riskLevel'];
  lastDecision?: ConfirmationDecisionRecord['decision'];
  hasFailedToolExecution?: boolean;
  needsAttention?: boolean;
  approvalState?: 'blocked' | 'approved' | 'rejected' | 'clear';
  executionState?: 'waiting' | 'failed' | 'completed' | 'idle';
  queue?: 'attention' | 'blocked' | 'failed' | 'idle';
  sortBy?: 'updatedAt' | 'createdAt' | 'messageCount' | 'pendingConfirmationCount' | 'activeGrantCount' | 'toolExecutionCount' | 'failedToolExecutionCount' | 'lastToolStartedAt' | 'lastConfirmationCreatedAt' | 'lastDecisionAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ConfirmationRequestQuery {
  sessionId?: string;
  projectId?: string;
  tool?: string;
  riskLevel?: ConfirmationRequestRecord['riskLevel'];
  status?: ConfirmationRequestRecord['status'];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ConfirmationDecisionQuery {
  sessionId?: string;
  requestId?: string;
  decision?: ConfirmationDecisionRecord['decision'];
  actor?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface ActionMetricSummary {
  action: string;
  total: number;
  success: number;
  failure: number;
  failureRate: number;
}

interface ActorMetricSummary {
  actorId: string;
  total: number;
  success: number;
  failure: number;
  failureRate: number;
  actions: Record<string, number>;
}

interface MetricsTimeBucketSummary {
  startedAt: string;
  endedAt: string;
  toolExecutionCount: number;
  failedToolExecutionCount: number;
  toolFailureRate: number;
  auditEventCount: number;
  auditFailureCount: number;
  auditFailureRate: number;
}

interface FailedToolMetricSummary {
  tool: string;
  total: number;
  failed: number;
  failureRate: number;
}

interface SlowToolMetricSummary {
  tool: string;
  countWithDuration: number;
  averageDurationMs: number;
  maxDurationMs: number;
}

export interface SystemMetricsSummary {
  window: {
    from?: string;
    to?: string;
    bucketMinutes: number;
  };
  sessionCount: number;
  sessionsByStatus: Record<SessionRecord['status'], number>;
  pendingConfirmationCount: number;
  activeGrantCount: number;
  toolExecutionCount: number;
  toolExecutionByStatus: Record<ToolExecutionRecord['status'], number>;
  failedToolExecutionCount: number;
  toolFailureRate: number;
  averageToolDurationMs: number;
  auditEventCount: number;
  auditFailureCount: number;
  auditFailureRate: number;
  auditEventsByAction: Record<string, { total: number; success: number; failure: number }>;
  topActions: ActionMetricSummary[];
  topFailedTools: FailedToolMetricSummary[];
  slowestTools: SlowToolMetricSummary[];
  actors: ActorMetricSummary[];
  timeline: MetricsTimeBucketSummary[];
}

export class PersistenceQueryService {
  constructor(private readonly persistence: PersistenceQueryDependencies) {}

  async listSessions(projectId?: string): Promise<SessionRecord[]> {
    return this.persistence.sessions.list(projectId);
  }

  async querySessions(query: SessionQuery = {}, actorId?: string): Promise<{
    records: SessionListItem[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);
    const sessions = await this.listAccessibleSessions(query.projectId, actorId);
    const summarized = await Promise.all(sessions.map((session) => this.buildSessionListItem(session)));
    const filtered = filterSessionListItems(summarized, query);
    const sorted = sortSessionListItems(filtered, query);
    const records = sorted.slice(offset, offset + limit);
    return {
      records,
      total: sorted.length,
      limit,
      offset,
      hasMore: offset + records.length < sorted.length,
    };
  }

  async getSessionMessages(sessionId: string): Promise<Message[] | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    const snapshot = await this.persistence.sessions.loadSnapshot(sessionId);
    return snapshot?.messages ?? [];
  }

  async getPendingConfirmations(sessionId: string): Promise<ConfirmationRequestRecord[] | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    return this.persistence.confirmations.listPending(sessionId);
  }

  async querySessionConfirmationRequests(sessionId: string, query: Omit<ConfirmationRequestQuery, 'sessionId' | 'projectId'> = {}): Promise<{
    records: ConfirmationRequestRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  } | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    return this.queryConfirmationRequests({
      sessionId,
      tool: query.tool,
      riskLevel: query.riskLevel,
      status: query.status,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });
  }

  async queryConfirmationRequests(query: ConfirmationRequestQuery = {}, actorId?: string): Promise<{
    records: ConfirmationRequestRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    if (!actorId) {
      return this.persistence.confirmations.queryRequests(query);
    }

    const accessibleSessionIds = await this.getAccessibleSessionIds(query.projectId, actorId);
    if (query.sessionId && !accessibleSessionIds.has(query.sessionId)) {
      return emptyPagedResult(query.limit, query.offset);
    }

    const payload = await this.persistence.confirmations.queryRequests({
      sessionId: query.sessionId,
      projectId: query.projectId,
      tool: query.tool,
      riskLevel: query.riskLevel,
      status: query.status,
      from: query.from,
      to: query.to,
      limit: 100000,
      offset: 0,
    });
    return filterPagedRecordsBySession(payload.records, accessibleSessionIds, query.limit, query.offset);
  }

  async querySessionConfirmationDecisions(sessionId: string, query: Omit<ConfirmationDecisionQuery, 'sessionId'> = {}): Promise<{
    records: ConfirmationDecisionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  } | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    return this.queryConfirmationDecisions({
      sessionId,
      requestId: query.requestId,
      decision: query.decision,
      actor: query.actor,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });
  }

  async queryConfirmationDecisions(query: ConfirmationDecisionQuery = {}, actorId?: string): Promise<{
    records: ConfirmationDecisionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    if (!actorId) {
      return this.persistence.confirmations.queryDecisions(query);
    }

    const accessibleSessionIds = await this.getAccessibleSessionIds(undefined, actorId);
    if (query.sessionId && !accessibleSessionIds.has(query.sessionId)) {
      return emptyPagedResult(query.limit, query.offset);
    }

    const payload = await this.persistence.confirmations.queryDecisions({
      sessionId: query.sessionId,
      requestId: query.requestId,
      decision: query.decision,
      actor: query.actor,
      from: query.from,
      to: query.to,
      limit: 100000,
      offset: 0,
    });
    return filterPagedRecordsBySession(payload.records, accessibleSessionIds, query.limit, query.offset);
  }

  async getApprovalGrants(sessionId: string): Promise<ApprovalGrantRecord[] | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    return this.persistence.approvalGrants.listActive(sessionId);
  }

  async getToolExecutions(sessionId: string): Promise<ToolExecutionRecord[] | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    return this.persistence.toolExecutions.listBySession(sessionId);
  }

  async querySessionToolExecutions(sessionId: string, query: Omit<ToolExecutionQuery, 'sessionId' | 'projectId'> = {}): Promise<{
    records: ToolExecutionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  } | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    return this.queryToolExecutions({
      sessionId,
      tool: query.tool,
      status: query.status,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });
  }

  async queryToolExecutions(query: ToolExecutionQuery = {}, actorId?: string): Promise<{
    records: ToolExecutionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const normalizedQuery = { ...query };
    if (!actorId && !normalizedQuery.projectId) {
      return this.persistence.toolExecutions.query(normalizedQuery);
    }

    const accessibleSessionIds = await this.getAccessibleSessionIds(normalizedQuery.projectId, actorId);
    if (normalizedQuery.sessionId && !accessibleSessionIds.has(normalizedQuery.sessionId)) {
      return emptyPagedResult(normalizedQuery.limit, normalizedQuery.offset);
    }

    const payload = await this.persistence.toolExecutions.query({
      sessionId: normalizedQuery.sessionId,
      tool: normalizedQuery.tool,
      status: normalizedQuery.status,
      from: normalizedQuery.from,
      to: normalizedQuery.to,
      limit: 100000,
      offset: 0,
    });
    return filterPagedRecordsBySession(payload.records, accessibleSessionIds, normalizedQuery.limit, normalizedQuery.offset);
  }

  async getSessionStateSummary(sessionId: string): Promise<SessionStateSummary | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    return this.buildSessionStateSummary(session);
  }

  async getSessionDetails(sessionId: string): Promise<SessionDetails | null> {
    const session = await this.persistence.sessions.getById(sessionId);
    if (!session) {
      return null;
    }

    const [snapshot, pendingConfirmations, approvalGrants] = await Promise.all([
      this.persistence.sessions.loadSnapshot(sessionId),
      this.persistence.confirmations.listPending(sessionId),
      this.persistence.approvalGrants.listActive(sessionId),
    ]);

    return {
      session,
      snapshot: snapshot ?? undefined,
      pendingConfirmations,
      approvalGrants,
    };
  }

  private async buildSessionStateSummary(session: SessionRecord): Promise<SessionStateSummary> {
    const [snapshot, pendingConfirmations, approvalGrants] = await Promise.all([
      this.persistence.sessions.loadSnapshot(session.id),
      this.persistence.confirmations.listPending(session.id),
      this.persistence.approvalGrants.listActive(session.id),
    ]);

    return {
      sessionId: session.id,
      projectId: session.projectId,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastInput: session.lastInput,
      lastError: session.lastError,
      messageCount: snapshot?.messages.length ?? 0,
      pendingConfirmationCount: pendingConfirmations.length,
      activeGrantCount: approvalGrants.length,
    };
  }

  private async buildSessionListItem(session: SessionRecord): Promise<SessionListItem> {
    const [summary, toolExecutions, confirmationRequests, confirmationDecisions] = await Promise.all([
      this.buildSessionStateSummary(session),
      this.persistence.toolExecutions.listBySession(session.id),
      this.persistence.confirmations.queryRequests({ sessionId: session.id, limit: 1, offset: 0 }),
      this.persistence.confirmations.queryDecisions({ sessionId: session.id, limit: 1, offset: 0 }),
    ]);
    const lastToolExecution = toolExecutions
      .slice()
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))[0];
    const lastConfirmation = confirmationRequests.records[0];
    const lastDecision = confirmationDecisions.records[0];
    const baseRecord = {
      ...session,
      messageCount: summary.messageCount,
      pendingConfirmationCount: summary.pendingConfirmationCount,
      activeGrantCount: summary.activeGrantCount,
      toolExecutionCount: toolExecutions.length,
      failedToolExecutionCount: toolExecutions.filter((entry) => entry.status === 'failed').length,
      lastToolExecutionStatus: lastToolExecution?.status,
      lastToolName: lastToolExecution?.tool,
      lastToolStartedAt: lastToolExecution?.startedAt,
      lastConfirmationTool: lastConfirmation?.tool,
      lastConfirmationRiskLevel: lastConfirmation?.riskLevel,
      lastConfirmationCreatedAt: lastConfirmation?.createdAt,
      lastDecision: lastDecision?.decision,
      lastDecisionAt: lastDecision?.createdAt,
    };

    return {
      ...baseRecord,
      derivedState: buildSessionDerivedState(baseRecord),
      queueMatches: buildSessionQueueMatches(baseRecord),
    };
  }

  private async listAccessibleSessions(projectId?: string, actorId?: string): Promise<SessionRecord[]> {
    const sessions = await this.persistence.sessions.list(projectId);
    if (!actorId) {
      return sessions;
    }

    return sessions.filter((session) => session.actorId === actorId);
  }

  private async getAccessibleSessionIds(projectId?: string, actorId?: string): Promise<Set<string>> {
    const sessions = await this.listAccessibleSessions(projectId, actorId);
    return new Set(sessions.map((session) => session.id));
  }

  async getAuditEvents(query: ApiAuditQuery = {}, actorId?: string): Promise<{
    events: ApiAuditEvent[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    if (!this.persistence.auditEvents) {
      return emptyAuditResult(query.limit, query.offset);
    }

    if (!actorId) {
      return this.persistence.auditEvents.query(query);
    }

    const accessibleSessionIds = await this.getAccessibleSessionIds(undefined, actorId);
    if (query.sessionId && !accessibleSessionIds.has(query.sessionId)) {
      return emptyAuditResult(query.limit, query.offset);
    }

    const payload = await this.persistence.auditEvents.query({
      sessionId: query.sessionId,
      actorId: query.actorId,
      action: query.action,
      result: query.result,
      from: query.from,
      to: query.to,
      limit: 100000,
      offset: 0,
    });
    const filtered = payload.events.filter((event) => event.sessionId && accessibleSessionIds.has(event.sessionId));
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);
    const events = filtered.slice(offset, offset + limit);
    return {
      events,
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + events.length < filtered.length,
    };
  }

  async getSystemMetrics(query: string | SystemMetricsQuery = {}, actorId?: string): Promise<SystemMetricsSummary> {
    const normalizedQuery = typeof query === 'string' ? { projectId: query } : query;
    const bucketMinutes = normalizePositiveInteger(normalizedQuery.bucketMinutes, 15, 1440);
    const topActionsLimit = normalizePositiveInteger(normalizedQuery.topActionsLimit, 5, 50);
    const actorLimit = normalizePositiveInteger(normalizedQuery.actorLimit, 5, 50);

    const sessions = await this.listAccessibleSessions(normalizedQuery.projectId, actorId);
    const sessionIds = new Set(sessions.map((session) => session.id));

    const pendingConfirmations = normalizedQuery.projectId
      ? (await this.persistence.confirmations.listPending()).filter((entry) => entry.projectId === normalizedQuery.projectId && sessionIds.has(entry.sessionId))
      : (await this.persistence.confirmations.listPending()).filter((entry) => sessionIds.has(entry.sessionId));

    const activeGrants = normalizedQuery.projectId
      ? (await this.persistence.approvalGrants.listActive()).filter((entry) => sessionIds.has(entry.sessionId))
      : (await this.persistence.approvalGrants.listActive()).filter((entry) => sessionIds.has(entry.sessionId));

    const toolExecutionsBySession = await Promise.all(
      sessions.map(async (session) => this.persistence.toolExecutions.listBySession(session.id)),
    );
    const toolExecutions = filterToolExecutionsByWindow(toolExecutionsBySession.flat(), normalizedQuery);

    const sessionsByStatus: Record<SessionRecord['status'], number> = {
      idle: 0,
      running: 0,
      waiting_confirmation: 0,
      completed: 0,
      failed: 0,
    };
    for (const session of sessions) {
      sessionsByStatus[session.status] += 1;
    }

    const toolExecutionByStatus: Record<ToolExecutionRecord['status'], number> = {
      started: 0,
      finished: 0,
      failed: 0,
      waiting_confirmation: 0,
      interrupted: 0,
    };
    for (const execution of toolExecutions) {
      toolExecutionByStatus[execution.status] += 1;
    }

    const finishedDurations = toolExecutions
      .map((execution) => execution.durationMs)
      .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));

    const auditEvents = await this.collectMetricsAuditEvents(normalizedQuery, sessions);
    const auditEventsByAction = summarizeAuditEventsByAction(auditEvents);
    const auditFailureCount = auditEvents.filter((event) => event.result === 'failure').length;

    return {
      window: {
        from: normalizedQuery.from,
        to: normalizedQuery.to,
        bucketMinutes,
      },
      sessionCount: sessions.length,
      sessionsByStatus,
      pendingConfirmationCount: pendingConfirmations.length,
      activeGrantCount: activeGrants.length,
      toolExecutionCount: toolExecutions.length,
      toolExecutionByStatus,
      failedToolExecutionCount: toolExecutionByStatus.failed,
      toolFailureRate: toolExecutions.length ? toolExecutionByStatus.failed / toolExecutions.length : 0,
      averageToolDurationMs: finishedDurations.length
        ? finishedDurations.reduce((sum, duration) => sum + duration, 0) / finishedDurations.length
        : 0,
      auditEventCount: auditEvents.length,
      auditFailureCount,
      auditFailureRate: auditEvents.length ? auditFailureCount / auditEvents.length : 0,
      auditEventsByAction,
      topActions: summarizeTopActions(auditEventsByAction, topActionsLimit),
      topFailedTools: summarizeFailedTools(toolExecutions, topActionsLimit),
      slowestTools: summarizeSlowTools(toolExecutions, topActionsLimit),
      actors: summarizeActors(auditEvents, actorLimit),
      timeline: buildTimeline(toolExecutions, auditEvents, normalizedQuery, bucketMinutes),
    };
  }

  private async collectMetricsAuditEvents(query: SystemMetricsQuery, sessions: SessionRecord[]): Promise<ApiAuditEvent[]> {
    if (!this.persistence.auditEvents) {
      return [];
    }

    const payload = await this.persistence.auditEvents.query({
      from: query.from,
      to: query.to,
      limit: 100000,
      offset: 0,
    });

    if (!query.projectId) {
      return payload.events;
    }

    const allowedSessionIds = new Set(sessions.map((session) => session.id));
    return payload.events.filter((event) => !event.sessionId || allowedSessionIds.has(event.sessionId));
  }
}

function filterToolExecutionsByWindow(executions: ToolExecutionRecord[], query: SystemMetricsQuery): ToolExecutionRecord[] {
  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  return executions.filter((execution) => {
    const executionTimestamp = Date.parse(execution.startedAt);
    if (fromTimestamp !== undefined && Number.isFinite(fromTimestamp) && executionTimestamp < fromTimestamp) {
      return false;
    }
    if (toTimestamp !== undefined && Number.isFinite(toTimestamp) && executionTimestamp > toTimestamp) {
      return false;
    }
    return true;
  });
}

function filterSessionListItems(records: SessionListItem[], query: SessionQuery): SessionListItem[] {
  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  return records.filter((record) => {
    if (query.projectId && record.projectId !== query.projectId) {
      return false;
    }
    if (query.status && record.status !== query.status) {
      return false;
    }
    const updatedAt = Date.parse(record.updatedAt);
    if (fromTimestamp !== undefined && Number.isFinite(fromTimestamp) && updatedAt < fromTimestamp) {
      return false;
    }
    if (toTimestamp !== undefined && Number.isFinite(toTimestamp) && updatedAt > toTimestamp) {
      return false;
    }
    if (typeof query.hasPendingConfirmation === 'boolean' && (record.pendingConfirmationCount > 0) !== query.hasPendingConfirmation) {
      return false;
    }
    if (typeof query.hasActiveGrant === 'boolean' && (record.activeGrantCount > 0) !== query.hasActiveGrant) {
      return false;
    }
    if (query.lastToolExecutionStatus && record.lastToolExecutionStatus !== query.lastToolExecutionStatus) {
      return false;
    }
    if (query.lastConfirmationRiskLevel && record.lastConfirmationRiskLevel !== query.lastConfirmationRiskLevel) {
      return false;
    }
    if (query.lastDecision && record.lastDecision !== query.lastDecision) {
      return false;
    }
    if (typeof query.hasFailedToolExecution === 'boolean' && (record.failedToolExecutionCount > 0) !== query.hasFailedToolExecution) {
      return false;
    }
    if (typeof query.needsAttention === 'boolean' && computeSessionNeedsAttention(record) !== query.needsAttention) {
      return false;
    }
    if (query.approvalState && computeSessionApprovalState(record) !== query.approvalState) {
      return false;
    }
    if (query.executionState && computeSessionExecutionState(record) !== query.executionState) {
      return false;
    }
    if (query.queue && !matchesSessionQueue(record, query.queue)) {
      return false;
    }
    return true;
  });
}

function computeSessionNeedsAttention(record: SessionDerivedStateSource): boolean {
  return record.pendingConfirmationCount > 0
    || record.failedToolExecutionCount > 0
    || record.lastToolExecutionStatus === 'waiting_confirmation';
}

function computeSessionApprovalState(record: SessionDerivedStateSource): NonNullable<SessionQuery['approvalState']> {
  if (record.pendingConfirmationCount > 0) {
    return 'blocked';
  }
  if (record.lastDecision === 'approved') {
    return 'approved';
  }
  if (record.lastDecision === 'rejected') {
    return 'rejected';
  }
  return 'clear';
}

function computeSessionExecutionState(record: SessionDerivedStateSource): NonNullable<SessionQuery['executionState']> {
  if (!record.lastToolExecutionStatus) {
    return 'idle';
  }
  if (record.lastToolExecutionStatus === 'waiting_confirmation') {
    return 'waiting';
  }
  if (record.lastToolExecutionStatus === 'failed') {
    return 'failed';
  }
  return 'completed';
}

function matchesSessionQueue(record: SessionListItem, queue: NonNullable<SessionQuery['queue']>): boolean {
  return buildSessionQueueMatches(record).includes(queue);
}

function buildSessionDerivedState(record: SessionDerivedStateSource): SessionListItem['derivedState'] {
  return {
    needsAttention: computeSessionNeedsAttention(record),
    approvalState: computeSessionApprovalState(record),
    executionState: computeSessionExecutionState(record),
  };
}

function buildSessionQueueMatches(record: SessionDerivedStateSource): SessionListItem['queueMatches'] {
  const derivedState = buildSessionDerivedState(record);
  const matches: SessionListItem['queueMatches'] = [];
  if (derivedState.needsAttention) {
    matches.push('attention');
  }
  if (derivedState.approvalState === 'blocked') {
    matches.push('blocked');
  }
  if (derivedState.executionState === 'failed') {
    matches.push('failed');
  }
  if (derivedState.executionState === 'idle') {
    matches.push('idle');
  }
  return matches;
}

function sortSessionListItems(records: SessionListItem[], query: SessionQuery): SessionListItem[] {
  const sortBy = query.sortBy ?? 'updatedAt';
  const sortOrder = query.sortOrder ?? 'desc';
  const direction = sortOrder === 'asc' ? 1 : -1;

  return [...records].sort((left, right) => {
    const primary = compareSessionListItems(left, right, sortBy, direction);
    if (primary !== 0) {
      return primary;
    }

    const updatedAtFallback = compareIsoStrings(left.updatedAt, right.updatedAt, -1);
    if (updatedAtFallback !== 0) {
      return updatedAtFallback;
    }

    return left.id.localeCompare(right.id);
  });
}

function compareSessionListItems(
  left: SessionListItem,
  right: SessionListItem,
  sortBy: NonNullable<SessionQuery['sortBy']>,
  direction: 1 | -1,
): number {
  if (sortBy === 'updatedAt' || sortBy === 'createdAt' || sortBy === 'lastToolStartedAt' || sortBy === 'lastConfirmationCreatedAt' || sortBy === 'lastDecisionAt') {
    return compareNullableIsoStrings(left[sortBy], right[sortBy], direction);
  }

  return compareNumbers(left[sortBy], right[sortBy], direction);
}

function compareNullableIsoStrings(left: string | undefined, right: string | undefined, direction: 1 | -1): number {
  if (left && right) {
    return left.localeCompare(right) * direction;
  }
  if (left) {
    return 1 * direction;
  }
  if (right) {
    return -1 * direction;
  }
  return 0;
}

function compareIsoStrings(left: string, right: string, direction: 1 | -1): number {
  return left.localeCompare(right) * direction;
}

function compareNumbers(left: number, right: number, direction: 1 | -1): number {
  return (left - right) * direction;
}

function filterPagedRecordsBySession<T extends { sessionId: string }>(
  records: T[],
  accessibleSessionIds: Set<string>,
  requestedLimit?: number,
  requestedOffset?: number,
): {
  records: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
} {
  const filtered = records.filter((record) => accessibleSessionIds.has(record.sessionId));
  const limit = normalizePositiveInteger(requestedLimit, 50, 200);
  const offset = normalizeNonNegativeInteger(requestedOffset, 0);
  const pagedRecords = filtered.slice(offset, offset + limit);
  return {
    records: pagedRecords,
    total: filtered.length,
    limit,
    offset,
    hasMore: offset + pagedRecords.length < filtered.length,
  };
}

function emptyPagedResult<T>(requestedLimit?: number, requestedOffset?: number): {
  records: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
} {
  const limit = normalizePositiveInteger(requestedLimit, 50, 200);
  const offset = normalizeNonNegativeInteger(requestedOffset, 0);
  return {
    records: [],
    total: 0,
    limit,
    offset,
    hasMore: false,
  };
}

function emptyAuditResult(requestedLimit?: number, requestedOffset?: number): {
  events: ApiAuditEvent[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
} {
  const limit = normalizePositiveInteger(requestedLimit, 50, 200);
  const offset = normalizeNonNegativeInteger(requestedOffset, 0);
  return {
    events: [],
    total: 0,
    limit,
    offset,
    hasMore: false,
  };
}

function summarizeAuditEventsByAction(events: ApiAuditEvent[]): Record<string, { total: number; success: number; failure: number }> {
  const result: Record<string, { total: number; success: number; failure: number }> = {};
  for (const event of events) {
    if (!result[event.action]) {
      result[event.action] = { total: 0, success: 0, failure: 0 };
    }
    result[event.action].total += 1;
    result[event.action][event.result] += 1;
  }
  return result;
}

function summarizeTopActions(
  auditEventsByAction: Record<string, { total: number; success: number; failure: number }>,
  limit: number,
): ActionMetricSummary[] {
  return Object.entries(auditEventsByAction)
    .map(([action, summary]) => ({
      action,
      total: summary.total,
      success: summary.success,
      failure: summary.failure,
      failureRate: summary.total ? summary.failure / summary.total : 0,
    }))
    .sort((left, right) => right.total - left.total || right.failure - left.failure || left.action.localeCompare(right.action))
    .slice(0, limit);
}

function summarizeActors(events: ApiAuditEvent[], limit: number): ActorMetricSummary[] {
  const actors = new Map<string, ActorMetricSummary>();

  for (const event of events) {
    const actorId = event.actorId ?? 'anonymous';
    const existing = actors.get(actorId) ?? {
      actorId,
      total: 0,
      success: 0,
      failure: 0,
      failureRate: 0,
      actions: {},
    };

    existing.total += 1;
    existing[event.result] += 1;
    existing.actions[event.action] = (existing.actions[event.action] ?? 0) + 1;
    existing.failureRate = existing.total ? existing.failure / existing.total : 0;
    actors.set(actorId, existing);
  }

  return Array.from(actors.values())
    .sort((left, right) => right.total - left.total || right.failure - left.failure || left.actorId.localeCompare(right.actorId))
    .slice(0, limit);
}

function summarizeFailedTools(toolExecutions: ToolExecutionRecord[], limit: number): FailedToolMetricSummary[] {
  const tools = new Map<string, FailedToolMetricSummary>();

  for (const execution of toolExecutions) {
    const existing = tools.get(execution.tool) ?? {
      tool: execution.tool,
      total: 0,
      failed: 0,
      failureRate: 0,
    };
    existing.total += 1;
    if (execution.status === 'failed') {
      existing.failed += 1;
    }
    existing.failureRate = existing.total ? existing.failed / existing.total : 0;
    tools.set(execution.tool, existing);
  }

  return Array.from(tools.values())
    .filter((entry) => entry.failed > 0)
    .sort((left, right) => right.failed - left.failed || right.total - left.total || left.tool.localeCompare(right.tool))
    .slice(0, limit);
}

function summarizeSlowTools(toolExecutions: ToolExecutionRecord[], limit: number): SlowToolMetricSummary[] {
  const tools = new Map<string, { tool: string; durations: number[] }>();

  for (const execution of toolExecutions) {
    if (typeof execution.durationMs !== 'number' || !Number.isFinite(execution.durationMs)) {
      continue;
    }
    const existing = tools.get(execution.tool) ?? {
      tool: execution.tool,
      durations: [],
    };
    existing.durations.push(execution.durationMs);
    tools.set(execution.tool, existing);
  }

  return Array.from(tools.values())
    .map((entry) => ({
      tool: entry.tool,
      countWithDuration: entry.durations.length,
      averageDurationMs: entry.durations.reduce((sum, duration) => sum + duration, 0) / entry.durations.length,
      maxDurationMs: Math.max(...entry.durations),
    }))
    .sort((left, right) => right.averageDurationMs - left.averageDurationMs || right.maxDurationMs - left.maxDurationMs || left.tool.localeCompare(right.tool))
    .slice(0, limit);
}

function buildTimeline(
  toolExecutions: ToolExecutionRecord[],
  auditEvents: ApiAuditEvent[],
  query: SystemMetricsQuery,
  bucketMinutes: number,
): MetricsTimeBucketSummary[] {
  const bucketSizeMs = bucketMinutes * 60 * 1000;
  const timestamps = [
    ...toolExecutions.map((execution) => Date.parse(execution.startedAt)),
    ...auditEvents.map((event) => Date.parse(event.timestamp)),
  ].filter((value) => Number.isFinite(value));

  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  if (timestamps.length === 0) {
    if (fromTimestamp !== undefined && toTimestamp !== undefined && fromTimestamp <= toTimestamp) {
      return buildEmptyTimeline(fromTimestamp, toTimestamp, bucketSizeMs);
    }
    return [];
  }

  const effectiveStart = fromTimestamp !== undefined && Number.isFinite(fromTimestamp)
    ? fromTimestamp
    : Math.min(...timestamps);
  const effectiveEnd = toTimestamp !== undefined && Number.isFinite(toTimestamp)
    ? toTimestamp
    : Math.max(...timestamps);

  if (effectiveStart > effectiveEnd) {
    return [];
  }

  const bucketMap = new Map<number, MetricsTimeBucketSummary>();
  for (let cursor = floorToBucket(effectiveStart, bucketSizeMs); cursor <= effectiveEnd; cursor += bucketSizeMs) {
    bucketMap.set(cursor, createEmptyBucket(cursor, bucketSizeMs));
  }

  for (const execution of toolExecutions) {
    const timestamp = Date.parse(execution.startedAt);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const bucketStart = floorToBucket(timestamp, bucketSizeMs);
    const bucket = bucketMap.get(bucketStart);
    if (!bucket) {
      continue;
    }
    bucket.toolExecutionCount += 1;
    if (execution.status === 'failed') {
      bucket.failedToolExecutionCount += 1;
    }
  }

  for (const event of auditEvents) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const bucketStart = floorToBucket(timestamp, bucketSizeMs);
    const bucket = bucketMap.get(bucketStart);
    if (!bucket) {
      continue;
    }
    bucket.auditEventCount += 1;
    if (event.result === 'failure') {
      bucket.auditFailureCount += 1;
    }
  }

  return Array.from(bucketMap.values())
    .map((bucket) => ({
      ...bucket,
      toolFailureRate: bucket.toolExecutionCount ? bucket.failedToolExecutionCount / bucket.toolExecutionCount : 0,
      auditFailureRate: bucket.auditEventCount ? bucket.auditFailureCount / bucket.auditEventCount : 0,
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function buildEmptyTimeline(fromTimestamp: number, toTimestamp: number, bucketSizeMs: number): MetricsTimeBucketSummary[] {
  const result: MetricsTimeBucketSummary[] = [];
  for (let cursor = floorToBucket(fromTimestamp, bucketSizeMs); cursor <= toTimestamp; cursor += bucketSizeMs) {
    result.push(createEmptyBucket(cursor, bucketSizeMs));
  }
  return result;
}

function createEmptyBucket(startTimestamp: number, bucketSizeMs: number): MetricsTimeBucketSummary {
  return {
    startedAt: new Date(startTimestamp).toISOString(),
    endedAt: new Date(startTimestamp + bucketSizeMs - 1).toISOString(),
    toolExecutionCount: 0,
    failedToolExecutionCount: 0,
    toolFailureRate: 0,
    auditEventCount: 0,
    auditFailureCount: 0,
    auditFailureRate: 0,
  };
}

function floorToBucket(timestamp: number, bucketSizeMs: number): number {
  return Math.floor(timestamp / bucketSizeMs) * bucketSizeMs;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}
