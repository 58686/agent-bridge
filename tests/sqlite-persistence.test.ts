import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqlitePersistence } from '../src/persistence/sqlite.js';

const tempFiles: string[] = [];

function createTempDbPath(): string {
  const filePath = path.join(
    os.tmpdir(),
    `agent-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  tempFiles.push(filePath);
  return filePath;
}

describe('sqlite persistence', () => {
  afterEach(() => {
    for (const filePath of tempFiles.splice(0)) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('可以持久化 confirmation request、decision 与 approval grant', async () => {
    const filePath = createTempDbPath();
    const persistence = await createSqlitePersistence(filePath);

    await persistence.confirmations!.createRequest({
      id: 'req-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      tool: 'create_comment',
      riskLevel: 'high',
      args: { ticketId: 'T-1', content: 'hello' },
      reason: 'Tool create_comment requires confirmation before execution',
      callId: 'call-1',
      status: 'pending',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    const pending = await persistence.confirmations!.listPending('session-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('req-1');

    await persistence.confirmations!.markApproved('req-1', '2025-01-01T00:01:00.000Z');
    await persistence.confirmations!.appendDecision({
      id: 'decision-1',
      requestId: 'req-1',
      sessionId: 'session-1',
      decision: 'approved',
      reason: 'approved in test',
      createdAt: '2025-01-01T00:01:00.000Z',
    });
    await persistence.approvalGrants!.createGrant({
      requestId: 'req-1',
      sessionId: 'session-1',
      tool: 'create_comment',
      callId: 'call-1',
      args: { ticketId: 'T-1', content: 'hello' },
      approvedAt: '2025-01-01T00:01:00.000Z',
      reason: 'approved in test',
    });

    const matchedGrant = await persistence.approvalGrants!.findMatchingGrant(
      'session-1',
      'create_comment',
      'call-1',
      { ticketId: 'T-1', content: 'hello' },
    );
    expect(matchedGrant?.requestId).toBe('req-1');

    await persistence.approvalGrants!.consumeGrant('req-1', '2025-01-01T00:02:00.000Z');
    await persistence.confirmations!.markConsumed('req-1', '2025-01-01T00:02:00.000Z');

    const request = await persistence.confirmations!.getById('req-1');
    expect(request?.status).toBe('consumed');

    const activeGrants = await persistence.approvalGrants!.listActive('session-1');
    expect(activeGrants).toHaveLength(0);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });

  it('可以批量过期 pending confirmation，并持久化 tool execution', async () => {
    const filePath = createTempDbPath();
    const persistence = await createSqlitePersistence(filePath);

    await persistence.confirmations!.createRequest({
      id: 'req-expired',
      sessionId: 'session-2',
      projectId: 'project-1',
      tool: 'dangerous_tool',
      riskLevel: 'high',
      args: { id: 'A-1' },
      reason: 'needs approval',
      status: 'pending',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T00:05:00.000Z',
    });

    const expiredCount = await persistence.confirmations!.expirePending('2025-01-01T00:06:00.000Z');
    expect(expiredCount).toBe(1);
    expect(await persistence.confirmations!.listPending('session-2')).toHaveLength(0);
    expect((await persistence.confirmations!.getById('req-expired'))?.status).toBe('expired');

    await persistence.toolExecutions!.create({
      id: 'call-2',
      sessionId: 'session-2',
      tool: 'dangerous_tool',
      callId: 'call-2',
      args: { id: 'A-1' },
      status: 'started',
      startedAt: '2025-01-01T00:00:00.000Z',
    });
    await persistence.toolExecutions!.finish('call-2', {
      status: 'waiting_confirmation',
      finishedAt: '2025-01-01T00:00:05.000Z',
      durationMs: 5000,
      error: 'needs approval',
      result: { confirmationRequired: true },
    });

    const executions = await persistence.toolExecutions!.listBySession('session-2');
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe('waiting_confirmation');
    expect(executions[0].durationMs).toBe(5000);
    expect(executions[0].result).toEqual({ confirmationRequired: true });

    const queried = await persistence.toolExecutions!.query({
      tool: 'dangerous_tool',
      status: 'waiting_confirmation',
      from: '2024-12-31T23:59:00.000Z',
      to: '2025-01-01T00:01:00.000Z',
      limit: 10,
      offset: 0,
    });
    expect(queried.total).toBe(1);
    expect(queried.records[0].id).toBe('call-2');
  });

  it('会过滤已过期 grant，并可将 started execution 标记为 interrupted', async () => {
    const filePath = createTempDbPath();
    const persistence = await createSqlitePersistence(filePath);

    await persistence.approvalGrants!.createGrant({
      requestId: 'grant-expired',
      sessionId: 'session-3',
      tool: 'dangerous_tool',
      callId: 'call-3',
      args: { id: 'A-3' },
      approvedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T00:05:00.000Z',
    });

    expect(await persistence.approvalGrants!.listActive('session-3')).toHaveLength(0);
    expect(
      await persistence.approvalGrants!.findMatchingGrant('session-3', 'dangerous_tool', 'call-3', { id: 'A-3' })
    ).toBeNull();

    const expiredCount = await persistence.approvalGrants!.expireActive('2025-01-01T00:06:00.000Z');
    expect(expiredCount).toBe(1);

    await persistence.toolExecutions!.create({
      id: 'call-3',
      sessionId: 'session-3',
      tool: 'dangerous_tool',
      callId: 'call-3',
      args: { id: 'A-3' },
      status: 'started',
      startedAt: '2025-01-01T00:00:00.000Z',
    });

    const interruptedCount = await persistence.toolExecutions!.markInterrupted(
      'session-3',
      '2025-01-01T00:07:00.000Z',
      'process interrupted in test',
    );
    expect(interruptedCount).toBe(1);

    const executions = await persistence.toolExecutions!.listBySession('session-3');
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe('interrupted');
    expect(executions[0].finishedAt).toBe('2025-01-01T00:07:00.000Z');
    expect(executions[0].error).toBe('process interrupted in test');
  });

  it('可以持久化并查询 audit events', async () => {
    const filePath = createTempDbPath();
    const persistence = await createSqlitePersistence(filePath);

    await persistence.auditEvents!.create({
      timestamp: '2025-01-01T00:00:00.000Z',
      requestId: 'req-http-1',
      actorId: 'viewer-1',
      role: 'viewer',
      sessionId: 'session-1',
      action: 'session_details',
      result: 'success',
      statusCode: 200,
    });
    await persistence.auditEvents!.create({
      timestamp: '2025-01-01T00:01:00.000Z',
      requestId: 'req-http-2',
      actorId: 'operator-1',
      role: 'operator',
      sessionId: 'session-2',
      action: 'session_run',
      result: 'failure',
      statusCode: 500,
      error: 'runtime failed',
      metadata: { status: 'failed' },
    });

    const allEvents = await persistence.auditEvents!.listAll();
    expect(allEvents).toHaveLength(2);
    expect(allEvents[0].action).toBe('session_run');
    expect(allEvents[1].action).toBe('session_details');

    const filtered = await persistence.auditEvents!.query({
      actorId: 'operator-1',
      result: 'failure',
      from: '2025-01-01T00:00:30.000Z',
      to: '2025-01-01T00:01:30.000Z',
      limit: 10,
      offset: 0,
    });
    expect(filtered.total).toBe(1);
    expect(filtered.events[0].requestId).toBe('req-http-2');
    expect(filtered.events[0].metadata).toEqual({ status: 'failed' });
  });
});
