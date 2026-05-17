import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import {
  AgentPersistence,
  ApprovalGrantRepository,
  AuditEventRepository,
  ConfirmationRepository,
  SessionRepository,
  ToolExecutionRepository,
} from './interfaces.js';
import {
  ApprovalGrantRecord,
  ConfirmationDecisionRecord,
  ConfirmationRequestRecord,
  SessionRecord,
  SessionSnapshotRecord,
  SessionStatus,
  ToolExecutionRecord,
} from './types.js';
import { ApiAuditEvent, ApiAuditQueryResult, filterAuditEvents } from '../api-security.js';

interface SqlJsDatabase {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void;
  exec(sql: string, params?: unknown[] | Record<string, unknown>): Array<{
    columns: string[];
    values: unknown[][];
  }>;
  export(): Uint8Array;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array | ArrayLike<number>) => SqlJsDatabase;
}

class SqlitePersistenceContext {
  private sqlPromise?: Promise<SqlJsStatic>;
  private dbPromise?: Promise<SqlJsDatabase>;

  constructor(private readonly filePath: string) {}

  async getDatabase(): Promise<SqlJsDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase();
    }

    return this.dbPromise;
  }

  async persist(): Promise<void> {
    const db = await this.getDatabase();
    const data = db.export();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(data));
  }

  private async openDatabase(): Promise<SqlJsDatabase> {
    const SQL = await this.getSqlJs();
    const fileExists = fs.existsSync(this.filePath);
    const db = fileExists
      ? new SQL.Database(new Uint8Array(fs.readFileSync(this.filePath)))
      : new SQL.Database();

    this.initializeSchema(db);
    if (!fileExists) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, Buffer.from(db.export()));
    }

    return db;
  }

  private async getSqlJs(): Promise<SqlJsStatic> {
    if (!this.sqlPromise) {
      const wasmPath = path.resolve(
        process.cwd(),
        'node_modules/sql.js/dist/sql-wasm.wasm',
      );
      this.sqlPromise = initSqlJs({
        locateFile: () => wasmPath,
      }) as Promise<SqlJsStatic>;
    }

    return this.sqlPromise;
  }

  private initializeSchema(db: SqlJsDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        actor_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_input TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS session_snapshots (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS confirmation_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        args_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        call_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS confirmation_decisions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES confirmation_requests(id)
      );

      CREATE TABLE IF NOT EXISTS approval_grants (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        call_id TEXT,
        args_json TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        approved_by TEXT,
        reason TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        consumed_at TEXT,
        FOREIGN KEY (request_id) REFERENCES confirmation_requests(id)
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        call_id TEXT,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        result_json TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        request_id TEXT,
        method TEXT,
        path TEXT,
        actor_id TEXT,
        role TEXT,
        session_id TEXT,
        request_target_id TEXT,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        status_code INTEGER,
        error TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_confirmation_requests_session_status
        ON confirmation_requests(session_id, status);

      CREATE INDEX IF NOT EXISTS idx_approval_grants_session_consumed
        ON approval_grants(session_id, consumed_at);

      CREATE INDEX IF NOT EXISTS idx_tool_executions_session_started
        ON tool_executions(session_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp
        ON audit_events(timestamp);

      CREATE INDEX IF NOT EXISTS idx_audit_events_session_timestamp
        ON audit_events(session_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_audit_events_action_result
        ON audit_events(action, result);
    `);

    const sessionColumns = db.exec('PRAGMA table_info(sessions)');
    const hasActorId = mapRows(sessionColumns).some((row) => String(row.name) === 'actor_id');
    if (!hasActorId) {
      db.run('ALTER TABLE sessions ADD COLUMN actor_id TEXT');
    }
  }
}

function getFirstRow(
  rows: Array<{ columns: string[]; values: unknown[][] }>,
): Record<string, unknown> | null {
  const result = rows[0];
  if (!result || result.values.length === 0) {
    return null;
  }

  const [values] = result.values;
  return Object.fromEntries(result.columns.map((column, index) => [column, values[index]]));
}

function mapRows(
  rows: Array<{ columns: string[]; values: unknown[][] }>,
): Record<string, unknown>[] {
  const result = rows[0];
  if (!result) {
    return [];
  }

  return result.values.map((values) =>
    Object.fromEntries(result.columns.map((column, index) => [column, values[index]])),
  );
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== 'string') {
    throw new Error('Expected JSON string from SQLite persistence layer');
  }

  return JSON.parse(value) as T;
}

function buildAuditEventId(event: ApiAuditEvent): string {
  return [
    event.timestamp,
    event.requestId ?? '',
    event.sessionId ?? '',
    event.requestTargetId ?? '',
    event.action,
    event.result,
  ].join('::');
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

function filterSessionRecords(
  records: SessionRecord[],
  query: {
    projectId?: string;
    status?: SessionStatus;
    from?: string;
    to?: string;
  },
): SessionRecord[] {
  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  return records
    .filter((record) => {
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
      return true;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function filterConfirmationRequestRecords(
  records: ConfirmationRequestRecord[],
  query: {
    sessionId?: string;
    projectId?: string;
    tool?: string;
    riskLevel?: ConfirmationRequestRecord['riskLevel'];
    status?: ConfirmationRequestRecord['status'];
    from?: string;
    to?: string;
  },
): ConfirmationRequestRecord[] {
  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  return records
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
      if (fromTimestamp !== undefined && Number.isFinite(fromTimestamp) && createdAt < fromTimestamp) {
        return false;
      }
      if (toTimestamp !== undefined && Number.isFinite(toTimestamp) && createdAt > toTimestamp) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function filterConfirmationDecisionRecords(
  records: ConfirmationDecisionRecord[],
  query: {
    sessionId?: string;
    requestId?: string;
    decision?: ConfirmationDecisionRecord['decision'];
    actor?: string;
    from?: string;
    to?: string;
  },
): ConfirmationDecisionRecord[] {
  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  return records
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
      if (fromTimestamp !== undefined && Number.isFinite(fromTimestamp) && createdAt < fromTimestamp) {
        return false;
      }
      if (toTimestamp !== undefined && Number.isFinite(toTimestamp) && createdAt > toTimestamp) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function filterToolExecutionRecords(
  records: ToolExecutionRecord[],
  query: {
    sessionId?: string;
    tool?: string;
    status?: ToolExecutionRecord['status'];
    from?: string;
    to?: string;
  },
): ToolExecutionRecord[] {
  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  return records
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
      if (fromTimestamp !== undefined && Number.isFinite(fromTimestamp) && startedAt < fromTimestamp) {
        return false;
      }
      if (toTimestamp !== undefined && Number.isFinite(toTimestamp) && startedAt > toTimestamp) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly context: SqlitePersistenceContext) {}

  async create(session: SessionRecord): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO sessions
        (id, project_id, actor_id, status, created_at, updated_at, last_input, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.projectId,
        session.actorId ?? null,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.lastInput ?? null,
        session.lastError ?? null,
      ],
    );
    await this.context.persist();
  }

  async getById(sessionId: string): Promise<SessionRecord | null> {
    const db = await this.context.getDatabase();
    const row = getFirstRow(db.exec('SELECT * FROM sessions WHERE id = ?', [sessionId]));
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      projectId: String(row.project_id),
      actorId: row.actor_id ? String(row.actor_id) : undefined,
      status: row.status as SessionStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastInput: row.last_input ? String(row.last_input) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
    };
  }

  async list(projectId?: string): Promise<SessionRecord[]> {
    const db = await this.context.getDatabase();
    const rows = projectId
      ? db.exec('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC', [projectId])
      : db.exec('SELECT * FROM sessions ORDER BY updated_at DESC');

    return mapRows(rows).map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      actorId: row.actor_id ? String(row.actor_id) : undefined,
      status: row.status as SessionStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastInput: row.last_input ? String(row.last_input) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
    }));
  }

  async query(query: {
    projectId?: string;
    status?: SessionStatus;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    records: SessionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const records = filterSessionRecords(await this.listAll(), query);
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);
    const pagedRecords = records.slice(offset, offset + limit);
    return {
      records: pagedRecords,
      total: records.length,
      limit,
      offset,
      hasMore: offset + pagedRecords.length < records.length,
    };
  }

  async updateStatus(
    sessionId: string,
    status: SessionStatus,
    patch?: Partial<Pick<SessionRecord, 'updatedAt' | 'lastInput' | 'lastError'>>,
  ): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `UPDATE sessions
       SET status = ?, updated_at = ?, last_input = COALESCE(?, last_input), last_error = COALESCE(?, last_error)
       WHERE id = ?`,
      [
        status,
        patch?.updatedAt ?? new Date().toISOString(),
        patch?.lastInput ?? null,
        patch?.lastError ?? null,
        sessionId,
      ],
    );
    await this.context.persist();
  }

  async saveSnapshot(snapshot: SessionSnapshotRecord): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO session_snapshots (session_id, messages_json, updated_at)
       VALUES (?, ?, ?)`,
      [snapshot.sessionId, serializeJson(snapshot.messages), snapshot.updatedAt],
    );
    await this.context.persist();
  }

  async loadSnapshot(sessionId: string): Promise<SessionSnapshotRecord | null> {
    const db = await this.context.getDatabase();
    const row = getFirstRow(db.exec('SELECT * FROM session_snapshots WHERE session_id = ?', [sessionId]));
    if (!row) {
      return null;
    }

    return {
      sessionId: String(row.session_id),
      messages: parseJson(row.messages_json),
      updatedAt: String(row.updated_at),
    };
  }

  private async listAll(): Promise<SessionRecord[]> {
    const db = await this.context.getDatabase();
    const rows = db.exec('SELECT * FROM sessions ORDER BY updated_at DESC');
    return mapRows(rows).map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      actorId: row.actor_id ? String(row.actor_id) : undefined,
      status: row.status as SessionStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastInput: row.last_input ? String(row.last_input) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
    }));
  }
}

class SqliteConfirmationRepository implements ConfirmationRepository {
  constructor(private readonly context: SqlitePersistenceContext) {}

  async createRequest(request: ConfirmationRequestRecord): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO confirmation_requests
        (id, session_id, project_id, tool, risk_level, args_json, reason, call_id, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.sessionId,
        request.projectId,
        request.tool,
        request.riskLevel,
        serializeJson(request.args),
        request.reason,
        request.callId ?? null,
        request.status,
        request.createdAt,
        request.updatedAt,
        request.expiresAt ?? null,
      ],
    );
    await this.context.persist();
  }

  async getById(requestId: string): Promise<ConfirmationRequestRecord | null> {
    const db = await this.context.getDatabase();
    const row = getFirstRow(db.exec('SELECT * FROM confirmation_requests WHERE id = ?', [requestId]));
    return row ? this.mapRequest(row) : null;
  }

  async listPending(sessionId?: string): Promise<ConfirmationRequestRecord[]> {
    const db = await this.context.getDatabase();
    const rows = sessionId
      ? db.exec(
        'SELECT * FROM confirmation_requests WHERE session_id = ? AND status = ? ORDER BY created_at ASC',
        [sessionId, 'pending'],
      )
      : db.exec(
        'SELECT * FROM confirmation_requests WHERE status = ? ORDER BY created_at ASC',
        ['pending'],
      );

    return mapRows(rows).map((row) => this.mapRequest(row));
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
  } = {}): Promise<{
    records: ConfirmationRequestRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const records = filterConfirmationRequestRecords(await this.listAllRequests(), query);
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);
    const pagedRecords = records.slice(offset, offset + limit);
    return {
      records: pagedRecords,
      total: records.length,
      limit,
      offset,
      hasMore: offset + pagedRecords.length < records.length,
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
  } = {}): Promise<{
    records: ConfirmationDecisionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const records = filterConfirmationDecisionRecords(await this.listAllDecisions(), query);
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);
    const pagedRecords = records.slice(offset, offset + limit);
    return {
      records: pagedRecords,
      total: records.length,
      limit,
      offset,
      hasMore: offset + pagedRecords.length < records.length,
    };
  }

  async findPendingMatch(
    sessionId: string,
    tool: string,
    callId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ConfirmationRequestRecord | null> {
    const db = await this.context.getDatabase();
    const row = getFirstRow(
      db.exec(
        `SELECT * FROM confirmation_requests
         WHERE session_id = ? AND tool = ? AND status = ?
           AND ((call_id IS NULL AND ? IS NULL) OR call_id = ?)
           AND args_json = ?
         ORDER BY created_at ASC
         LIMIT 1`,
        [sessionId, tool, 'pending', callId ?? null, callId ?? null, serializeJson(args)],
      ),
    );

    return row ? this.mapRequest(row) : null;
  }

  async markApproved(requestId: string, updatedAt: string): Promise<void> {
    await this.updateStatus(requestId, 'approved', updatedAt);
  }

  async markRejected(requestId: string, updatedAt: string): Promise<void> {
    await this.updateStatus(requestId, 'rejected', updatedAt);
  }

  async markConsumed(requestId: string, updatedAt: string): Promise<void> {
    await this.updateStatus(requestId, 'consumed', updatedAt);
  }

  async markExpired(requestId: string, updatedAt: string): Promise<void> {
    await this.updateStatus(requestId, 'expired', updatedAt);
  }

  async expirePending(beforeOrAt: string): Promise<number> {
    const db = await this.context.getDatabase();
    db.run(
      `UPDATE confirmation_requests
       SET status = ?, updated_at = ?
       WHERE status = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
      ['expired', beforeOrAt, 'pending', beforeOrAt],
    );
    const changedRow = getFirstRow(db.exec('SELECT changes() AS count'));
    await this.context.persist();
    return Number(changedRow?.count ?? 0);
  }

  async appendDecision(decision: ConfirmationDecisionRecord): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO confirmation_decisions
        (id, request_id, session_id, decision, actor, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        decision.id,
        decision.requestId,
        decision.sessionId,
        decision.decision,
        decision.actor ?? null,
        decision.reason ?? null,
        decision.createdAt,
      ],
    );
    await this.context.persist();
  }

  private async updateStatus(requestId: string, status: ConfirmationRequestRecord['status'], updatedAt: string): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      'UPDATE confirmation_requests SET status = ?, updated_at = ? WHERE id = ?',
      [status, updatedAt, requestId],
    );
    await this.context.persist();
  }

  private mapRequest(row: Record<string, unknown>): ConfirmationRequestRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      projectId: String(row.project_id),
      tool: String(row.tool),
      riskLevel: row.risk_level as ConfirmationRequestRecord['riskLevel'],
      args: parseJson(row.args_json),
      reason: String(row.reason),
      callId: row.call_id ? String(row.call_id) : undefined,
      status: row.status as ConfirmationRequestRecord['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    };
  }

  private mapDecision(row: Record<string, unknown>): ConfirmationDecisionRecord {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      sessionId: String(row.session_id),
      decision: row.decision as ConfirmationDecisionRecord['decision'],
      actor: row.actor ? String(row.actor) : undefined,
      reason: row.reason ? String(row.reason) : undefined,
      createdAt: String(row.created_at),
    };
  }

  private async listAllRequests(): Promise<ConfirmationRequestRecord[]> {
    const db = await this.context.getDatabase();
    const rows = db.exec('SELECT * FROM confirmation_requests ORDER BY created_at DESC');
    return mapRows(rows).map((row) => this.mapRequest(row));
  }

  private async listAllDecisions(): Promise<ConfirmationDecisionRecord[]> {
    const db = await this.context.getDatabase();
    const rows = db.exec('SELECT * FROM confirmation_decisions ORDER BY created_at DESC');
    return mapRows(rows).map((row) => this.mapDecision(row));
  }
}

class SqliteApprovalGrantRepository implements ApprovalGrantRepository {
  constructor(private readonly context: SqlitePersistenceContext) {}

  async createGrant(grant: ApprovalGrantRecord): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO approval_grants
        (request_id, session_id, tool, call_id, args_json, approved_at, approved_by, reason, expires_at, revoked_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grant.requestId,
        grant.sessionId,
        grant.tool,
        grant.callId ?? null,
        serializeJson(grant.args),
        grant.approvedAt,
        grant.approvedBy ?? null,
        grant.reason ?? null,
        grant.expiresAt ?? null,
        grant.revokedAt ?? null,
        grant.consumedAt ?? null,
      ],
    );
    await this.context.persist();
  }

  async findMatchingGrant(
    sessionId: string,
    tool: string,
    callId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ApprovalGrantRecord | null> {
    const db = await this.context.getDatabase();
    const now = new Date().toISOString();
    const row = getFirstRow(
      db.exec(
        `SELECT * FROM approval_grants
         WHERE session_id = ? AND tool = ? AND consumed_at IS NULL AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND ((call_id IS NULL AND ? IS NULL) OR call_id = ?)
           AND args_json = ?
         ORDER BY approved_at ASC
         LIMIT 1`,
        [sessionId, tool, now, callId ?? null, callId ?? null, serializeJson(args)],
      ),
    );

    return row ? this.mapGrant(row) : null;
  }

  async consumeGrant(requestId: string, consumedAt: string): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      'UPDATE approval_grants SET consumed_at = ? WHERE request_id = ?',
      [consumedAt, requestId],
    );
    await this.context.persist();
  }

  async expireActive(beforeOrAt: string): Promise<number> {
    const db = await this.context.getDatabase();
    db.run(
      `UPDATE approval_grants
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      [beforeOrAt, beforeOrAt],
    );
    const changedRow = getFirstRow(db.exec('SELECT changes() AS count'));
    await this.context.persist();
    return Number(changedRow?.count ?? 0);
  }

  async listActive(sessionId?: string): Promise<ApprovalGrantRecord[]> {
    const db = await this.context.getDatabase();
    const now = new Date().toISOString();
    const rows = sessionId
      ? db.exec(
        `SELECT * FROM approval_grants
         WHERE session_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY approved_at ASC`,
        [sessionId, now],
      )
      : db.exec(
        `SELECT * FROM approval_grants
         WHERE consumed_at IS NULL AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY approved_at ASC`,
        [now],
      );

    return mapRows(rows).map((row) => this.mapGrant(row));
  }

  private mapGrant(row: Record<string, unknown>): ApprovalGrantRecord {
    return {
      requestId: String(row.request_id),
      sessionId: String(row.session_id),
      tool: String(row.tool),
      callId: row.call_id ? String(row.call_id) : undefined,
      args: parseJson(row.args_json),
      approvedAt: String(row.approved_at),
      approvedBy: row.approved_by ? String(row.approved_by) : undefined,
      reason: row.reason ? String(row.reason) : undefined,
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
      consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    };
  }
}

class SqliteToolExecutionRepository implements ToolExecutionRepository {
  constructor(private readonly context: SqlitePersistenceContext) {}

  async create(record: ToolExecutionRecord): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `INSERT OR REPLACE INTO tool_executions
        (id, session_id, tool, call_id, args_json, status, started_at, finished_at, duration_ms, error, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.sessionId,
        record.tool,
        record.callId ?? null,
        serializeJson(record.args),
        record.status,
        record.startedAt,
        record.finishedAt ?? null,
        record.durationMs ?? null,
        record.error ?? null,
        record.result ? serializeJson(record.result) : null,
      ],
    );
    await this.context.persist();
  }

  async finish(
    id: string,
    patch: Pick<ToolExecutionRecord, 'status' | 'finishedAt' | 'durationMs' | 'error' | 'result'>,
  ): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `UPDATE tool_executions
       SET status = ?, finished_at = ?, duration_ms = ?, error = ?, result_json = ?
       WHERE id = ?`,
      [
        patch.status,
        patch.finishedAt ?? null,
        patch.durationMs ?? null,
        patch.error ?? null,
        patch.result ? serializeJson(patch.result) : null,
        id,
      ],
    );
    await this.context.persist();
  }

  async markInterrupted(sessionId: string, interruptedAt: string, reason = 'process interrupted before completion'): Promise<number> {
    const db = await this.context.getDatabase();
    db.run(
      `UPDATE tool_executions
       SET status = ?, finished_at = COALESCE(finished_at, ?), error = COALESCE(error, ?)
       WHERE session_id = ? AND status = ?`,
      ['interrupted', interruptedAt, reason, sessionId, 'started'],
    );
    const changedRow = getFirstRow(db.exec('SELECT changes() AS count'));
    await this.context.persist();
    return Number(changedRow?.count ?? 0);
  }

  async listBySession(sessionId: string): Promise<ToolExecutionRecord[]> {
    const db = await this.context.getDatabase();
    const rows = db.exec(
      'SELECT * FROM tool_executions WHERE session_id = ? ORDER BY started_at ASC',
      [sessionId],
    );

    return mapRows(rows).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      tool: String(row.tool),
      callId: row.call_id ? String(row.call_id) : undefined,
      args: parseJson(row.args_json),
      status: row.status as ToolExecutionRecord['status'],
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
      error: row.error ? String(row.error) : undefined,
      result: row.result_json ? parseJson(row.result_json) : undefined,
    }));
  }

  async query(query: {
    sessionId?: string;
    tool?: string;
    status?: ToolExecutionRecord['status'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    records: ToolExecutionRecord[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const records = filterToolExecutionRecords(await this.listAll(), query);
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);
    const pagedRecords = records.slice(offset, offset + limit);
    return {
      records: pagedRecords,
      total: records.length,
      limit,
      offset,
      hasMore: offset + pagedRecords.length < records.length,
    };
  }

  private async listAll(): Promise<ToolExecutionRecord[]> {
    const db = await this.context.getDatabase();
    const rows = db.exec('SELECT * FROM tool_executions ORDER BY started_at DESC');
    return mapRows(rows).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      tool: String(row.tool),
      callId: row.call_id ? String(row.call_id) : undefined,
      args: parseJson(row.args_json),
      status: row.status as ToolExecutionRecord['status'],
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
      error: row.error ? String(row.error) : undefined,
      result: row.result_json ? parseJson(row.result_json) : undefined,
    }));
  }
}

class SqliteAuditEventRepository implements AuditEventRepository {
  constructor(private readonly context: SqlitePersistenceContext) {}

  async create(event: ApiAuditEvent): Promise<void> {
    const db = await this.context.getDatabase();
    db.run(
      `INSERT INTO audit_events
        (id, timestamp, request_id, method, path, actor_id, role, session_id, request_target_id, action, result, status_code, error, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        buildAuditEventId(event),
        event.timestamp,
        event.requestId ?? null,
        event.method ?? null,
        event.path ?? null,
        event.actorId ?? null,
        event.role ?? null,
        event.sessionId ?? null,
        event.requestTargetId ?? null,
        event.action,
        event.result,
        event.statusCode ?? null,
        event.error ?? null,
        event.metadata ? serializeJson(event.metadata) : null,
      ],
    );
    await this.context.persist();
  }

  async query(query: {
    sessionId?: string;
    actorId?: string;
    action?: string;
    result?: ApiAuditEvent['result'];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<ApiAuditQueryResult> {
    const events = filterAuditEvents(await this.listAll(), query);
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);
    const pagedEvents = events.slice(offset, offset + limit);

    return {
      events: pagedEvents,
      total: events.length,
      limit,
      offset,
      hasMore: offset + pagedEvents.length < events.length,
    };
  }

  async listAll(): Promise<ApiAuditEvent[]> {
    const db = await this.context.getDatabase();
    const rows = db.exec('SELECT * FROM audit_events ORDER BY timestamp DESC');
    return mapRows(rows).map((row) => ({
      timestamp: String(row.timestamp),
      requestId: row.request_id ? String(row.request_id) : undefined,
      method: row.method ? String(row.method) : undefined,
      path: row.path ? String(row.path) : undefined,
      actorId: row.actor_id ? String(row.actor_id) : undefined,
      role: row.role ? String(row.role) as ApiAuditEvent['role'] : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      requestTargetId: row.request_target_id ? String(row.request_target_id) : undefined,
      action: String(row.action),
      result: row.result as ApiAuditEvent['result'],
      statusCode: row.status_code === null || row.status_code === undefined ? undefined : Number(row.status_code),
      error: row.error ? String(row.error) : undefined,
      metadata: row.metadata_json ? parseJson(row.metadata_json) : undefined,
    }));
  }
}

export async function createSqlitePersistence(filePath: string): Promise<AgentPersistence> {
  const context = new SqlitePersistenceContext(filePath);

  return {
    sessions: new SqliteSessionRepository(context),
    confirmations: new SqliteConfirmationRepository(context),
    approvalGrants: new SqliteApprovalGrantRepository(context),
    toolExecutions: new SqliteToolExecutionRepository(context),
    auditEvents: new SqliteAuditEventRepository(context),
  };
}
