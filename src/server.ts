import 'dotenv/config';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ProjectLoader } from './config/project-loader.js';
import { createDefaultConnectorRegistry } from './connectors/default-registry.js';
import { RuntimeAgent } from './core/runtime-agent.js';
import { AgentEvent, AgentRunResult, Message, ProjectConfig } from './core/types.js';
import { AgentPersistence } from './persistence/interfaces.js';
import { PersistenceQueryService } from './persistence/query.js';
import {
  ApiAuditEvent,
  ApiAuditSink,
  ApiAuthOptions,
  ApiHttpError,
  AuthenticatedActor,
  ConsoleApiAuditSink,
  InMemoryApiAuditSink,
  CompositeApiAuditSink,
  isQueryableApiAuditSink,
  authenticateRequest,
  requireRole,
  hasRequiredRole,
} from './api-security.js';
import { AppError, NotFoundError } from './errors.js';
import { getMinimalUiHtml } from './ui.js';
import { configureRedaction, redactSensitiveValue } from './redaction.js';

export interface ProjectTemplateResponse {
  scenario: string;
  name: string;
  description: string;
  fileName: string;
  contentType: 'application/x-yaml';
  yaml: string;
  environment: string[];
}

export interface ProjectTemplateWizardRequest {
  scenario?: string;
  projectId?: string;
  projectName?: string;
  description?: string;
  connectorId?: string;
  connectorName?: string;
  apiBaseUrlEnv?: string;
  apiTokenEnv?: string;
  userIdParam?: string;
  standardId?: string;
  readTool?: {
    name?: string;
    description?: string;
    method?: string;
    path?: string;
    queryParams?: string[];
  };
  writeTool?: {
    name?: string;
    description?: string;
    method?: string;
    path?: string;
    bodyParams?: string[];
    requireConfirmation?: boolean;
  };
}

export interface ApiProjectSummary {
  id: string;
  name: string;
  description?: string;
  model: {
    provider: ProjectConfig['model']['provider'];
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  connectors: Array<{
    id: string;
    type: string;
    name: string;
    enabledTools?: string[];
    disabledTools?: string[];
    toolCount: number;
    tools: Array<{
      name: string;
      method?: string;
      path?: string;
      timeoutMs?: number;
    }>;
  }>;
  analysis?: {
    standardId?: string;
    levelsCount: number;
    fallbackLevel?: string;
    fallbackRiskLevel?: string;
  };
  security?: {
    redaction?: {
      enabled: boolean;
      extraSensitiveKeys: string[];
      replacement: string;
    };
  };
  checks: Array<{
    id: string;
    label: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
  }>;
  toolPolicy?: ProjectConfig['toolPolicy'];
  memory?: ProjectConfig['memory'];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ApiServerOptions {
  projectPath?: string;
  project?: ProjectConfig;
  debug?: boolean;
  persistence?: AgentPersistence;
  auth?: ApiAuthOptions;
  auditSink?: ApiAuditSink;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
  };
}

interface ResponseAuditContext {
  requestId: string;
  actor?: AuthenticatedActor;
  action: string;
  sessionId?: string;
  requestTargetId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionRunResponse {
  sessionId: string;
  status: 'completed' | 'waiting_confirmation';
  result: AgentRunResult;
}

interface SessionExecutionContext {
  agent: RuntimeAgent;
  projectPath: string;
  actor?: AuthenticatedActor;
}

export class AgentSessionManager {
  private readonly sessions = new Map<string, SessionExecutionContext>();

  constructor(
    private readonly projectPath: string,
    private readonly debug: boolean,
    private readonly persistence?: AgentPersistence,
    private readonly project?: ProjectConfig,
    private readonly auditSink?: ApiAuditSink,
  ) {}

  async createSession(actor?: AuthenticatedActor): Promise<{ sessionId: string }> {
    const agent = await this.createAgent(undefined, actor);
    this.sessions.set(agent.sessionId, { agent, projectPath: this.projectPath, actor });
    return { sessionId: agent.sessionId };
  }

  async runSession(sessionId: string, input: string, actor?: AuthenticatedActor): Promise<SessionRunResponse> {
    const context = await this.getOrCreateSession(sessionId, actor);
    if (actor) {
      context.actor = actor;
    }

    return this.toSessionRunResponse(sessionId, await context.agent.run(input));
  }

  async resumeSession(sessionId: string, actor?: AuthenticatedActor): Promise<SessionRunResponse> {
    const context = await this.getOrCreateSession(sessionId, actor);
    if (actor) {
      context.actor = actor;
    }
    return this.toSessionRunResponse(sessionId, await context.agent.resume());
  }

  async clearSessionHistory(sessionId: string, actor?: AuthenticatedActor): Promise<{ sessionId: string; cleared: true; messages: Message[] }> {
    const context = await this.getOrCreateSession(sessionId, actor);
    if (actor) {
      context.actor = actor;
    }
    await context.agent.clearHistory();
    return {
      sessionId: context.agent.sessionId,
      cleared: true,
      messages: context.agent.messages,
    };
  }

  async approveConfirmation(
    requestId: string,
    reason?: string,
    actor?: AuthenticatedActor,
  ): Promise<SessionRunResponse> {
    const context = await this.findSessionByRequestId(requestId, actor);
    if (actor) {
      context.actor = actor;
    }
    const request = context.agent.getPendingConfirmations().find((entry) => entry.id === requestId);
    if (!request) {
      throw new NotFoundError(`Confirmation request not found: ${requestId}`, 'CONFIRMATION_NOT_FOUND', { requestId });
    }

    await context.agent.approveConfirmation(requestId, reason, actor?.id);
    return this.toSessionRunResponse(context.agent.sessionId, await context.agent.resume());
  }

  async rejectConfirmation(
    requestId: string,
    reason?: string,
    actor?: AuthenticatedActor,
  ): Promise<{ sessionId: string; rejected: true }> {
    const context = await this.findSessionByRequestId(requestId, actor);
    if (actor) {
      context.actor = actor;
    }
    await context.agent.rejectConfirmation(requestId, reason, actor?.id);
    return {
      sessionId: context.agent.sessionId,
      rejected: true,
    };
  }

  async getSessionOwner(sessionId: string): Promise<string | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing?.actor?.id) {
      return existing.actor.id;
    }

    const persisted = await this.persistence?.sessions?.getById(sessionId);
    return persisted?.actorId;
  }

  async getSessionIdByRequestId(requestId: string): Promise<string | undefined> {
    for (const context of this.sessions.values()) {
      if (context.agent.getPendingConfirmations().some((entry) => entry.id === requestId)) {
        return context.agent.sessionId;
      }
    }

    if (this.persistence?.confirmations) {
      const pending = await this.persistence.confirmations.listPending();
      const matched = pending.find((entry) => entry.id === requestId);
      return matched?.sessionId;
    }

    return undefined;
  }

  async destroy(): Promise<void> {
    for (const context of this.sessions.values()) {
      await context.agent.destroy();
    }
    this.sessions.clear();
  }

  private toSessionRunResponse(sessionId: string, result: AgentRunResult): SessionRunResponse {
    return {
      sessionId,
      status: result.pendingConfirmation ? 'waiting_confirmation' : 'completed',
      result,
    };
  }

  private async getOrCreateSession(sessionId: string, actor?: AuthenticatedActor): Promise<SessionExecutionContext> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.ensureSessionAccess(existing.actor?.id, actor, sessionId);
      if (actor) {
        existing.actor = actor;
      }
      return existing;
    }

    const ownerId = await this.persistence?.sessions?.getById(sessionId).then((session) => session?.actorId);
    this.ensureSessionAccess(ownerId, actor, sessionId);

    const agent = await this.createAgent(sessionId, actor);
    const context: SessionExecutionContext = { agent, projectPath: this.projectPath, actor };
    this.sessions.set(sessionId, context);
    return context;
  }

  private async findSessionByRequestId(requestId: string, actor?: AuthenticatedActor): Promise<SessionExecutionContext> {
    for (const context of this.sessions.values()) {
      if (context.agent.getPendingConfirmations().some((entry) => entry.id === requestId)) {
        this.ensureSessionAccess(context.actor?.id, actor, context.agent.sessionId, requestId);
        return context;
      }
    }

    if (this.persistence?.confirmations) {
      const pending = await this.persistence.confirmations.listPending();
      const matched = pending.find((entry) => entry.id === requestId);
      if (matched) {
        const ownerId = await this.persistence?.sessions?.getById(matched.sessionId).then((session) => session?.actorId);
        this.ensureSessionAccess(ownerId, actor, matched.sessionId, requestId);
        return this.getOrCreateSession(matched.sessionId, actor);
      }
    }

    throw new NotFoundError(`Confirmation request not found: ${requestId}`, 'CONFIRMATION_NOT_FOUND', { requestId });
  }

  private ensureSessionAccess(
    ownerId: string | undefined,
    actor: AuthenticatedActor | undefined,
    sessionId: string,
    requestId?: string,
  ): void {
    if (!ownerId || !actor || actor.id === ownerId || hasRequiredRole(actor, 'admin')) {
      return;
    }

    throw new ApiHttpError(403, 'Forbidden session access', 'FORBIDDEN');
  }

  private async createAgent(sessionId?: string, actor?: AuthenticatedActor): Promise<RuntimeAgent> {
    const project = this.project ?? ProjectLoader.load(this.projectPath);
    const agent = new RuntimeAgent(
      {
        project,
        debug: this.debug,
        sessionId,
        actorId: actor?.id,
        persistence: this.persistence,
      },
      createDefaultConnectorRegistry(),
    );
    this.attachRuntimeAudit(agent);
    await agent.initialize();
    return agent;
  }

  private attachRuntimeAudit(agent: RuntimeAgent): void {
    if (!this.auditSink) {
      return;
    }

    agent.on((event) => {
      const actor = this.sessions.get(agent.sessionId)?.actor;
      const auditEvent = this.mapAgentEventToAudit(agent.sessionId, actor, event);
      if (auditEvent) {
        this.auditSink!.emit(auditEvent);
      }
    });
  }

  private mapAgentEventToAudit(
    sessionId: string,
    actor: AuthenticatedActor | undefined,
    event: AgentEvent,
  ): ApiAuditEvent | null {
    const timestamp = event.timestamp.toISOString();

    if (event.type === 'tool_call') {
      const data = event.data as { name?: string; args?: Record<string, unknown>; callId?: string };
      return {
        timestamp,
        actorId: actor?.id,
        role: actor?.role,
        sessionId,
        requestTargetId: data.callId,
        action: 'tool_execution_started',
        result: 'success',
        metadata: {
          tool: data.name,
          args: data.args,
        },
      };
    }

    if (event.type === 'tool_result') {
      const data = event.data as {
        name?: string;
        args?: Record<string, unknown>;
        result?: { success?: boolean; error?: string; metadata?: Record<string, unknown> };
        duration?: number;
      };
      const success = Boolean(data.result?.success);
      const confirmationRequired = Boolean(data.result?.metadata?.confirmationRequired);
      return {
        timestamp,
        actorId: actor?.id,
        role: actor?.role,
        sessionId,
        action: success
          ? 'tool_execution_finished'
          : confirmationRequired
            ? 'tool_execution_waiting_confirmation'
            : 'tool_execution_failed',
        result: success ? 'success' : confirmationRequired ? 'success' : 'failure',
        error: confirmationRequired ? undefined : data.result?.error,
        metadata: {
          tool: data.name,
          args: data.args,
          duration: data.duration,
          confirmationRequired,
          toolResultMetadata: data.result?.metadata,
        },
      };
    }

    if (event.type === 'confirmation_requested') {
      const data = event.data as {
        id?: string;
        tool?: string;
        riskLevel?: string;
        args?: Record<string, unknown>;
        reason?: string;
        callId?: string;
      };
      return {
        timestamp,
        actorId: actor?.id,
        role: actor?.role,
        sessionId,
        requestTargetId: data.id,
        action: 'confirmation_requested',
        result: 'success',
        metadata: {
          tool: data.tool,
          riskLevel: data.riskLevel,
          args: data.args,
          reason: data.reason,
          callId: data.callId,
        },
      };
    }

    if (event.type === 'confirmation_resolved') {
      const data = event.data as {
        request?: { id?: string; tool?: string; callId?: string };
        resolution?: { approved?: boolean; reason?: string; decidedAt?: string };
      };
      return {
        timestamp,
        actorId: actor?.id,
        role: actor?.role,
        sessionId,
        requestTargetId: data.request?.id,
        action: data.resolution?.approved ? 'confirmation_approved' : 'confirmation_rejected',
        result: 'success',
        metadata: {
          tool: data.request?.tool,
          callId: data.request?.callId,
          reason: data.resolution?.reason,
          decidedAt: data.resolution?.decidedAt,
        },
      };
    }

    if (event.type === 'error') {
      const data = event.data as { error?: Error | string };
      const errorMessage = data.error instanceof Error ? data.error.message : String(data.error);
      return {
        timestamp,
        actorId: actor?.id,
        role: actor?.role,
        sessionId,
        action: 'agent_run_failed',
        result: 'failure',
        error: errorMessage,
      };
    }

    return null;
  }
}

function getDefaultProjectPath(): string {
  return path.resolve(__dirname, '../projects/example/project.yaml');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, requestId?: string): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (requestId) {
    response.setHeader('x-request-id', requestId);
  }
  response.end(JSON.stringify(redactSensitiveValue(body)));
}

function sendJsonRaw(response: ServerResponse, statusCode: number, body: unknown, requestId?: string): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (requestId) {
    response.setHeader('x-request-id', requestId);
  }
  response.end(JSON.stringify(body));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  requestId?: string,
  fileName?: string,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', `${contentType}; charset=utf-8`);
  if (requestId) {
    response.setHeader('x-request-id', requestId);
  }
  if (fileName) {
    response.setHeader('content-disposition', `attachment; filename="${fileName}"`);
  }
  response.end(body);
}

function parseExportFormat(value: string | null): 'jsonl' | 'csv' {
  if (!value || value === 'jsonl') {
    return 'jsonl';
  }

  if (value === 'csv') {
    return value;
  }

  throw new ApiHttpError(400, `Invalid export format: ${value}`, 'INVALID_QUERY_PARAM');
}

function buildAuditEventsJsonl(events: ApiAuditEvent[]): string {
  return events.map((event) => JSON.stringify(redactSensitiveValue(event))).join('\n');
}

function buildAuditEventsCsv(events: ApiAuditEvent[]): string {
  const headers = [
    'timestamp',
    'requestId',
    'method',
    'path',
    'actorId',
    'role',
    'sessionId',
    'requestTargetId',
    'action',
    'result',
    'statusCode',
    'error',
    'metadata',
  ];

  const rows = events.map((event) => [
    event.timestamp,
    event.requestId,
    event.method,
    event.path,
    event.actorId,
    event.role,
    event.sessionId,
    event.requestTargetId,
    event.action,
    event.result,
    typeof event.statusCode === 'number' ? String(event.statusCode) : '',
    event.error,
    event.metadata ? JSON.stringify(redactSensitiveValue(event.metadata)) : '',
  ]);

  return [headers, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function buildMetricsJsonl(metrics: unknown): string {
  return JSON.stringify(metrics);
}

function buildSessionsJsonl(records: unknown[]): string {
  return records.map((entry) => JSON.stringify(redactSensitiveValue(entry))).join('\n');
}

function buildSessionsCsv(records: Array<Record<string, unknown>>): string {
  const headers = [
    'id',
    'projectId',
    'status',
    'createdAt',
    'updatedAt',
    'lastInput',
    'lastError',
    'messageCount',
    'pendingConfirmationCount',
    'activeGrantCount',
    'toolExecutionCount',
    'failedToolExecutionCount',
    'lastToolExecutionStatus',
    'lastToolName',
    'lastToolStartedAt',
    'lastConfirmationTool',
    'lastConfirmationRiskLevel',
    'lastConfirmationCreatedAt',
    'lastDecision',
    'lastDecisionAt',
    'needsAttention',
    'approvalState',
    'executionState',
    'queueMatches',
  ];

  const rows = records.map((entry) => [
    entry.id,
    entry.projectId,
    entry.status,
    entry.createdAt,
    entry.updatedAt,
    entry.lastInput,
    entry.lastError,
    entry.messageCount,
    entry.pendingConfirmationCount,
    entry.activeGrantCount,
    entry.toolExecutionCount,
    entry.failedToolExecutionCount,
    entry.lastToolExecutionStatus,
    entry.lastToolName,
    entry.lastToolStartedAt,
    entry.lastConfirmationTool,
    entry.lastConfirmationRiskLevel,
    entry.lastConfirmationCreatedAt,
    entry.lastDecision,
    entry.lastDecisionAt,
    (entry.derivedState as { needsAttention?: boolean } | undefined)?.needsAttention,
    (entry.derivedState as { approvalState?: string } | undefined)?.approvalState,
    (entry.derivedState as { executionState?: string } | undefined)?.executionState,
    Array.isArray(entry.queueMatches) ? entry.queueMatches.join('|') : '',
  ]);

  return [headers, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function buildConfirmationRequestsJsonl(records: unknown[]): string {
  return records.map((entry) => JSON.stringify(redactSensitiveValue(entry))).join('\n');
}

function buildConfirmationRequestsCsv(records: Array<Record<string, unknown>>): string {
  const headers = [
    'id',
    'sessionId',
    'projectId',
    'tool',
    'riskLevel',
    'status',
    'callId',
    'reason',
    'createdAt',
    'updatedAt',
    'expiresAt',
    'args',
  ];

  const rows = records.map((entry) => [
    entry.id,
    entry.sessionId,
    entry.projectId,
    entry.tool,
    entry.riskLevel,
    entry.status,
    entry.callId,
    entry.reason,
    entry.createdAt,
    entry.updatedAt,
    entry.expiresAt,
    entry.args ? JSON.stringify(redactSensitiveValue(entry.args)) : '',
  ]);

  return [headers, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function buildConfirmationDecisionsJsonl(records: unknown[]): string {
  return records.map((entry) => JSON.stringify(redactSensitiveValue(entry))).join('\n');
}

function buildConfirmationDecisionsCsv(records: Array<Record<string, unknown>>): string {
  const headers = [
    'id',
    'requestId',
    'sessionId',
    'decision',
    'actor',
    'reason',
    'createdAt',
  ];

  const rows = records.map((entry) => [
    entry.id,
    entry.requestId,
    entry.sessionId,
    entry.decision,
    entry.actor,
    entry.reason,
    entry.createdAt,
  ]);

  return [headers, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function buildToolExecutionsJsonl(toolExecutions: unknown[]): string {
  return toolExecutions.map((entry) => JSON.stringify(redactSensitiveValue(entry))).join('\n');
}

function buildToolExecutionsCsv(toolExecutions: Array<Record<string, unknown>>): string {
  const headers = [
    'id',
    'sessionId',
    'tool',
    'callId',
    'status',
    'startedAt',
    'finishedAt',
    'durationMs',
    'error',
    'args',
    'result',
  ];

  const rows = toolExecutions.map((entry) => [
    entry.id,
    entry.sessionId,
    entry.tool,
    entry.callId,
    entry.status,
    entry.startedAt,
    entry.finishedAt,
    typeof entry.durationMs === 'number' ? String(entry.durationMs) : '',
    entry.error,
    entry.args ? JSON.stringify(redactSensitiveValue(entry.args)) : '',
    entry.result ? JSON.stringify(redactSensitiveValue(entry.result)) : '',
  ]);

  return [headers, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function buildMetricsCsv(metrics: Record<string, unknown>): string {
  const flattened = flattenRecord(metrics);
  const headers = Object.keys(flattened);
  const values = headers.map((header) => formatFlattenedValue(flattened[header]));
  return [headers.map(toCsvCell).join(','), values.map(toCsvCell).join(',')].join('\n');
}

function flattenRecord(value: unknown, prefix = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? { [prefix]: value } : {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
      Object.assign(result, flattenRecord(nestedValue, nextPrefix));
    } else {
      result[nextPrefix] = nestedValue;
    }
  }
  return result;
}

function formatFlattenedValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function toCsvCell(value: unknown): string {
  const normalized = value === undefined || value === null ? '' : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}


function emitAudit(
  auditSink: ApiAuditSink,
  request: IncomingMessage,
  context: ResponseAuditContext,
  statusCode: number,
  result: 'success' | 'failure',
  error?: string,
  auditRepository?: AgentPersistence['auditEvents'],
): void {
  const pathName = request.url ? new URL(request.url, 'http://localhost').pathname : '';
  const event: ApiAuditEvent = {
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    method: request.method ?? 'UNKNOWN',
    path: pathName,
    actorId: context.actor?.id,
    role: context.actor?.role,
    sessionId: context.sessionId,
    requestTargetId: context.requestTargetId,
    action: context.action,
    result,
    statusCode,
    error,
    metadata: context.metadata,
  };
  const redactedEvent = redactSensitiveValue(event);
  auditSink.emit(redactedEvent);
  if (auditRepository) {
    void auditRepository.create(redactedEvent);
  }
}

function sendError(
  response: ServerResponse,
  requestId: string,
  statusCode: number,
  code: string,
  message: string,
): void {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      requestId,
      retryable: isRetryableError(statusCode, code),
    },
  };
  sendJson(response, statusCode, body, requestId);
}

function isRetryableError(statusCode: number, code: string): boolean {
  if (code === 'AGENT_ALREADY_RUNNING') {
    return true;
  }

  if (code === 'OPENAI_REQUEST_FAILED') {
    return true;
  }

  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(input: Record<string, unknown>, key: string, defaultValue: string): string {
  const value = input[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value !== 'string') {
    throw new ApiHttpError(400, `Project template field must be a string: ${key}`, 'PROJECT_TEMPLATE_INVALID');
  }
  return value.trim() || defaultValue;
}

function optionalStringArray(input: Record<string, unknown>, key: string, defaultValue: string[]): string[] {
  const value = input[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ApiHttpError(400, `Project template field must be a string array: ${key}`, 'PROJECT_TEMPLATE_INVALID');
  }
  return value.map((item) => item.trim());
}

function optionalBoolean(input: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  const value = input[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw new ApiHttpError(400, `Project template field must be a boolean: ${key}`, 'PROJECT_TEMPLATE_INVALID');
  }
  return value;
}

function validateTemplateIdentifier(value: string, fieldName: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value)) {
    throw new ApiHttpError(400, `Invalid project template identifier: ${fieldName}`, 'PROJECT_TEMPLATE_INVALID');
  }
  return value;
}

function validateTemplateEnvName(value: string, fieldName: string): string {
  if (!/^[A-Z_][A-Z0-9_]{0,79}$/.test(value)) {
    throw new ApiHttpError(400, `Invalid project template environment variable: ${fieldName}`, 'PROJECT_TEMPLATE_INVALID');
  }
  return value;
}

function validateTemplatePath(value: string, fieldName: string): string {
  if (!value.startsWith('/') || value.includes('\n') || value.includes('\r')) {
    throw new ApiHttpError(400, `Invalid project template API path: ${fieldName}`, 'PROJECT_TEMPLATE_INVALID');
  }
  return value;
}

function validateTemplateMethod(value: string, fieldName: string): string {
  const normalized = value.trim().toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalized)) {
    throw new ApiHttpError(400, `Invalid project template HTTP method: ${fieldName}`, 'PROJECT_TEMPLATE_INVALID');
  }
  return normalized;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function yamlInlineList(values: string[]): string {
  return '[' + values.map((value) => yamlQuote(value)).join(', ') + ']';
}

function envPlaceholder(name: string): string {
  return '${' + name + '}';
}

function readTemplateTool(input: unknown, defaults: {
  name: string;
  description: string;
  method: string;
  path: string;
  queryParams?: string[];
  bodyParams?: string[];
  requireConfirmation?: boolean;
}) {
  const source = isPlainObject(input) ? input : {};
  const name = validateTemplateIdentifier(optionalString(source, 'name', defaults.name), 'tool.name');
  const description = optionalString(source, 'description', defaults.description);
  const method = validateTemplateMethod(optionalString(source, 'method', defaults.method), 'tool.method');
  const path = validateTemplatePath(optionalString(source, 'path', defaults.path), 'tool.path');
  const queryParams = optionalStringArray(source, 'queryParams', defaults.queryParams ?? []);
  const bodyParams = optionalStringArray(source, 'bodyParams', defaults.bodyParams ?? []);
  const requireConfirmation = optionalBoolean(source, 'requireConfirmation', defaults.requireConfirmation ?? false);
  queryParams.forEach((param) => validateTemplateIdentifier(param, 'tool.queryParams'));
  bodyParams.forEach((param) => validateTemplateIdentifier(param, 'tool.bodyParams'));
  return { name, description, method, path, queryParams, bodyParams, requireConfirmation };
}

function buildProjectTemplateFromWizard(input: unknown): ProjectTemplateResponse {
  if (!isPlainObject(input)) {
    throw new ApiHttpError(400, 'Project template wizard body must be an object', 'PROJECT_TEMPLATE_INVALID');
  }

  const scenario = optionalString(input, 'scenario', 'training-analysis').toLowerCase();
  if (scenario !== 'training-analysis' && scenario !== 'default') {
    throw new ApiHttpError(400, `Unsupported project template scenario: ${scenario}`, 'PROJECT_TEMPLATE_SCENARIO_UNSUPPORTED');
  }

  const projectId = validateTemplateIdentifier(optionalString(input, 'projectId', 'training-analysis-agent'), 'projectId');
  const projectName = optionalString(input, 'projectName', 'Training Analysis Agent');
  const description = optionalString(input, 'description', 'Fetch data from a company API, analyze it, and save approved results.');
  const connectorId = validateTemplateIdentifier(optionalString(input, 'connectorId', 'company-api'), 'connectorId');
  const connectorName = optionalString(input, 'connectorName', 'Company API');
  const apiBaseUrlEnv = validateTemplateEnvName(optionalString(input, 'apiBaseUrlEnv', 'COMPANY_API_BASE_URL'), 'apiBaseUrlEnv');
  const apiTokenEnv = validateTemplateEnvName(optionalString(input, 'apiTokenEnv', 'COMPANY_API_TOKEN'), 'apiTokenEnv');
  const userIdParam = validateTemplateIdentifier(optionalString(input, 'userIdParam', 'userId'), 'userIdParam');
  const standardId = optionalString(input, 'standardId', 'company-standard-2026');

  const readTool = readTemplateTool(input.readTool, {
    name: 'get_training_stats',
    description: 'Fetch source business data for one user from the company system.',
    method: 'GET',
    path: '/training/stats',
    queryParams: [userIdParam],
  });
  const writeTool = readTemplateTool(input.writeTool, {
    name: 'save_training_analysis',
    description: 'Save the AI-generated structured analysis result back to the company system.',
    method: 'POST',
    path: '/training/analysis',
    bodyParams: [userIdParam, 'standardId', 'scoreLevel', 'riskLevel', 'summary', 'recommendations', 'evidence'],
    requireConfirmation: true,
  });

  const confirmationRules = writeTool.requireConfirmation ? `
  confirmationRules:
    - tool: ${writeTool.name}
      requireConfirmation: true` : '';

  return {
    scenario: 'training-analysis',
    name: projectName,
    description,
    fileName: `${projectId}-project.yaml`,
    contentType: 'application/x-yaml',
    environment: ['OPENAI_API_KEY', apiBaseUrlEnv, apiTokenEnv],
    yaml: `id: ${projectId}
name: ${yamlQuote(projectName)}
description: ${yamlQuote(description)}

model:
  provider: openai
  model: gpt-4o-mini
  envApiKey: OPENAI_API_KEY
  baseUrl: https://api.openai.com/v1
  timeoutMs: 60000
  temperature: 0.2
  maxTokens: 1000

connectors:
  - id: ${connectorId}
    type: api
    name: ${yamlQuote(connectorName)}
    config:
      baseUrl: ${envPlaceholder(apiBaseUrlEnv)}
      timeoutMs: 30000
      auth:
        type: bearer
        token: ${envPlaceholder(apiTokenEnv)}
      tools:
        - name: ${readTool.name}
          description: ${yamlQuote(readTool.description)}
          method: ${readTool.method}
          path: ${readTool.path}
          queryParams: ${yamlInlineList(readTool.queryParams)}
          parameters:
            ${userIdParam}:
              type: string
              description: User or entity id to analyze.
              required: true

        - name: ${writeTool.name}
          description: ${yamlQuote(writeTool.description)}
          method: ${writeTool.method}
          path: ${writeTool.path}
          bodyParams: ${yamlInlineList(writeTool.bodyParams)}
          parameters:
            ${userIdParam}:
              type: string
              description: User or entity id to analyze.
              required: true
            standardId:
              type: string
              description: Analysis standard identifier.
              required: true
            scoreLevel:
              type: string
              description: Result level.
              enum: [excellent, qualified, needs_attention]
              required: true
            riskLevel:
              type: string
              description: Risk level.
              enum: [low, medium, high]
              required: true
            summary:
              type: string
              description: Human-readable analysis summary.
              required: true
            recommendations:
              type: array
              description: Suggested next actions.
              required: true
              items:
                type: string
            evidence:
              type: object
              description: Key metrics used by the analysis.
              required: true

analysis:
  standardId: ${yamlQuote(standardId)}
  levels:
    - level: excellent
      riskLevel: low
      when:
        completionRate:
          gte: 0.9
      recommendations:
        - Keep the current cadence and consider assigning advanced work.
  fallback:
    level: needs_attention
    riskLevel: high
    recommendations:
      - Create a remediation plan and schedule manager follow-up.

security:
  redaction:
    extraSensitiveKeys:
      - employeeIdCard
      - mobile_phone
      - nationalId
    replacement: '[REDACTED]'

systemPrompt: |
  You are an enterprise analysis assistant.
  First call ${readTool.name}, then compare the returned data against the Analysis configuration JSON.
  Save the structured result by calling ${writeTool.name}.
  Never invent source data. Use company API data as the source of truth.

toolPolicy:
  maxConsecutiveCalls: 6
  confirmationTimeoutMs: 900000${confirmationRules}

memory:
  enabled: true
  maxMessages: 20
  type: sliding
`,
  };
}

function buildProjectTemplate(scenario: string | null): ProjectTemplateResponse {
  const normalizedScenario = (scenario || 'training-analysis').trim().toLowerCase();
  if (normalizedScenario !== 'training-analysis' && normalizedScenario !== 'default') {
    throw new ApiHttpError(400, `Unsupported project template scenario: ${normalizedScenario}`, 'PROJECT_TEMPLATE_SCENARIO_UNSUPPORTED');
  }

  return {
    scenario: 'training-analysis',
    name: 'Training analysis with company API write-back',
    description: 'Fetch employee training statistics, analyze them with configured standards, and save approved results through a company API.',
    fileName: 'training-analysis-project.yaml',
    contentType: 'application/x-yaml',
    environment: ['OPENAI_API_KEY', 'TRAINING_API_BASE_URL', 'TRAINING_API_TOKEN'],
    yaml: `id: training-analysis-agent
name: Training Analysis Agent
description: Fetch training stats from a company API, analyze them, and save approved results.

model:
  provider: openai
  model: gpt-4o-mini
  envApiKey: OPENAI_API_KEY
  baseUrl: https://api.openai.com/v1
  timeoutMs: 60000
  temperature: 0.2
  maxTokens: 1000

connectors:
  - id: company-training-api
    type: api
    name: Company Training API
    config:
      baseUrl: \${TRAINING_API_BASE_URL}
      timeoutMs: 30000
      auth:
        type: bearer
        token: \${TRAINING_API_TOKEN}
      tools:
        - name: get_training_stats
          description: Get a user's training completion, exam, and overdue-course statistics.
          method: GET
          path: /training/stats
          queryParams: [userId]
          parameters:
            userId:
              type: string
              description: User id, for example USER-001.
              required: true

        - name: save_training_analysis
          description: Save the AI-generated training analysis result back to the company system.
          method: POST
          path: /training/analysis
          bodyParams: [userId, standardId, scoreLevel, riskLevel, summary, recommendations, evidence]
          parameters:
            userId:
              type: string
              description: User id, for example USER-001.
              required: true
            standardId:
              type: string
              description: Analysis standard identifier.
              required: true
            scoreLevel:
              type: string
              description: Result level.
              enum: [excellent, qualified, needs_attention]
              required: true
            riskLevel:
              type: string
              description: Risk level.
              enum: [low, medium, high]
              required: true
            summary:
              type: string
              description: Human-readable analysis summary.
              required: true
            recommendations:
              type: array
              description: Suggested next actions.
              required: true
              items:
                type: string
                description: One recommendation.
            evidence:
              type: object
              description: Key training metrics used by the analysis.
              required: true
              properties:
                completionRate:
                  type: number
                  description: Completed required courses divided by required courses.
                  required: true
                averageScore:
                  type: number
                  description: Average exam score.
                  required: true
                overdueCourses:
                  type: number
                  description: Number of overdue required courses.
                  required: true

analysis:
  standardId: annual-compliance-2026
  levels:
    - level: excellent
      riskLevel: low
      when:
        completionRate:
          gte: 0.9
        averageScore:
          gte: 85
        overdueCourses:
          eq: 0
      recommendations:
        - Keep the current learning cadence and consider assigning advanced courses.
    - level: qualified
      riskLevel: medium
      when:
        completionRate:
          gte: 0.75
        averageScore:
          gte: 70
      recommendations:
        - Follow up on overdue courses and review weak knowledge areas.
  fallback:
    level: needs_attention
    riskLevel: high
    recommendations:
      - Create a remediation plan and schedule manager follow-up.

security:
  redaction:
    extraSensitiveKeys:
      - employeeIdCard
      - mobile_phone
      - nationalId
    replacement: '[REDACTED]'

systemPrompt: |
  You are a training analytics assistant for an enterprise learning platform.
  First call get_training_stats, then compare the data against the Analysis configuration JSON.
  Save the structured result by calling save_training_analysis.
  Never invent training statistics. Use company API data as the source of truth.

toolPolicy:
  maxConsecutiveCalls: 6
  confirmationTimeoutMs: 900000
  confirmationRules:
    - tool: save_training_analysis
      requireConfirmation: true

memory:
  enabled: true
  maxMessages: 20
  type: sliding
`,
  };
}

function buildProjectSummary(project: ProjectConfig): ApiProjectSummary {
  const connectors = project.connectors.map((connector) => {
    const tools = summarizeConfiguredTools(connector.config.tools);
    return {
      id: connector.id,
      type: connector.type,
      name: connector.name,
      enabledTools: connector.enabledTools,
      disabledTools: connector.disabledTools,
      toolCount: tools.length,
      tools,
    };
  });
  const analysis = project.analysis ? {
    standardId: project.analysis.standardId,
    levelsCount: project.analysis.levels?.length ?? 0,
    fallbackLevel: project.analysis.fallback?.level,
    fallbackRiskLevel: project.analysis.fallback?.riskLevel,
  } : undefined;
  const security = project.security ? {
    redaction: project.security.redaction ? {
      enabled: true,
      extraSensitiveKeys: project.security.redaction.extraSensitiveKeys ?? [],
      replacement: project.security.redaction.replacement ?? '[REDACTED]',
    } : undefined,
  } : undefined;

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    model: {
      provider: project.model.provider,
      model: project.model.model,
      temperature: project.model.temperature,
      maxTokens: project.model.maxTokens,
    },
    connectors,
    analysis,
    security,
    checks: buildProjectChecks(project, connectors, analysis, security),
    toolPolicy: project.toolPolicy,
    memory: project.memory,
  };
}

function buildProjectChecks(
  project: ProjectConfig,
  connectors: ApiProjectSummary['connectors'],
  analysis: ApiProjectSummary['analysis'],
  security: ApiProjectSummary['security'],
): ApiProjectSummary['checks'] {
  const totalTools = connectors.reduce((sum, connector) => sum + connector.toolCount, 0);
  const writeTools = connectors.flatMap((connector) => connector.tools).filter((tool) => tool.method && tool.method !== 'GET');
  const confirmationRules = project.toolPolicy?.confirmationRules ?? [];
  const hasWriteConfirmation = project.toolPolicy?.requireConfirmation === true
    || writeTools.every((tool) => confirmationRules.some((rule) => rule.tool === tool.name && rule.requireConfirmation));
  const redactionKeys = security?.redaction?.extraSensitiveKeys ?? [];

  return [
    {
      id: 'model',
      label: 'Model configured',
      status: project.model.provider && project.model.model ? 'ok' : 'error',
      message: `${project.model.provider}:${project.model.model}`,
    },
    {
      id: 'tools',
      label: 'Company tools exposed',
      status: totalTools > 0 ? 'ok' : 'error',
      message: `${totalTools} tool(s) across ${connectors.length} connector(s)`,
    },
    {
      id: 'write-confirmation',
      label: 'Write tools require confirmation',
      status: writeTools.length === 0 || hasWriteConfirmation ? 'ok' : 'warning',
      message: writeTools.length === 0 ? 'No write tools configured' : `${writeTools.length} write tool(s) checked`,
    },
    {
      id: 'analysis',
      label: 'Analysis rules configured',
      status: analysis && analysis.levelsCount > 0 ? 'ok' : 'warning',
      message: analysis ? `${analysis.levelsCount} level rule(s), standard ${analysis.standardId ?? '-'}` : 'No project analysis rules configured',
    },
    {
      id: 'redaction',
      label: 'Sensitive field redaction',
      status: security?.redaction?.enabled ? 'ok' : 'warning',
      message: security?.redaction?.enabled ? `${redactionKeys.length} extra key(s), replacement ${security.redaction.replacement}` : 'Built-in secret redaction only',
    },
    {
      id: 'memory',
      label: 'Session memory',
      status: project.memory?.enabled === false ? 'warning' : 'ok',
      message: project.memory?.enabled === false ? 'Memory disabled' : `${project.memory?.type ?? 'sliding'} memory, max ${project.memory?.maxMessages ?? 'default'} messages`,
    },
  ];
}

function summarizeConfiguredTools(input: unknown): ApiProjectSummary['connectors'][number]['tools'] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((tool): tool is Record<string, unknown> => tool !== null && typeof tool === 'object')
    .map((tool) => ({
      name: String(tool.name ?? ''),
      method: typeof tool.method === 'string' ? tool.method : undefined,
      path: typeof tool.path === 'string' ? tool.path : undefined,
      timeoutMs: typeof tool.timeoutMs === 'number' ? tool.timeoutMs : undefined,
    }))
    .filter((tool) => tool.name.trim() !== '');
}

function parsePositiveIntegerParam(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ApiHttpError(400, `Invalid positive integer: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return Math.floor(parsed);
}

function parseNonNegativeIntegerParam(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiHttpError(400, `Invalid non-negative integer: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return Math.floor(parsed);
}

function parseAuditResultParam(value: string | null): 'success' | 'failure' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'success' && value !== 'failure') {
    throw new ApiHttpError(400, `Invalid result filter: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseSessionStatusParam(value: string | null): 'idle' | 'running' | 'waiting_confirmation' | 'completed' | 'failed' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'idle' && value !== 'running' && value !== 'waiting_confirmation' && value !== 'completed' && value !== 'failed') {
    throw new ApiHttpError(400, `Invalid session status filter: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseBooleanQueryParam(value: string | null, parameterName: string): boolean | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new ApiHttpError(400, `Invalid boolean for ${parameterName}: ${value}`, 'INVALID_QUERY_PARAM');
}

function parseSessionSortByParam(value: string | null): 'updatedAt' | 'createdAt' | 'messageCount' | 'pendingConfirmationCount' | 'activeGrantCount' | 'toolExecutionCount' | 'failedToolExecutionCount' | 'lastToolStartedAt' | 'lastConfirmationCreatedAt' | 'lastDecisionAt' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'updatedAt' && value !== 'createdAt' && value !== 'messageCount' && value !== 'pendingConfirmationCount' && value !== 'activeGrantCount' && value !== 'toolExecutionCount' && value !== 'failedToolExecutionCount' && value !== 'lastToolStartedAt' && value !== 'lastConfirmationCreatedAt' && value !== 'lastDecisionAt') {
    throw new ApiHttpError(400, `Invalid session sortBy: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseSortOrderParam(value: string | null, parameterName: string): 'asc' | 'desc' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'asc' && value !== 'desc') {
    throw new ApiHttpError(400, `Invalid sort order for ${parameterName}: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseToolExecutionStatusParam(value: string | null, parameterName: string): 'started' | 'finished' | 'failed' | 'waiting_confirmation' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'started' && value !== 'finished' && value !== 'failed' && value !== 'waiting_confirmation') {
    throw new ApiHttpError(400, `Invalid tool execution status for ${parameterName}: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseConfirmationStatusParam(value: string | null): 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'pending' && value !== 'approved' && value !== 'rejected' && value !== 'consumed' && value !== 'expired') {
    throw new ApiHttpError(400, `Invalid confirmation status filter: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseConfirmationRiskLevelParam(value: string | null): 'low' | 'medium' | 'high' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new ApiHttpError(400, `Invalid confirmation risk level filter: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseConfirmationDecisionParam(value: string | null): 'approved' | 'rejected' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'approved' && value !== 'rejected') {
    throw new ApiHttpError(400, `Invalid confirmation decision filter: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseSessionApprovalStateParam(value: string | null): 'blocked' | 'approved' | 'rejected' | 'clear' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'blocked' && value !== 'approved' && value !== 'rejected' && value !== 'clear') {
    throw new ApiHttpError(400, `Invalid session approvalState: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseSessionExecutionStateParam(value: string | null): 'waiting' | 'failed' | 'completed' | 'idle' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'waiting' && value !== 'failed' && value !== 'completed' && value !== 'idle') {
    throw new ApiHttpError(400, `Invalid session executionState: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseSessionQueueParam(value: string | null): 'attention' | 'blocked' | 'failed' | 'idle' | undefined {
  if (!value) {
    return undefined;
  }

  if (value !== 'attention' && value !== 'blocked' && value !== 'failed' && value !== 'idle') {
    throw new ApiHttpError(400, `Invalid session queue: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

function parseIsoDateParam(value: string | null, parameterName: string): string | undefined {
  if (!value) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(value))) {
    throw new ApiHttpError(400, `Invalid ISO date for ${parameterName}: ${value}`, 'INVALID_QUERY_PARAM');
  }

  return value;
}

async function requireSessionOwnerAccess(
  manager: AgentSessionManager,
  actor: AuthenticatedActor | undefined,
  sessionId: string,
): Promise<void> {
  const ownerId = await manager.getSessionOwner(sessionId);
  if (ownerId && actor && actor.id !== ownerId && !hasRequiredRole(actor, 'admin')) {
    throw new ApiHttpError(403, 'Forbidden session access', 'FORBIDDEN');
  }
}

export function createApiServer(options: ApiServerOptions = {}): http.Server {
  const projectPath = options.projectPath ?? getDefaultProjectPath();
  const project = options.project ?? ProjectLoader.load(projectPath);
  configureRedaction(project.security?.redaction);
  const debug = options.debug ?? false;
  const auditSink = options.auditSink ?? new CompositeApiAuditSink([
    new ConsoleApiAuditSink(),
    new InMemoryApiAuditSink(),
  ]);
  const manager = new AgentSessionManager(projectPath, debug, options.persistence, project, auditSink);
  const queryService = options.persistence?.sessions
    && options.persistence.confirmations
    && options.persistence.approvalGrants
    && options.persistence.toolExecutions
    ? new PersistenceQueryService({
        sessions: options.persistence.sessions,
        confirmations: options.persistence.confirmations,
        approvalGrants: options.persistence.approvalGrants,
        toolExecutions: options.persistence.toolExecutions,
        auditEvents: options.persistence.auditEvents,
      })
    : null;

  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    let actor: AuthenticatedActor | undefined;
    let auditSessionId: string | undefined;
    let auditRequestTargetId: string | undefined;

    try {
      if (!request.url || !request.method) {
        sendError(response, requestId, 400, 'INVALID_REQUEST', 'Invalid request');
        emitAudit(auditSink, request, { requestId, action: 'invalid_request' }, 400, 'failure', 'Invalid request');
        return;
      }

      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;

      if (request.method === 'GET' && (pathname === '/' || pathname === '/ui')) {
        sendText(response, 200, getMinimalUiHtml(), 'text/html', requestId);
        emitAudit(auditSink, request, { requestId, action: 'ui_index' }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/health') {
        const body = {
          status: 'ok',
          projectId: project.id,
          persistence: {
            enabled: Boolean(options.persistence),
          },
          auth: {
            enabled: Boolean(options.auth?.enabled),
          },
        };
        sendJson(response, 200, body, requestId);
        emitAudit(auditSink, request, { requestId, action: 'health_check' }, 200, 'success');
        return;
      }

      actor = authenticateRequest(request.headers.authorization, options.auth);

      if (request.method === 'GET' && pathname === '/project') {
        requireRole(actor, options.auth, 'viewer');
        const body = {
          project: buildProjectSummary(project),
          debug,
        };
        sendJson(response, 200, body, requestId);
        emitAudit(auditSink, request, { requestId, actor, action: 'project_summary' }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/project/template') {
        requireRole(actor, options.auth, 'viewer');
        const template = buildProjectTemplate(url.searchParams.get('scenario'));
        const format = url.searchParams.get('format')?.toLowerCase();
        if (format === 'yaml' || format === 'yml') {
          sendText(response, 200, template.yaml, template.contentType, requestId, template.fileName);
        } else {
          sendJsonRaw(response, 200, { template }, requestId);
        }
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'project_template',
          metadata: { scenario: template.scenario, format: format || 'json' },
        }, 200, 'success');
        return;
      }

      if (request.method === 'POST' && pathname === '/project/template') {
        requireRole(actor, options.auth, 'viewer');
        const body = await readJsonBody(request);
        const template = buildProjectTemplateFromWizard(body);
        const format = url.searchParams.get('format')?.toLowerCase();
        if (format === 'yaml' || format === 'yml') {
          sendText(response, 200, template.yaml, template.contentType, requestId, template.fileName);
        } else {
          sendJsonRaw(response, 200, { template }, requestId);
        }
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'project_template_generate',
          metadata: { scenario: template.scenario, format: format || 'json', fileName: template.fileName },
        }, 200, 'success');
        return;
      }

      if (request.method === 'POST' && pathname === '/sessions') {
        requireRole(actor, options.auth, 'operator');
        const created = await manager.createSession(actor);
        sendJson(response, 201, created, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_create',
          sessionId: created.sessionId,
        }, 201, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/sessions/export') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_export' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          projectId: url.searchParams.get('projectId') ?? undefined,
          status: parseSessionStatusParam(url.searchParams.get('status')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          hasPendingConfirmation: parseBooleanQueryParam(url.searchParams.get('hasPendingConfirmation'), 'hasPendingConfirmation'),
          hasActiveGrant: parseBooleanQueryParam(url.searchParams.get('hasActiveGrant'), 'hasActiveGrant'),
          lastToolExecutionStatus: parseToolExecutionStatusParam(url.searchParams.get('lastToolExecutionStatus'), 'lastToolExecutionStatus'),
          lastConfirmationRiskLevel: parseConfirmationRiskLevelParam(url.searchParams.get('lastConfirmationRiskLevel')),
          lastDecision: parseConfirmationDecisionParam(url.searchParams.get('lastDecision')),
          hasFailedToolExecution: parseBooleanQueryParam(url.searchParams.get('hasFailedToolExecution'), 'hasFailedToolExecution'),
          needsAttention: parseBooleanQueryParam(url.searchParams.get('needsAttention'), 'needsAttention'),
          approvalState: parseSessionApprovalStateParam(url.searchParams.get('approvalState')),
          executionState: parseSessionExecutionStateParam(url.searchParams.get('executionState')),
          queue: parseSessionQueueParam(url.searchParams.get('queue')),
          sortBy: parseSessionSortByParam(url.searchParams.get('sortBy')),
          sortOrder: parseSortOrderParam(url.searchParams.get('sortOrder'), 'sortOrder'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        const payload = await queryService.querySessions(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);

        if (format === 'csv') {
          sendText(response, 200, buildSessionsCsv(payload.records as unknown as Array<Record<string, unknown>>), 'text/csv', requestId, 'sessions-export.csv');
        } else {
          sendText(response, 200, buildSessionsJsonl(payload.records), 'application/x-ndjson', requestId, 'sessions-export.jsonl');
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_export',
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/sessions') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_list' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          projectId: url.searchParams.get('projectId') ?? undefined,
          status: parseSessionStatusParam(url.searchParams.get('status')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          hasPendingConfirmation: parseBooleanQueryParam(url.searchParams.get('hasPendingConfirmation'), 'hasPendingConfirmation'),
          hasActiveGrant: parseBooleanQueryParam(url.searchParams.get('hasActiveGrant'), 'hasActiveGrant'),
          lastToolExecutionStatus: parseToolExecutionStatusParam(url.searchParams.get('lastToolExecutionStatus'), 'lastToolExecutionStatus'),
          lastConfirmationRiskLevel: parseConfirmationRiskLevelParam(url.searchParams.get('lastConfirmationRiskLevel')),
          lastDecision: parseConfirmationDecisionParam(url.searchParams.get('lastDecision')),
          hasFailedToolExecution: parseBooleanQueryParam(url.searchParams.get('hasFailedToolExecution'), 'hasFailedToolExecution'),
          needsAttention: parseBooleanQueryParam(url.searchParams.get('needsAttention'), 'needsAttention'),
          approvalState: parseSessionApprovalStateParam(url.searchParams.get('approvalState')),
          executionState: parseSessionExecutionStateParam(url.searchParams.get('executionState')),
          queue: parseSessionQueueParam(url.searchParams.get('queue')),
          sortBy: parseSessionSortByParam(url.searchParams.get('sortBy')),
          sortOrder: parseSortOrderParam(url.searchParams.get('sortOrder'), 'sortOrder'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const payload = await queryService.querySessions(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_list',
          metadata: query,
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/confirmations/export') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'confirmation_requests_export' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          projectId: url.searchParams.get('projectId') ?? undefined,
          tool: url.searchParams.get('tool') ?? undefined,
          riskLevel: parseConfirmationRiskLevelParam(url.searchParams.get('riskLevel')),
          status: parseConfirmationStatusParam(url.searchParams.get('status')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        const payload = await queryService.queryConfirmationRequests(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);

        if (format === 'csv') {
          sendText(response, 200, buildConfirmationRequestsCsv(payload.records as unknown as Array<Record<string, unknown>>), 'text/csv', requestId, 'confirmations-export.csv');
        } else {
          sendText(response, 200, buildConfirmationRequestsJsonl(payload.records), 'application/x-ndjson', requestId, 'confirmations-export.jsonl');
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'confirmation_requests_export',
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/confirmations') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'confirmation_requests' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          projectId: url.searchParams.get('projectId') ?? undefined,
          tool: url.searchParams.get('tool') ?? undefined,
          riskLevel: parseConfirmationRiskLevelParam(url.searchParams.get('riskLevel')),
          status: parseConfirmationStatusParam(url.searchParams.get('status')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const payload = await queryService.queryConfirmationRequests(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'confirmation_requests',
          metadata: query,
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/confirmations/decisions/export') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'confirmation_decisions_export' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          requestId: url.searchParams.get('requestId') ?? undefined,
          decision: parseConfirmationDecisionParam(url.searchParams.get('decision')),
          actor: url.searchParams.get('actor') ?? undefined,
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        const payload = await queryService.queryConfirmationDecisions(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);

        if (format === 'csv') {
          sendText(response, 200, buildConfirmationDecisionsCsv(payload.records as unknown as Array<Record<string, unknown>>), 'text/csv', requestId, 'confirmation-decisions-export.csv');
        } else {
          sendText(response, 200, buildConfirmationDecisionsJsonl(payload.records), 'application/x-ndjson', requestId, 'confirmation-decisions-export.jsonl');
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'confirmation_decisions_export',
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/confirmations/decisions') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'confirmation_decisions' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          requestId: url.searchParams.get('requestId') ?? undefined,
          decision: parseConfirmationDecisionParam(url.searchParams.get('decision')),
          actor: url.searchParams.get('actor') ?? undefined,
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const payload = await queryService.queryConfirmationDecisions(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'confirmation_decisions',
          metadata: query,
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/tool-executions/export') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'tool_executions_export' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          projectId: url.searchParams.get('projectId') ?? undefined,
          tool: url.searchParams.get('tool') ?? undefined,
          status: parseToolExecutionStatusParam(url.searchParams.get('status'), 'status'),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        const payload = await queryService.queryToolExecutions(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);

        if (format === 'csv') {
          sendText(response, 200, buildToolExecutionsCsv(payload.records as unknown as Array<Record<string, unknown>>), 'text/csv', requestId, 'tool-executions-export.csv');
        } else {
          sendText(response, 200, buildToolExecutionsJsonl(payload.records), 'application/x-ndjson', requestId, 'tool-executions-export.jsonl');
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'tool_executions_export',
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/tool-executions') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'tool_executions' }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          projectId: url.searchParams.get('projectId') ?? undefined,
          tool: url.searchParams.get('tool') ?? undefined,
          status: parseToolExecutionStatusParam(url.searchParams.get('status'), 'status'),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const payload = await queryService.queryToolExecutions(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'tool_executions',
          metadata: query,
        }, 200, 'success');
        return;
      }

      if (request.method === 'GET' && pathname === '/metrics/export') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'system_metrics_export' }, 501, 'failure', 'Session query service is not configured', options.persistence?.auditEvents);
          return;
        }

        const projectId = url.searchParams.get('projectId') ?? undefined;
        const from = parseIsoDateParam(url.searchParams.get('from'), 'from');
        const to = parseIsoDateParam(url.searchParams.get('to'), 'to');
        const bucketMinutes = parsePositiveIntegerParam(url.searchParams.get('bucketMinutes'), 15);
        const topActionsLimit = parsePositiveIntegerParam(url.searchParams.get('topActionsLimit'), 5);
        const actorLimit = parsePositiveIntegerParam(url.searchParams.get('actorLimit'), 5);
        const format = parseExportFormat(url.searchParams.get('format'));
        const metrics = await queryService.getSystemMetrics({
          projectId,
          from,
          to,
          bucketMinutes,
          topActionsLimit,
          actorLimit,
        }, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);

        if (format === 'csv') {
          sendText(response, 200, buildMetricsCsv(metrics as unknown as Record<string, unknown>), 'text/csv', requestId, 'metrics-export.csv');
        } else {
          sendText(response, 200, buildMetricsJsonl(metrics), 'application/x-ndjson', requestId, 'metrics-export.jsonl');
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'system_metrics_export',
          metadata: { projectId, from, to, bucketMinutes, topActionsLimit, actorLimit, format },
        }, 200, 'success', undefined, options.persistence?.auditEvents);
        return;
      }

      if (request.method === 'GET' && pathname === '/metrics') {
        requireRole(actor, options.auth, 'viewer');
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'system_metrics' }, 501, 'failure', 'Session query service is not configured', options.persistence?.auditEvents);
          return;
        }

        const projectId = url.searchParams.get('projectId') ?? undefined;
        const from = parseIsoDateParam(url.searchParams.get('from'), 'from');
        const to = parseIsoDateParam(url.searchParams.get('to'), 'to');
        const bucketMinutes = parsePositiveIntegerParam(url.searchParams.get('bucketMinutes'), 15);
        const topActionsLimit = parsePositiveIntegerParam(url.searchParams.get('topActionsLimit'), 5);
        const actorLimit = parsePositiveIntegerParam(url.searchParams.get('actorLimit'), 5);
        const metrics = await queryService.getSystemMetrics({
          projectId,
          from,
          to,
          bucketMinutes,
          topActionsLimit,
          actorLimit,
        }, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        sendJson(response, 200, { metrics }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'system_metrics',
          metadata: { projectId, from, to, bucketMinutes, topActionsLimit, actorLimit },
        }, 200, 'success', undefined, options.persistence?.auditEvents);
        return;
      }

      if (request.method === 'GET' && pathname === '/audit-events/export') {
        requireRole(actor, options.auth, 'viewer');
        if (!isQueryableApiAuditSink(auditSink) && !queryService) {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'audit_events_export' }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          actorId: url.searchParams.get('actorId') ?? undefined,
          action: url.searchParams.get('action') ?? undefined,
          result: parseAuditResultParam(url.searchParams.get('result')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        let payload;
        if (queryService && options.persistence?.auditEvents) {
          payload = await queryService.getAuditEvents(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        } else if (isQueryableApiAuditSink(auditSink)) {
          payload = auditSink.query(query);
        } else {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'audit_events_export' }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }

        if (format === 'csv') {
          sendText(response, 200, buildAuditEventsCsv(payload.events), 'text/csv', requestId, 'audit-events-export.csv');
        } else {
          sendText(response, 200, buildAuditEventsJsonl(payload.events), 'application/x-ndjson', requestId, 'audit-events-export.jsonl');
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'audit_events_export',
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success', undefined, options.persistence?.auditEvents);
        return;
      }

      if (request.method === 'GET' && pathname === '/audit-events') {
        requireRole(actor, options.auth, 'viewer');
        if (!isQueryableApiAuditSink(auditSink) && !queryService) {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'audit_events' }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }

        const query = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          actorId: url.searchParams.get('actorId') ?? undefined,
          action: url.searchParams.get('action') ?? undefined,
          result: parseAuditResultParam(url.searchParams.get('result')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        let payload;
        if (queryService && options.persistence?.auditEvents) {
          payload = await queryService.getAuditEvents(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        } else if (isQueryableApiAuditSink(auditSink)) {
          payload = auditSink.query(query);
        } else {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'audit_events' }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }
        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'audit_events',
          metadata: query,
        }, 200, 'success', undefined, options.persistence?.auditEvents);
        return;
      }

      const sessionAuditEventsExportMatch = pathname.match(/^\/sessions\/([^/]+)\/audit-events\/export$/);
      if (request.method === 'GET' && sessionAuditEventsExportMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionAuditEventsExportMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionAuditEventsExportMatch[1]);
        if (!isQueryableApiAuditSink(auditSink) && !queryService) {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_audit_events_export', sessionId: sessionAuditEventsExportMatch[1] }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }

        const query = {
          sessionId: sessionAuditEventsExportMatch[1],
          actorId: url.searchParams.get('actorId') ?? undefined,
          action: url.searchParams.get('action') ?? undefined,
          result: parseAuditResultParam(url.searchParams.get('result')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        let payload;
        if (queryService && options.persistence?.auditEvents) {
          payload = await queryService.getAuditEvents(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        } else if (isQueryableApiAuditSink(auditSink)) {
          payload = auditSink.query(query);
        } else {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_audit_events_export', sessionId: sessionAuditEventsExportMatch[1] }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }

        if (format === 'csv') {
          sendText(response, 200, buildAuditEventsCsv(payload.events), 'text/csv', requestId, `session-${sessionAuditEventsExportMatch[1]}-audit-events-export.csv`);
        } else {
          sendText(response, 200, buildAuditEventsJsonl(payload.events), 'application/x-ndjson', requestId, `session-${sessionAuditEventsExportMatch[1]}-audit-events-export.jsonl`);
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_audit_events_export',
          sessionId: sessionAuditEventsExportMatch[1],
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success', undefined, options.persistence?.auditEvents);
        return;
      }

      const sessionAuditEventsMatch = pathname.match(/^\/sessions\/([^/]+)\/audit-events$/);
      if (request.method === 'GET' && sessionAuditEventsMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionAuditEventsMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionAuditEventsMatch[1]);
        if (!isQueryableApiAuditSink(auditSink) && !queryService) {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_audit_events', sessionId: sessionAuditEventsMatch[1] }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }

        const query = {
          sessionId: sessionAuditEventsMatch[1],
          actorId: url.searchParams.get('actorId') ?? undefined,
          action: url.searchParams.get('action') ?? undefined,
          result: parseAuditResultParam(url.searchParams.get('result')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        let payload;
        if (queryService && options.persistence?.auditEvents) {
          payload = await queryService.getAuditEvents(query, actor && hasRequiredRole(actor, 'admin') ? undefined : actor?.id);
        } else if (isQueryableApiAuditSink(auditSink)) {
          payload = auditSink.query(query);
        } else {
          sendError(response, requestId, 501, 'AUDIT_QUERY_NOT_SUPPORTED', 'Audit query is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_audit_events', sessionId: sessionAuditEventsMatch[1] }, 501, 'failure', 'Audit query is not configured', options.persistence?.auditEvents);
          return;
        }
        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_audit_events',
          sessionId: sessionAuditEventsMatch[1],
          metadata: query,
        }, 200, 'success', undefined, options.persistence?.auditEvents);
        return;
      }

      const sessionDetailsMatch = pathname.match(/^\/sessions\/([^/]+)$/);
      if (request.method === 'GET' && sessionDetailsMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionDetailsMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionDetailsMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_details', sessionId: sessionDetailsMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const details = await queryService.getSessionDetails(sessionDetailsMatch[1]);
        if (!details) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_details', sessionId: sessionDetailsMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, details, requestId);
        emitAudit(auditSink, request, { requestId, actor, action: 'session_details', sessionId: sessionDetailsMatch[1] }, 200, 'success');
        return;
      }

      const sessionMessagesMatch = pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && sessionMessagesMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionMessagesMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionMessagesMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_messages', sessionId: sessionMessagesMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const messages = await queryService.getSessionMessages(sessionMessagesMatch[1]);
        if (!messages) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_messages', sessionId: sessionMessagesMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, { messages }, requestId);
        emitAudit(auditSink, request, { requestId, actor, action: 'session_messages', sessionId: sessionMessagesMatch[1] }, 200, 'success');
        return;
      }

      const pendingConfirmationsMatch = pathname.match(/^\/sessions\/([^/]+)\/pending-confirmations$/);
      if (request.method === 'GET' && pendingConfirmationsMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = pendingConfirmationsMatch[1];
        await requireSessionOwnerAccess(manager, actor, pendingConfirmationsMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'pending_confirmations', sessionId: pendingConfirmationsMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const pendingConfirmations = await queryService.getPendingConfirmations(pendingConfirmationsMatch[1]);
        if (!pendingConfirmations) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'pending_confirmations', sessionId: pendingConfirmationsMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, { pendingConfirmations }, requestId);
        emitAudit(auditSink, request, { requestId, actor, action: 'pending_confirmations', sessionId: pendingConfirmationsMatch[1] }, 200, 'success');
        return;
      }

      const approvalGrantsMatch = pathname.match(/^\/sessions\/([^/]+)\/grants$/);
      if (request.method === 'GET' && approvalGrantsMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = approvalGrantsMatch[1];
        await requireSessionOwnerAccess(manager, actor, approvalGrantsMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'approval_grants', sessionId: approvalGrantsMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const approvalGrants = await queryService.getApprovalGrants(approvalGrantsMatch[1]);
        if (!approvalGrants) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'approval_grants', sessionId: approvalGrantsMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, { approvalGrants }, requestId);
        emitAudit(auditSink, request, { requestId, actor, action: 'approval_grants', sessionId: approvalGrantsMatch[1] }, 200, 'success');
        return;
      }

      const sessionConfirmationsExportMatch = pathname.match(/^\/sessions\/([^/]+)\/confirmations\/export$/);
      if (request.method === 'GET' && sessionConfirmationsExportMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionConfirmationsExportMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionConfirmationsExportMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_requests_export', sessionId: sessionConfirmationsExportMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          tool: url.searchParams.get('tool') ?? undefined,
          riskLevel: parseConfirmationRiskLevelParam(url.searchParams.get('riskLevel')),
          status: parseConfirmationStatusParam(url.searchParams.get('status')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        const payload = await queryService.querySessionConfirmationRequests(sessionConfirmationsExportMatch[1], query);
        if (!payload) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_requests_export', sessionId: sessionConfirmationsExportMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        if (format === 'csv') {
          sendText(response, 200, buildConfirmationRequestsCsv(payload.records as unknown as Array<Record<string, unknown>>), 'text/csv', requestId, `session-${sessionConfirmationsExportMatch[1]}-confirmations-export.csv`);
        } else {
          sendText(response, 200, buildConfirmationRequestsJsonl(payload.records), 'application/x-ndjson', requestId, `session-${sessionConfirmationsExportMatch[1]}-confirmations-export.jsonl`);
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_confirmation_requests_export',
          sessionId: sessionConfirmationsExportMatch[1],
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success');
        return;
      }

      const sessionConfirmationsMatch = pathname.match(/^\/sessions\/([^/]+)\/confirmations$/);
      if (request.method === 'GET' && sessionConfirmationsMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionConfirmationsMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionConfirmationsMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_requests', sessionId: sessionConfirmationsMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          tool: url.searchParams.get('tool') ?? undefined,
          riskLevel: parseConfirmationRiskLevelParam(url.searchParams.get('riskLevel')),
          status: parseConfirmationStatusParam(url.searchParams.get('status')),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const payload = await queryService.querySessionConfirmationRequests(sessionConfirmationsMatch[1], query);
        if (!payload) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_requests', sessionId: sessionConfirmationsMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_confirmation_requests',
          sessionId: sessionConfirmationsMatch[1],
          metadata: query,
        }, 200, 'success');
        return;
      }

      const sessionConfirmationDecisionsExportMatch = pathname.match(/^\/sessions\/([^/]+)\/confirmation-decisions\/export$/);
      if (request.method === 'GET' && sessionConfirmationDecisionsExportMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionConfirmationDecisionsExportMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionConfirmationDecisionsExportMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_decisions_export', sessionId: sessionConfirmationDecisionsExportMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          requestId: url.searchParams.get('requestId') ?? undefined,
          decision: parseConfirmationDecisionParam(url.searchParams.get('decision')),
          actor: url.searchParams.get('actor') ?? undefined,
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        const payload = await queryService.querySessionConfirmationDecisions(sessionConfirmationDecisionsExportMatch[1], query);
        if (!payload) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_decisions_export', sessionId: sessionConfirmationDecisionsExportMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        if (format === 'csv') {
          sendText(response, 200, buildConfirmationDecisionsCsv(payload.records as unknown as Array<Record<string, unknown>>), 'text/csv', requestId, `session-${sessionConfirmationDecisionsExportMatch[1]}-confirmation-decisions-export.csv`);
        } else {
          sendText(response, 200, buildConfirmationDecisionsJsonl(payload.records), 'application/x-ndjson', requestId, `session-${sessionConfirmationDecisionsExportMatch[1]}-confirmation-decisions-export.jsonl`);
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_confirmation_decisions_export',
          sessionId: sessionConfirmationDecisionsExportMatch[1],
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success');
        return;
      }

      const sessionConfirmationDecisionsMatch = pathname.match(/^\/sessions\/([^/]+)\/confirmation-decisions$/);
      if (request.method === 'GET' && sessionConfirmationDecisionsMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = sessionConfirmationDecisionsMatch[1];
        await requireSessionOwnerAccess(manager, actor, sessionConfirmationDecisionsMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_decisions', sessionId: sessionConfirmationDecisionsMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          requestId: url.searchParams.get('requestId') ?? undefined,
          decision: parseConfirmationDecisionParam(url.searchParams.get('decision')),
          actor: url.searchParams.get('actor') ?? undefined,
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const payload = await queryService.querySessionConfirmationDecisions(sessionConfirmationDecisionsMatch[1], query);
        if (!payload) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_confirmation_decisions', sessionId: sessionConfirmationDecisionsMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, { ...payload, query }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_confirmation_decisions',
          sessionId: sessionConfirmationDecisionsMatch[1],
          metadata: query,
        }, 200, 'success');
        return;
      }

      const toolExecutionsExportMatch = pathname.match(/^\/sessions\/([^/]+)\/tool-executions\/export$/);
      if (request.method === 'GET' && toolExecutionsExportMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = toolExecutionsExportMatch[1];
        await requireSessionOwnerAccess(manager, actor, toolExecutionsExportMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'tool_executions_export', sessionId: toolExecutionsExportMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          tool: url.searchParams.get('tool') ?? undefined,
          status: parseToolExecutionStatusParam(url.searchParams.get('status'), 'status'),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const format = parseExportFormat(url.searchParams.get('format'));
        const payload = await queryService.querySessionToolExecutions(toolExecutionsExportMatch[1], query);
        if (!payload) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'tool_executions_export', sessionId: toolExecutionsExportMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        if (format === 'csv') {
          sendText(response, 200, buildToolExecutionsCsv(payload.records as unknown as Array<Record<string, unknown>>), 'text/csv', requestId, `session-${toolExecutionsExportMatch[1]}-tool-executions-export.csv`);
        } else {
          sendText(response, 200, buildToolExecutionsJsonl(payload.records), 'application/x-ndjson', requestId, `session-${toolExecutionsExportMatch[1]}-tool-executions-export.jsonl`);
        }

        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'tool_executions_export',
          sessionId: toolExecutionsExportMatch[1],
          metadata: { ...query, format, total: payload.total },
        }, 200, 'success');
        return;
      }

      const toolExecutionsMatch = pathname.match(/^\/sessions\/([^/]+)\/tool-executions$/);
      if (request.method === 'GET' && toolExecutionsMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = toolExecutionsMatch[1];
        await requireSessionOwnerAccess(manager, actor, toolExecutionsMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'tool_executions', sessionId: toolExecutionsMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const query = {
          tool: url.searchParams.get('tool') ?? undefined,
          status: parseToolExecutionStatusParam(url.searchParams.get('status'), 'status'),
          from: parseIsoDateParam(url.searchParams.get('from'), 'from'),
          to: parseIsoDateParam(url.searchParams.get('to'), 'to'),
          limit: parsePositiveIntegerParam(url.searchParams.get('limit'), 50),
          offset: parseNonNegativeIntegerParam(url.searchParams.get('offset'), 0),
        };
        const payload = await queryService.querySessionToolExecutions(toolExecutionsMatch[1], query);
        if (!payload) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'tool_executions', sessionId: toolExecutionsMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, { ...payload, query: { sessionId: toolExecutionsMatch[1], ...query } }, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'tool_executions',
          sessionId: toolExecutionsMatch[1],
          metadata: query,
        }, 200, 'success');
        return;
      }

      const stateSummaryMatch = pathname.match(/^\/sessions\/([^/]+)\/state-summary$/);
      if (request.method === 'GET' && stateSummaryMatch) {
        requireRole(actor, options.auth, 'viewer');
        auditSessionId = stateSummaryMatch[1];
        await requireSessionOwnerAccess(manager, actor, stateSummaryMatch[1]);
        if (!queryService) {
          sendError(response, requestId, 501, 'QUERY_SERVICE_NOT_CONFIGURED', 'Session query service is not configured');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_state_summary', sessionId: stateSummaryMatch[1] }, 501, 'failure', 'Session query service is not configured');
          return;
        }

        const summary = await queryService.getSessionStateSummary(stateSummaryMatch[1]);
        if (!summary) {
          sendError(response, requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_state_summary', sessionId: stateSummaryMatch[1] }, 404, 'failure', 'Session not found');
          return;
        }

        sendJson(response, 200, { summary }, requestId);
        emitAudit(auditSink, request, { requestId, actor, action: 'session_state_summary', sessionId: stateSummaryMatch[1] }, 200, 'success');
        return;
      }

      const clearHistoryMatch = pathname.match(/^\/sessions\/([^/]+)\/clear-history$/);
      if (request.method === 'POST' && clearHistoryMatch) {
        requireRole(actor, options.auth, 'operator');
        auditSessionId = clearHistoryMatch[1];
        const result = await manager.clearSessionHistory(clearHistoryMatch[1], actor);
        sendJson(response, 200, result, requestId);
        emitAudit(auditSink, request, { requestId, actor, action: 'session_clear_history', sessionId: clearHistoryMatch[1] }, 200, 'success');
        return;
      }

      const resumeMatch = pathname.match(/^\/sessions\/([^/]+)\/resume$/);
      if (request.method === 'POST' && resumeMatch) {
        requireRole(actor, options.auth, 'operator');
        auditSessionId = resumeMatch[1];
        const result = await manager.resumeSession(resumeMatch[1], actor);
        sendJson(response, 200, result, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_resume',
          sessionId: resumeMatch[1],
          metadata: { status: result.status },
        }, 200, 'success');
        return;
      }

      const sessionRunMatch = pathname.match(/^\/sessions\/([^/]+)\/run$/);
      if (request.method === 'POST' && sessionRunMatch) {
        requireRole(actor, options.auth, 'operator');
        auditSessionId = sessionRunMatch[1];
        const body = await readJsonBody(request) as { input?: string };
        if (!body.input) {
          sendError(response, requestId, 400, 'INPUT_REQUIRED', 'input is required');
          emitAudit(auditSink, request, { requestId, actor, action: 'session_run', sessionId: sessionRunMatch[1] }, 400, 'failure', 'input is required');
          return;
        }

        const runResult = await manager.runSession(sessionRunMatch[1], body.input, actor);
        sendJson(response, 200, runResult, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'session_run',
          sessionId: sessionRunMatch[1],
          metadata: { status: runResult.status },
        }, 200, 'success');
        return;
      }

      const approveMatch = pathname.match(/^\/confirmations\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approveMatch) {
        requireRole(actor, options.auth, 'approver');
        auditRequestTargetId = approveMatch[1];
        auditSessionId = await manager.getSessionIdByRequestId(approveMatch[1]);
        const body = await readJsonBody(request) as { reason?: string };
        const result = await manager.approveConfirmation(approveMatch[1], body.reason, actor);
        sendJson(response, 200, result, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'confirmation_approve',
          sessionId: result.sessionId,
          requestTargetId: approveMatch[1],
          metadata: { status: result.status },
        }, 200, 'success');
        return;
      }

      const rejectMatch = pathname.match(/^\/confirmations\/([^/]+)\/reject$/);
      if (request.method === 'POST' && rejectMatch) {
        requireRole(actor, options.auth, 'approver');
        auditRequestTargetId = rejectMatch[1];
        auditSessionId = await manager.getSessionIdByRequestId(rejectMatch[1]);
        const body = await readJsonBody(request) as { reason?: string };
        const result = await manager.rejectConfirmation(rejectMatch[1], body.reason, actor);
        sendJson(response, 200, result, requestId);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'confirmation_reject',
          sessionId: result.sessionId,
          requestTargetId: rejectMatch[1],
        }, 200, 'success');
        return;
      }

      sendError(response, requestId, 404, 'NOT_FOUND', 'Not found');
      emitAudit(auditSink, request, { requestId, actor, action: 'not_found' }, 404, 'failure', 'Not found');
    } catch (error) {
      if (error instanceof ApiHttpError) {
        sendError(response, requestId, error.statusCode, error.code, error.message);
        emitAudit(auditSink, request, {
          requestId,
          actor,
          action: 'request_rejected',
          sessionId: auditSessionId,
          requestTargetId: auditRequestTargetId,
        }, error.statusCode, 'failure', error.message);
        return;
      }

      if (error instanceof AppError) {
        sendError(response, requestId, error.statusCode, error.code, error.message);
        emitAudit(
          auditSink,
          request,
          {
            requestId,
            actor,
            action: 'request_failed',
            sessionId: auditSessionId,
            requestTargetId: auditRequestTargetId,
            metadata: error.metadata,
          },
          error.statusCode,
          'failure',
          error.message,
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendError(response, requestId, 500, 'INTERNAL_ERROR', message);
      emitAudit(auditSink, request, {
        requestId,
        actor,
        action: 'request_failed',
        sessionId: auditSessionId,
        requestTargetId: auditRequestTargetId,
      }, 500, 'failure', message);
    }
  });

  server.on('close', () => {
    void manager.destroy();
  });

  return server;
}
