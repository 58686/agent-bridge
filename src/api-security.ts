import fs from 'node:fs';
import path from 'node:path';
import { redactSensitiveValue } from './redaction.js';

export type ApiRole = 'viewer' | 'operator' | 'approver' | 'admin';

export interface AuthenticatedActor {
  id: string;
  role: ApiRole;
  source: 'header';
}

export interface ApiAuthToken {
  token: string;
  actorId: string;
  role: ApiRole;
}

export interface ApiAuthOptions {
  enabled?: boolean;
  tokens?: ApiAuthToken[];
}

export interface ApiAuditEvent {
  timestamp: string;
  requestId?: string;
  method?: string;
  path?: string;
  actorId?: string;
  role?: ApiRole;
  sessionId?: string;
  requestTargetId?: string;
  action: string;
  result: 'success' | 'failure';
  statusCode?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ApiAuditQuery {
  sessionId?: string;
  actorId?: string;
  action?: string;
  result?: ApiAuditEvent['result'];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ApiAuditQueryResult {
  events: ApiAuditEvent[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ApiAuditSink {
  emit(event: ApiAuditEvent): void;
}

export interface QueryableApiAuditSink extends ApiAuditSink {
  query(query?: ApiAuditQuery): ApiAuditQueryResult;
}

export class ConsoleApiAuditSink implements ApiAuditSink {
  emit(event: ApiAuditEvent): void {
    console.info(JSON.stringify({ type: 'api_audit', ...redactSensitiveValue(event) }));
  }
}

export class FileApiAuditSink implements QueryableApiAuditSink {
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  emit(event: ApiAuditEvent): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify({ type: 'api_audit', ...redactSensitiveValue(event) })}\n`, 'utf8');
  }

  query(query: ApiAuditQuery = {}): ApiAuditQueryResult {
    if (!fs.existsSync(this.filePath)) {
      return buildAuditQueryResult([], query);
    }

    const events = fs.readFileSync(this.filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseAuditEventLine(line))
      .filter((event): event is ApiAuditEvent => Boolean(event));

    return buildAuditQueryResult(events, query);
  }
}

export class InMemoryApiAuditSink implements QueryableApiAuditSink {
  private readonly events: ApiAuditEvent[] = [];

  constructor(private readonly maxEvents = 2000) {}

  emit(event: ApiAuditEvent): void {
    this.events.push(redactSensitiveValue(event));
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  query(query: ApiAuditQuery = {}): ApiAuditQueryResult {
    return buildAuditQueryResult(this.events, query);
  }
}

export class CompositeApiAuditSink implements QueryableApiAuditSink {
  constructor(private readonly sinks: ApiAuditSink[]) {}

  emit(event: ApiAuditEvent): void {
    for (const sink of this.sinks) {
      sink.emit(event);
    }
  }

  query(query: ApiAuditQuery = {}): ApiAuditQueryResult {
    const limit = normalizePositiveInteger(query.limit, 50, 200);
    const offset = normalizeNonNegativeInteger(query.offset, 0);

    const queryableSinks = this.sinks.filter(isQueryableApiAuditSink);
    const allEvents = queryableSinks
      .flatMap((sink) => sink.query({ ...query, limit: 100000, offset: 0 }).events)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

    const deduplicatedEvents: ApiAuditEvent[] = [];
    const seen = new Set<string>();
    for (const event of allEvents) {
      const key = JSON.stringify(event);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduplicatedEvents.push(event);
    }

    const events = deduplicatedEvents.slice(offset, offset + limit);
    return {
      events,
      total: deduplicatedEvents.length,
      limit,
      offset,
      hasMore: offset + events.length < deduplicatedEvents.length,
    };
  }
}

export class ApiHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

const rolePriority: Record<ApiRole, number> = {
  viewer: 1,
  operator: 2,
  approver: 3,
  admin: 4,
};

export function hasRequiredRole(actor: AuthenticatedActor, requiredRole: ApiRole): boolean {
  return rolePriority[actor.role] >= rolePriority[requiredRole];
}

export function isQueryableApiAuditSink(sink: ApiAuditSink): sink is QueryableApiAuditSink {
  return typeof (sink as QueryableApiAuditSink).query === 'function';
}

export function filterAuditEvents(events: ApiAuditEvent[], query: ApiAuditQuery = {}): ApiAuditEvent[] {
  const fromTimestamp = query.from ? Date.parse(query.from) : undefined;
  const toTimestamp = query.to ? Date.parse(query.to) : undefined;

  return events
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
}

function buildAuditQueryResult(events: ApiAuditEvent[], query: ApiAuditQuery = {}): ApiAuditQueryResult {
  const limit = normalizePositiveInteger(query.limit, 50, 200);
  const offset = normalizeNonNegativeInteger(query.offset, 0);
  const filtered = filterAuditEvents(events, query);
  const pagedEvents = filtered.slice(offset, offset + limit);

  return {
    events: pagedEvents,
    total: filtered.length,
    limit,
    offset,
    hasMore: offset + pagedEvents.length < filtered.length,
  };
}

function parseAuditEventLine(line: string): ApiAuditEvent | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type !== 'api_audit') {
      return null;
    }
    if (typeof parsed.timestamp !== 'string' || typeof parsed.action !== 'string') {
      return null;
    }
    if (parsed.result !== 'success' && parsed.result !== 'failure') {
      return null;
    }

    return {
      timestamp: parsed.timestamp,
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
      method: typeof parsed.method === 'string' ? parsed.method : undefined,
      path: typeof parsed.path === 'string' ? parsed.path : undefined,
      actorId: typeof parsed.actorId === 'string' ? parsed.actorId : undefined,
      role: isApiRole(parsed.role) ? parsed.role : undefined,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
      requestTargetId: typeof parsed.requestTargetId === 'string' ? parsed.requestTargetId : undefined,
      action: parsed.action,
      result: parsed.result,
      statusCode: typeof parsed.statusCode === 'number' ? parsed.statusCode : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      metadata: isRecord(parsed.metadata) ? parsed.metadata : undefined,
    };
  } catch {
    return null;
  }
}

function isApiRole(value: unknown): value is ApiRole {
  return value === 'viewer' || value === 'operator' || value === 'approver' || value === 'admin';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function authenticateRequest(
  authorizationHeader: string | undefined,
  auth: ApiAuthOptions | undefined,
): AuthenticatedActor | undefined {
  if (!auth?.enabled) {
    return undefined;
  }

  const header = authorizationHeader?.trim();
  if (!header) {
    throw new ApiHttpError(401, 'Missing authorization header', 'AUTH_REQUIRED');
  }

  const bearerPrefix = 'Bearer ';
  if (!header.startsWith(bearerPrefix)) {
    throw new ApiHttpError(401, 'Unsupported authorization scheme', 'AUTH_SCHEME_INVALID');
  }

  const tokenValue = header.slice(bearerPrefix.length).trim();
  if (!tokenValue) {
    throw new ApiHttpError(401, 'Empty bearer token', 'AUTH_TOKEN_EMPTY');
  }

  const matched = auth.tokens?.find((entry) => entry.token === tokenValue);
  if (!matched) {
    throw new ApiHttpError(403, 'Invalid API token', 'AUTH_TOKEN_INVALID');
  }

  return {
    id: matched.actorId,
    role: matched.role,
    source: 'header',
  };
}

export function requireRole(
  actor: AuthenticatedActor | undefined,
  auth: ApiAuthOptions | undefined,
  requiredRole: ApiRole,
): void {
  if (!auth?.enabled) {
    return;
  }

  if (!actor) {
    throw new ApiHttpError(401, 'Authentication required', 'AUTH_REQUIRED');
  }

  if (!hasRequiredRole(actor, requiredRole)) {
    throw new ApiHttpError(403, `Role ${requiredRole} required`, 'AUTH_FORBIDDEN');
  }
}
