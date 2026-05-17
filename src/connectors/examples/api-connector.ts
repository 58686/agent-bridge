import {
  Connector,
  ConnectorConfig,
  ToolDefinition,
  ToolParameter,
  ToolResult,
} from '../../core/types.js';
import { ConfigurationError, ValidationError } from '../../errors.js';

interface ApiConnectorAuthConfig {
  type?: 'none' | 'bearer' | 'apiKey';
  token?: string;
  apiKey?: string;
  headerName?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface ApiToolConfig {
  name: string;
  description: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  queryParams?: string[];
  bodyParams?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  parameters?: Record<string, ToolParameter>;
}

interface ApiConnectorOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  auth?: ApiConnectorAuthConfig;
  timeoutMs: number;
  tools: ApiToolConfig[];
}

export class ApiConnector implements Connector {
  id = 'api';
  name = 'API Connector';
  description = '一个通用 REST API 连接器，用于快速对接公司内部 HTTP 服务。';

  private config?: ConnectorConfig;
  private options?: ApiConnectorOptions;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    this.options = this.parseOptions(config.config);
  }

  getTools(): ToolDefinition[] {
    const tools = this.options?.tools ?? [];

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {},
      execute: async (args) => this.executeApiTool(tool, args),
      riskLevel: this.inferRiskLevel(tool.method),
    }));
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(this.options?.baseUrl);
  }

  async destroy(): Promise<void> {
    return;
  }

  private parseOptions(config: Record<string, unknown>): ApiConnectorOptions {
    const baseUrl = String(config.baseUrl ?? '').trim();
    if (!baseUrl) {
      throw new ConfigurationError('API connector requires config.baseUrl', 'API_CONNECTOR_BASE_URL_MISSING');
    }

    const tools = Array.isArray(config.tools) ? (config.tools as ApiToolConfig[]) : [];
    if (tools.length === 0) {
      throw new ConfigurationError('API connector requires at least one tool in config.tools', 'API_CONNECTOR_TOOLS_MISSING');
    }

    return {
      baseUrl,
      defaultHeaders: this.toStringRecord(config.defaultHeaders),
      auth: this.normalizeAuth(config.auth),
      timeoutMs: this.normalizeRequiredTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS),
      tools: tools.map((tool) => ({
        ...tool,
        timeoutMs: this.normalizeOptionalTimeoutMs(tool.timeoutMs),
      })),
    };
  }

  private normalizeAuth(input: unknown): ApiConnectorAuthConfig | undefined {
    if (!input || typeof input !== 'object') {
      return undefined;
    }

    const auth = input as Record<string, unknown>;
    return {
      type: (auth.type as ApiConnectorAuthConfig['type']) ?? 'none',
      token: auth.token ? String(auth.token) : undefined,
      apiKey: auth.apiKey ? String(auth.apiKey) : undefined,
      headerName: auth.headerName ? String(auth.headerName) : undefined,
    };
  }

  private toStringRecord(input: unknown): Record<string, string> | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return undefined;
    }

    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, String(value)])
    );
  }

  private normalizeRequiredTimeoutMs(input: unknown, fallback: number): number {
    const normalized = this.normalizeOptionalTimeoutMs(input);
    return normalized ?? fallback;
  }

  private normalizeOptionalTimeoutMs(input: unknown): number | undefined {
    if (input === undefined || input === null || input === '') {
      return undefined;
    }

    const value = Number(input);
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }

    return Math.floor(value);
  }

  private async executeApiTool(
    tool: ApiToolConfig,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    if (!this.options) {
      throw new ValidationError('API connector is not initialized', 'API_CONNECTOR_NOT_INITIALIZED');
    }

    const method = tool.method ?? 'GET';
    const url = new URL(tool.path, this.options.baseUrl.endsWith('/') ? this.options.baseUrl : `${this.options.baseUrl}/`);

    for (const key of tool.queryParams ?? []) {
      const value = args[key];
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.options.defaultHeaders ?? {}),
      ...(tool.headers ?? {}),
    };

    if (this.options.auth?.type === 'bearer' && this.options.auth.token) {
      headers.authorization = `Bearer ${this.options.auth.token}`;
    }

    if (this.options.auth?.type === 'apiKey' && this.options.auth.apiKey) {
      headers[this.options.auth.headerName || 'x-api-key'] = this.options.auth.apiKey;
    }

    let body: string | undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      const payload: Record<string, unknown> = {};
      for (const key of tool.bodyParams ?? []) {
        if (args[key] !== undefined) {
          payload[key] = args[key];
        }
      }
      body = JSON.stringify(payload);
    }

    const timeoutMs = tool.timeoutMs ?? this.options.timeoutMs;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return {
          success: false,
          error: `HTTP request timed out after ${timeoutMs}ms`,
          metadata: {
            url: url.toString(),
            method,
            timeout: true,
            timeoutMs,
          },
        };
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();
    const parsed = this.tryParseJson(responseText);

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status} ${response.statusText}`,
        data: parsed,
        metadata: {
          url: url.toString(),
          method,
          status: response.status,
        },
      };
    }

    return {
      success: true,
      data: parsed,
      metadata: {
        url: url.toString(),
        method,
        status: response.status,
      },
    };
  }

  private tryParseJson(text: string): unknown {
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private inferRiskLevel(method: ApiToolConfig['method']): 'low' | 'medium' | 'high' {
    switch (method) {
      case 'DELETE':
        return 'high';
      case 'POST':
      case 'PUT':
      case 'PATCH':
        return 'medium';
      default:
        return 'low';
    }
  }
}
