import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectLoader } from '../src/config/project-loader.js';
import { ConfigurationError, ValidationError } from '../src/errors.js';
import { OpenAIModel } from '../src/models/openai-model.js';

interface ProjectConfigIssue {
  path: string;
  message: string;
}

function writeTempProject(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-model-'));
  const filePath = path.join(dir, 'project.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function expectInvalidProject(content: string): ProjectConfigIssue[] {
  const projectPath = writeTempProject(content);

  try {
    ProjectLoader.load(projectPath, { env: {} });
    throw new Error('Expected ProjectLoader.load to throw');
  } catch (error) {
    expect(error).toMatchObject<Partial<ConfigurationError>>({
      code: 'PROJECT_CONFIG_INVALID',
    });

    const metadata = (error as ConfigurationError).metadata as { issues?: ProjectConfigIssue[] } | undefined;
    expect(metadata?.issues).toBeTruthy();
    return metadata!.issues!;
  }
}

describe('model and analysis configuration', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads OpenAI-compatible model settings and analysis rules', () => {
    const projectPath = writeTempProject(`
id: model-project
name: Model Project
model:
  provider: openai
  model: gpt-4o-mini
  envApiKey: OPENAI_API_KEY
  baseUrl: https://llm-gateway.example.com/v1
  timeoutMs: 45000
  temperature: 0.1
analysis:
  standardId: annual-standard
  levels:
    - level: excellent
      riskLevel: low
      when:
        completionRate:
          gte: 0.9
  fallback:
    level: needs_attention
    riskLevel: high
connectors: []
`);

    const project = ProjectLoader.load(projectPath, { env: {} });

    expect(project.model).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      envApiKey: 'OPENAI_API_KEY',
      baseUrl: 'https://llm-gateway.example.com/v1',
      timeoutMs: 45000,
      temperature: 0.1,
    });
    expect(project.analysis?.standardId).toBe('annual-standard');
    expect(project.analysis?.levels?.[0]).toMatchObject({ level: 'excellent', riskLevel: 'low' });
  });

  it('loads project-specific security redaction settings', () => {
    const projectPath = writeTempProject(`
id: security-project
name: Security Project
model:
  provider: mock
  model: mock-model
security:
  redaction:
    extraSensitiveKeys:
      - employeeIdCard
      - mobile_phone
    replacement: '[MASKED]'
connectors: []
`);

    const project = ProjectLoader.load(projectPath, { env: {} });

    expect(project.security?.redaction).toEqual({
      extraSensitiveKeys: ['employeeIdCard', 'mobile_phone'],
      replacement: '[MASKED]',
    });
  });

  it('rejects invalid security redaction settings at startup', () => {
    const issues = expectInvalidProject(`
id: invalid-security-project
name: Invalid Security Project
model:
  provider: mock
  model: mock-model
security:
  redaction:
    extraSensitiveKeys:
      - ''
      - 123
    replacement: ''
connectors: []
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'security.redaction.extraSensitiveKeys' }),
        expect.objectContaining({ path: 'security.redaction.replacement' }),
      ]),
    );
  });

  it('rejects invalid model and analysis settings at startup', () => {
    const issues = expectInvalidProject(`
id: invalid-model-project
name: Invalid Model Project
model:
  provider: openai
  model: gpt-4o-mini
  envApiKey: ''
  timeoutMs: 0
  maxTokens: -1
  temperature: 3
  extra: invalid
analysis:
  standardId: ''
  levels:
    - level: ''
      riskLevel: critical
      when:
        completionRate:
          gt: 0.9
        averageScore:
          gte: high
  fallback:
    riskLevel: urgent
connectors: []
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'model.envApiKey' }),
        expect.objectContaining({ path: 'model.timeoutMs' }),
        expect.objectContaining({ path: 'model.maxTokens' }),
        expect.objectContaining({ path: 'model.temperature' }),
        expect.objectContaining({ path: 'model.extra' }),
        expect.objectContaining({ path: 'analysis.standardId' }),
        expect.objectContaining({ path: 'analysis.levels[0].level' }),
        expect.objectContaining({ path: 'analysis.levels[0].riskLevel' }),
        expect.objectContaining({ path: 'analysis.levels[0].when.completionRate.gt' }),
        expect.objectContaining({ path: 'analysis.levels[0].when.completionRate' }),
        expect.objectContaining({ path: 'analysis.levels[0].when.averageScore.gte' }),
        expect.objectContaining({ path: 'analysis.fallback.riskLevel' }),
      ]),
    );
  });

  it('times out OpenAI-compatible chat requests', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const model = new OpenAIModel({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      baseUrl: 'https://llm-gateway.example.com/v1',
      timeoutMs: 1000,
    });

    const execution = model.chat([{ role: 'user', content: 'hello' }]);
    const expectation = expect(execution).rejects.toMatchObject<Partial<ValidationError>>({
      code: 'OPENAI_REQUEST_TIMEOUT',
      metadata: expect.objectContaining({ timeout: true, timeoutMs: 1000 }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses OpenAI-compatible tool calls', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'get_training_stats',
                  arguments: JSON.stringify({ userId: 'USER-001' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const model = new OpenAIModel({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      baseUrl: 'https://llm-gateway.example.com/v1',
    });

    const response = await model.chat([{ role: 'user', content: 'analyze USER-001' }], [
      {
        name: 'get_training_stats',
        description: 'Get training stats',
        parameters: {
          userId: { type: 'string', description: 'User id', required: true },
        },
        execute: async () => ({ success: true }),
      },
    ]);

    expect(response.finishReason).toBe('tool_call');
    expect(response.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'get_training_stats',
        arguments: { userId: 'USER-001' },
      },
    ]);
    expect(response.usage?.totalTokens).toBe(15);
  });
});
