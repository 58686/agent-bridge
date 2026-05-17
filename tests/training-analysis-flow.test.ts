import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeAgent } from '../src/core/runtime-agent.js';
import { createDefaultConnectorRegistry } from '../src/connectors/default-registry.js';
import { createSqlitePersistence } from '../src/persistence/sqlite.js';
import { ProjectConfig } from '../src/core/types.js';

function createTrainingProject(baseUrl: string): ProjectConfig {
  return {
    id: 'training-analysis-agent-test',
    name: 'Training Analysis Agent Test',
    model: {
      provider: 'custom',
      model: 'mock-model',
    },
    connectors: [
      {
        id: 'company-training-api',
        type: 'api',
        name: 'Company Training API',
        config: {
          baseUrl,
          timeoutMs: 30000,
          auth: {
            type: 'bearer',
            token: 'test-training-token',
          },
          tools: [
            {
              name: 'get_training_stats',
              description: 'Get user training stats.',
              method: 'GET',
              path: '/training/stats',
              queryParams: ['userId'],
              parameters: {
                userId: {
                  type: 'string',
                  description: 'User id.',
                  required: true,
                },
              },
            },
            {
              name: 'save_training_analysis',
              description: 'Save training analysis result.',
              method: 'POST',
              path: '/training/analysis',
              bodyParams: ['userId', 'standardId', 'scoreLevel', 'riskLevel', 'summary', 'recommendations', 'evidence'],
              parameters: {
                userId: { type: 'string', description: 'User id.', required: true },
                standardId: { type: 'string', description: 'Analysis standard id.', required: true },
                scoreLevel: { type: 'string', description: 'Score level.', enum: ['gold', 'pass', 'needs_attention'], required: true },
                riskLevel: { type: 'string', description: 'Risk level.', enum: ['low', 'medium', 'high'], required: true },
                summary: { type: 'string', description: 'Summary.', required: true },
                recommendations: {
                  type: 'array',
                  description: 'Recommendations.',
                  required: true,
                  items: { type: 'string', description: 'One recommendation.' },
                },
                evidence: {
                  type: 'object',
                  description: 'Evidence metrics.',
                  required: true,
                  properties: {
                    completionRate: { type: 'number', description: 'Completion rate.', required: true },
                    averageScore: { type: 'number', description: 'Average score.', required: true },
                    overdueCourses: { type: 'number', description: 'Overdue course count.', required: true },
                    requiredCourses: { type: 'number', description: 'Required course count.', required: true },
                    completedCourses: { type: 'number', description: 'Completed course count.', required: true },
                  },
                },
              },
            },
          ],
        },
      },
    ],
    analysis: {
      standardId: 'strict-training-standard-2026',
      levels: [
        {
          level: 'gold',
          riskLevel: 'low',
          when: {
            completionRate: { gte: 1 },
            averageScore: { gte: 90 },
            overdueCourses: { eq: 0 },
          },
          recommendations: ['Assign advanced compliance content.'],
        },
        {
          level: 'pass',
          riskLevel: 'medium',
          when: {
            completionRate: { gte: 0.8 },
            averageScore: { gte: 70 },
          },
          recommendations: ['Review weak courses with the manager.'],
        },
      ],
      fallback: {
        level: 'needs_attention',
        riskLevel: 'high',
        recommendations: ['Create a remediation plan.'],
      },
    },
    systemPrompt: 'Analyze training data against the injected Analysis configuration JSON and save the result.',
    toolPolicy: {
      maxConsecutiveCalls: 6,
      confirmationRules: [
        { tool: 'save_training_analysis', requireConfirmation: true },
      ],
    },
    memory: {
      enabled: true,
      maxMessages: 20,
      type: 'sliding',
    },
  };
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function startTrainingApi() {
  const savedAnalyses: Record<string, unknown>[] = [];
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push({ method: request.method || 'GET', path: url.pathname });

    if (request.headers.authorization !== 'Bearer test-training-token') {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/training/stats') {
      sendJson(response, 200, {
        userId: url.searchParams.get('userId') || 'USER-001',
        standardId: 'annual-compliance-2026',
        requiredCourses: 8,
        completedCourses: 8,
        completionRate: 1,
        averageScore: 91,
        overdueCourses: 0,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/training/analysis') {
      const body = await readJson(request);
      requests[requests.length - 1].body = body;
      const record = {
        analysisId: 'analysis-test-1',
        ...body,
        savedAt: '2026-05-17T00:00:00.000Z',
      };
      savedAnalyses.push(record);
      sendJson(response, 200, { ok: true, record, savedCount: savedAnalyses.length });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    savedAnalyses,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe('training analysis example flow', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it('fetches training stats, waits for save approval, then saves a structured result using configured rules', async () => {
    const api = await startTrainingApi();
    cleanup.push(api.close);

    const dbPath = path.join(os.tmpdir(), `agent-bridge-training-${Date.now()}-${Math.random()}.sqlite`);
    const persistence = await createSqlitePersistence(dbPath);
    const agent = new RuntimeAgent(
      {
        project: createTrainingProject(api.baseUrl),
        persistence,
        debug: false,
      },
      createDefaultConnectorRegistry(),
    );
    cleanup.push(async () => agent.destroy());

    await agent.initialize();

    const first = await agent.run('analyze training data for USER-001');

    expect(first.pendingConfirmation).toBeDefined();
    expect(first.pendingConfirmation?.tool).toBe('save_training_analysis');
    expect(first.toolCalls.map((call) => call.tool)).toEqual(['get_training_stats', 'save_training_analysis']);
    expect(api.savedAnalyses).toHaveLength(0);

    await agent.approveConfirmation(first.pendingConfirmation!.id, 'approved in training flow test');
    await agent.clearHistory();

    const resumed = await agent.run('analyze training data for USER-001');

    expect(resumed.pendingConfirmation).toBeUndefined();
    expect(resumed.toolCalls.map((call) => call.tool)).toEqual(['get_training_stats', 'save_training_analysis']);
    expect(resumed.toolCalls.at(-1)?.result.success).toBe(true);
    expect(api.savedAnalyses).toHaveLength(1);
    expect(api.savedAnalyses[0]).toMatchObject({
      userId: 'USER-001',
      standardId: 'strict-training-standard-2026',
      scoreLevel: 'gold',
      riskLevel: 'low',
      recommendations: ['Assign advanced compliance content.'],
    });
    expect(resumed.response).toContain('培训分析已保存成功');
    expect(resumed.response).toContain('用户：USER-001');
    expect(resumed.response).toContain('等级：gold');
  });
});
