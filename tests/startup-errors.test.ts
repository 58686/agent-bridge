import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ValidationError } from '../src/errors.js';
import { ProjectLoader } from '../src/config/project-loader.js';
import { ApiConnector } from '../src/connectors/examples/api-connector.js';
import { ModelFactory } from '../src/models/model-factory.js';
import { OpenAIModel } from '../src/models/openai-model.js';
import { startApiServer } from '../src/server-main.js';

interface ProjectConfigIssue {
  path: string;
  message: string;
}

function writeTempProject(content: string, extension = '.yaml'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-project-'));
  const filePath = path.join(dir, `project${extension}`);
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

describe('startup errors', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('不支持的项目配置文件扩展名会抛出结构化错误', () => {
    expect(() => ProjectLoader.load(path.resolve(process.cwd(), 'README.md'))).toThrowError(
      expect.objectContaining({
        code: 'PROJECT_CONFIG_UNSUPPORTED_FILE',
      }),
    );
  });

  it('project 配置会递归解析环境变量占位符', () => {
    const projectPath = writeTempProject(`
id: env-project
name: Env Project
model:
  provider: openai
  model: gpt-4o-mini
  apiKey: "+${'${OPENAI_TEST_KEY}'}"
  baseUrl: "${'${OPENAI_BASE_URL}'}/v1"
connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: "${'${COMPANY_API_BASE_URL}'}/api"
      auth:
        type: bearer
        token: "${'${COMPANY_API_TOKEN}'}"
      tools:
        - name: get_ticket
          description: Get ticket
          method: GET
          path: /tickets/detail
systemPrompt: "Use ${'${COMPANY_NAME}'} systems safely."
`);

    const project = ProjectLoader.load(projectPath, {
      env: {
        OPENAI_TEST_KEY: 'test-openai-key',
        OPENAI_BASE_URL: 'https://llm-gateway.example.com',
        COMPANY_API_BASE_URL: 'https://company.example.com',
        COMPANY_API_TOKEN: 'company-token',
        COMPANY_NAME: 'Acme',
      },
    });

    expect(project.model.apiKey).toBe('+test-openai-key');
    expect(project.model.baseUrl).toBe('https://llm-gateway.example.com/v1');
    expect(project.systemPrompt).toBe('Use Acme systems safely.');
    expect(project.connectors[0].config.baseUrl).toBe('https://company.example.com/api');
    expect((project.connectors[0].config.auth as { token: string }).token).toBe('company-token');
  });

  it('project 配置引用缺失环境变量时会抛出结构化错误', () => {
    const projectPath = writeTempProject(`
id: missing-env-project
name: Missing Env Project
model:
  provider: custom
  model: mock-model
connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: "${'${MISSING_COMPANY_API_BASE_URL}'}"
      tools:
        - name: get_ticket
          description: Get ticket
          method: GET
          path: /tickets/detail
`);

    expect(() => ProjectLoader.load(projectPath, { env: {} })).toThrowError(
      expect.objectContaining({
        code: 'PROJECT_CONFIG_ENV_VAR_MISSING',
        metadata: expect.objectContaining({ envVar: 'MISSING_COMPANY_API_BASE_URL' }),
      }),
    );
  });

  it('project 配置缺少基础字段时会返回 issues 列表', () => {
    const issues = expectInvalidProject(`
id: ''
model:
  provider: custom
connectors: {}
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'id' }),
        expect.objectContaining({ path: 'name' }),
        expect.objectContaining({ path: 'model.model' }),
        expect.objectContaining({ path: 'connectors' }),
      ]),
    );
  });

  it('project 配置会拒绝重复 connector id 和重复 API tool name', () => {
    const issues = expectInvalidProject(`
id: duplicate-project
name: Duplicate Project
model:
  provider: custom
  model: mock-model
connectors:
  - id: company-api
    type: api
    name: Company API A
    config:
      baseUrl: https://example-a.test
      tools:
        - name: get_ticket
          description: Get ticket
          method: GET
          path: /tickets/detail
  - id: company-api
    type: api
    name: Company API B
    config:
      baseUrl: https://example-b.test
      tools:
        - name: get_ticket
          description: Get ticket again
          method: GET
          path: /tickets/detail
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'connectors[1].id', message: expect.stringContaining('Duplicate connector id') }),
        expect.objectContaining({ path: 'connectors[1].config.tools[0].name', message: expect.stringContaining('Duplicate tool name') }),
      ]),
    );
  });

  it('project 配置会拒绝非法 API tool 结构', () => {
    const issues = expectInvalidProject(`
id: invalid-api-tool-project
name: Invalid API Tool Project
model:
  provider: custom
  model: mock-model
connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: https://example.test
      timeoutMs: 0
      auth:
        type: basic
      tools:
        - name: broken_tool
          method: TRACE
          timeoutMs: -1
          queryParams: ticketId
          parameters:
            ticketId:
              type: uuid
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'connectors[0].config.timeoutMs' }),
        expect.objectContaining({ path: 'connectors[0].config.auth.type' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].description' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].path' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].method' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].timeoutMs' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].queryParams' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.ticketId.type' }),
        expect.objectContaining({ path: 'connectors[0].config.tools[0].parameters.ticketId.description' }),
      ]),
    );
  });

  it('project 配置会拒绝未开启 confirmation 的写 API tool', () => {
    const issues = expectInvalidProject(`
id: unsafe-project
name: Unsafe Project
model:
  provider: custom
  model: mock-model
connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: https://example.test
      tools:
        - name: create_comment
          description: Create comment
          method: POST
          path: /tickets/comment
toolPolicy:
  requireConfirmation: false
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'connectors[0].config.tools[0].method',
          message: expect.stringContaining('set toolPolicy.requireConfirmation: true'),
        }),
      ]),
    );
  });

  it('不支持的模型 provider 会抛出结构化错误', () => {
    expect(() => ModelFactory.create({ provider: 'unknown' as never, model: 'x' })).toThrowError(
      expect.objectContaining({
        code: 'UNSUPPORTED_MODEL_PROVIDER',
      }),
    );
  });

  it('缺少 OpenAI key 时会抛出结构化错误', async () => {
    const model = new OpenAIModel({ provider: 'openai', model: 'gpt-4o-mini', envApiKey: '___MISSING_KEY___' });
    await expect(model.chat([])).rejects.toMatchObject<Partial<ConfigurationError>>({
      code: 'OPENAI_API_KEY_MISSING',
    });
  });

  it('API connector 缺少 baseUrl 时会抛出结构化错误', async () => {
    const connector = new ApiConnector();
    await expect(
      connector.initialize({
        id: 'broken-api',
        type: 'api',
        name: 'Broken API Connector',
        config: {
          tools: [
            {
              name: 'demo',
              description: 'demo',
              path: '/demo',
            },
          ],
        },
      }),
    ).rejects.toMatchObject<Partial<ConfigurationError>>({
      code: 'API_CONNECTOR_BASE_URL_MISSING',
    });
  });

  it('API connector 在未初始化时执行工具会抛出结构化错误', async () => {
    const connector = new ApiConnector();
    const direct = connector as unknown as {
      executeApiTool: (tool: { path: string }, args: Record<string, unknown>) => Promise<unknown>;
    };

    await expect(direct.executeApiTool({ path: '/x' }, {})).rejects.toMatchObject<Partial<ValidationError>>({
      code: 'API_CONNECTOR_NOT_INITIALIZED',
    });
  });

  it('API connector 会在请求超时时返回结构化失败结果', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ApiConnector();
    await connector.initialize({
      id: 'timeout-api',
      type: 'api',
      name: 'Timeout API Connector',
      config: {
        baseUrl: 'https://example.test',
        timeoutMs: 1000,
        tools: [
          {
            name: 'slow_tool',
            description: 'Slow tool',
            method: 'GET',
            path: '/slow',
          },
        ],
      },
    });

    const tool = connector.getTools()[0];
    const execution = tool.execute({}, {} as never);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await execution;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      error: 'HTTP request timed out after 1000ms',
      metadata: {
        url: 'https://example.test/slow',
        method: 'GET',
        timeout: true,
        timeoutMs: 1000,
      },
    });
  });

  it('服务启动自检会在 project 不存在时快速失败', async () => {
    await expect(
      startApiServer(['--project', path.resolve(process.cwd(), 'projects/example/not-found.yaml')])
    ).rejects.toMatchObject<Partial<ConfigurationError>>({
      code: 'PROJECT_CONFIG_NOT_FOUND',
    });
  });

  it('服务启动参数错误会抛出结构化错误', async () => {
    await expect(startApiServer(['--port', 'invalid'])).rejects.toMatchObject<Partial<ConfigurationError>>({
      code: 'SERVER_PORT_INVALID',
    });

    await expect(startApiServer(['--unknown'])).rejects.toMatchObject<Partial<ConfigurationError>>({
      code: 'SERVER_ARG_UNKNOWN',
    });
  });
});
