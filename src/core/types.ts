import { AgentPersistence } from '../persistence/interfaces.js';

/**
 * Core type definitions for agent-bridge.
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
}

export interface ToolDefinition {
  /** Unique tool name exposed to the model. */
  name: string;
  /** Human-readable tool description. */
  description: string;
  /** Tool argument schema. */
  parameters: Record<string, ToolParameter>;
  /** Tool execution function. */
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  /** Whether this tool requires explicit confirmation. */
  requiresConfirmation?: boolean;
  /** Risk level used by the approval policy. */
  riskLevel?: 'low' | 'medium' | 'high';
  /** Connector that owns this tool. */
  connectorId?: string;
}

export interface ToolContext {
  /** Current session id. */
  sessionId: string;
  /** Project configuration. */
  projectConfig: ProjectConfig;
  /** Runtime state shared within the session. */
  state: Map<string, unknown>;
  /** Runtime logger. */
  logger: Logger;
  /** Optional cancellation signal for long-running tools. */
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolConfirmationRequest {
  id: string;
  tool: string;
  riskLevel: 'low' | 'medium' | 'high';
  args: Record<string, unknown>;
  reason: string;
  createdAt: string;
  callId?: string;
}

export interface ToolConfirmationResolution {
  requestId: string;
  approved: boolean;
  decidedAt: string;
  reason?: string;
}

export interface ConnectorConfig {
  /** Connector id. */
  id: string;
  /** Connector type, for example api or echo. */
  type: string;
  /** Display name. */
  name: string;
  /** Connector-specific configuration. */
  config: Record<string, unknown>;
  /** Optional allow-list for exposed tools. */
  enabledTools?: string[];
  /** Optional block-list for exposed tools. */
  disabledTools?: string[];
}

export interface Connector {
  /** Connector id. */
  id: string;
  /** Display name. */
  name: string;
  /** Description shown to operators. */
  description: string;
  /** Initialize the connector from project config. */
  initialize(config: ConnectorConfig): Promise<void>;
  /** Return tools exposed by this connector. */
  getTools(): ToolDefinition[];
  /** Lightweight health check. */
  healthCheck(): Promise<boolean>;
  /** Release connector resources. */
  destroy(): Promise<void>;
}

export type ConnectorFactory = (config: ConnectorConfig) => Connector;

export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'azure' | 'ollama' | 'custom';

export interface ModelConfig {
  /** Model provider. Currently custom and openai are implemented. */
  provider: ModelProvider;
  /** Model name. */
  model: string;
  /** Inline API key. Prefer envApiKey for real deployments. */
  apiKey?: string;
  /** Environment variable name that stores the API key. */
  envApiKey?: string;
  /** API base URL. OpenAI-compatible gateways can be used here. */
  baseUrl?: string;
  /** Sampling temperature. */
  temperature?: number;
  /** Maximum output tokens. */
  maxTokens?: number;
  /** HTTP timeout for model calls, in milliseconds. */
  timeoutMs?: number;
  /** Provider-specific options. */
  extra?: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'tool_call' | 'length' | 'error';
}

export interface ChatModel {
  /** Model configuration. */
  config: ModelConfig;
  /** Send messages to the model. */
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<ModelResponse>;
  /** Optional streaming interface. */
  stream?(messages: Message[], tools?: ToolDefinition[]): AsyncIterableIterator<ModelResponse>;
}

export interface AnalysisCondition {
  /** Value must be greater than or equal to this threshold. */
  gte?: number;
  /** Value must be less than or equal to this threshold. */
  lte?: number;
  /** Value must equal this value. */
  eq?: string | number | boolean;
}

export interface AnalysisLevelRule {
  /** Output score level, for example excellent or qualified. */
  level: string;
  /** Risk level to save with this level. */
  riskLevel: 'low' | 'medium' | 'high';
  /** Metric conditions that must all match. */
  when: Record<string, AnalysisCondition>;
  /** Suggested next actions for this level. */
  recommendations?: string[];
}

export interface AnalysisConfig {
  /** Business standard id used in saved results. */
  standardId?: string;
  /** Ordered rules. The first matching rule wins. */
  levels?: AnalysisLevelRule[];
  /** Fallback when no level rule matches. */
  fallback?: {
    level?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    recommendations?: string[];
  };
}

export interface ProjectConfig {
  /** Project id. */
  id: string;
  /** Project display name. */
  name: string;
  /** Project description. */
  description?: string;
  /** Model configuration. */
  model: ModelConfig;
  /** Connector configurations. */
  connectors: ConnectorConfig[];
  /** System prompt sent to the model. */
  systemPrompt?: string;
  /** Optional analysis rules injected into the model context. */
  analysis?: AnalysisConfig;
  /** Tool execution policy. */
  toolPolicy?: {
    /** Maximum consecutive model/tool loop iterations. */
    maxConsecutiveCalls?: number;
    /** Whether all tools require confirmation. */
    requireConfirmation?: boolean;
    /** Confirmation request expiry timeout in milliseconds. Defaults to 15 minutes. */
    confirmationTimeoutMs?: number;
    /** Legacy allow-list that can bypass confirmation for named tools. */
    allowedTools?: string[];
    /** Block-list for named tools. */
    forbiddenTools?: string[];
    /** Tool-specific confirmation rules. Later rules override earlier rules. */
    confirmationRules?: Array<{
      tool: string;
      requireConfirmation: boolean;
    }>;
  };
  /** Session memory configuration. */
  memory?: {
    /** Whether memory is enabled. */
    enabled?: boolean;
    /** Maximum message count retained by sliding memory. */
    maxMessages?: number;
    /** Memory strategy. */
    type?: 'sliding' | 'summary' | 'vector';
  };
  /** Extra project-specific configuration. */
  extra?: Record<string, unknown>;
}

export interface AgentConfig {
  /** Project configuration. */
  project: ProjectConfig;
  /** Existing or new session id. */
  sessionId?: string;
  /** Actor that owns the session. */
  actorId?: string;
  /** Debug mode flag. */
  debug?: boolean;
  /** Optional persistence adapter. */
  persistence?: AgentPersistence;
}

export interface AgentState {
  /** Current session id. */
  sessionId: string;
  /** Message history. */
  messages: Message[];
  /** Loaded connectors. */
  connectors: Map<string, Connector>;
  /** Available tools. */
  tools: Map<string, ToolDefinition>;
  /** Runtime state. */
  state: Map<string, unknown>;
  /** Pending confirmation requests. */
  pendingConfirmations: Map<string, ToolConfirmationRequest>;
  /** Whether the agent is currently running. */
  isRunning: boolean;
}

export interface AgentRunResult {
  /** Final assistant response. */
  response: string;
  /** Message history. */
  messages: Message[];
  /** Tool execution records from this run. */
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: ToolResult;
    duration: number;
  }>;
  /** Current pending confirmation, if any. */
  pendingConfirmation?: ToolConfirmationRequest;
  /** Token usage reported by the model. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export type AgentEventType =
  | 'start'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'confirmation_requested'
  | 'confirmation_resolved'
  | 'error'
  | 'end';

export interface AgentEvent {
  type: AgentEventType;
  data: unknown;
  timestamp: Date;
}

export type AgentEventHandler = (event: AgentEvent) => void;
