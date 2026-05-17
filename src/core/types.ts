import { AgentPersistence } from '../persistence/interfaces.js';

/**
 * agent-bridge - 核心类型定义
 * 定义 Agent、Tool、Connector 等核心接口
 */

// ============================================================================
// 消息类型
// ============================================================================

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

// ============================================================================
// 工具类型
// ============================================================================

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
}

export interface ToolDefinition {
  /** 工具唯一标识 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数定义 */
  parameters: Record<string, ToolParameter>;
  /** 执行函数 */
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  /** 是否需要确认 */
  requiresConfirmation?: boolean;
  /** 危险等级 */
  riskLevel?: 'low' | 'medium' | 'high';
  /** 所属连接器 */
  connectorId?: string;
}

export interface ToolContext {
  /** 当前会话ID */
  sessionId: string;
  /** 项目配置 */
  projectConfig: ProjectConfig;
  /** 运行时状态 */
  state: Map<string, unknown>;
  /** 日志记录器 */
  logger: Logger;
  /** 请求中止信号 */
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

// ============================================================================
// 连接器类型
// ============================================================================

export interface ConnectorConfig {
  /** 连接器ID */
  id: string;
  /** 连接器类型 */
  type: string;
  /** 连接器名称 */
  name: string;
  /** 连接器配置 */
  config: Record<string, unknown>;
  /** 启用的工具列表 */
  enabledTools?: string[];
  /** 禁用的工具列表 */
  disabledTools?: string[];
}

export interface Connector {
  /** 连接器ID */
  id: string;
  /** 连接器名称 */
  name: string;
  /** 连接器描述 */
  description: string;
  /** 初始化 */
  initialize(config: ConnectorConfig): Promise<void>;
  /** 获取可用工具 */
  getTools(): ToolDefinition[];
  /** 健康检查 */
  healthCheck(): Promise<boolean>;
  /** 销毁 */
  destroy(): Promise<void>;
}

export type ConnectorFactory = (config: ConnectorConfig) => Connector;

// ============================================================================
// 模型类型
// ============================================================================

export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'azure' | 'ollama' | 'custom';

export interface ModelConfig {
  /** 模型提供商 */
  provider: ModelProvider;
  /** 模型名称 */
  model: string;
  /** API Key */
  apiKey?: string;
  /** 从环境变量读取 API Key 的变量名 */
  envApiKey?: string;
  /** API Base URL */
  baseUrl?: string;
  /** 温度 */
  temperature?: number;
  /** 最大Token */
  maxTokens?: number;
  /** 其他参数 */
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
  /** 模型配置 */
  config: ModelConfig;
  /** 发送消息 */
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<ModelResponse>;
  /** 流式发送 */
  stream?(messages: Message[], tools?: ToolDefinition[]): AsyncIterableIterator<ModelResponse>;
}

// ============================================================================
// 项目配置
// ============================================================================

export interface ProjectConfig {
  /** 项目ID */
  id: string;
  /** 项目名称 */
  name: string;
  /** 项目描述 */
  description?: string;
  /** 模型配置 */
  model: ModelConfig;
  /** 连接器配置列表 */
  connectors: ConnectorConfig[];
  /** 系统提示词 */
  systemPrompt?: string;
  /** 工具调用策略 */
  toolPolicy?: {
    /** 最大连续调用次数 */
    maxConsecutiveCalls?: number;
    /** 是否需要确认 */
    requireConfirmation?: boolean;
    /** 允许的工具白名单 */
    allowedTools?: string[];
    /** 禁止的工具黑名单 */
    forbiddenTools?: string[];
    /** Tool-specific confirmation rules. Later rules override earlier rules. */
    confirmationRules?: Array<{
      tool: string;
      requireConfirmation: boolean;
    }>;
  };
  /** 记忆配置 */
  memory?: {
    /** 是否启用 */
    enabled?: boolean;
    /** 最大消息数 */
    maxMessages?: number;
    /** 记忆类型 */
    type?: 'sliding' | 'summary' | 'vector';
  };
  /** 其他配置 */
  extra?: Record<string, unknown>;
}

// ============================================================================
// Agent 类型
// ============================================================================

export interface AgentConfig {
  /** 项目配置 */
  project: ProjectConfig;
  /** 会话ID */
  sessionId?: string;
  /** 创建/拥有该会话的 actorId */
  actorId?: string;
  /** 调试模式 */
  debug?: boolean;
  /** 持久化适配器 */
  persistence?: AgentPersistence;
}

export interface AgentState {
  /** 会话ID */
  sessionId: string;
  /** 消息历史 */
  messages: Message[];
  /** 已加载的连接器 */
  connectors: Map<string, Connector>;
  /** 可用工具 */
  tools: Map<string, ToolDefinition>;
  /** 运行时状态 */
  state: Map<string, unknown>;
  /** 待确认请求 */
  pendingConfirmations: Map<string, ToolConfirmationRequest>;
  /** 是否正在运行 */
  isRunning: boolean;
}

export interface AgentRunResult {
  /** 最终响应 */
  response: string;
  /** 消息历史 */
  messages: Message[];
  /** 工具调用记录 */
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: ToolResult;
    duration: number;
  }>;
  /** 当前待确认请求 */
  pendingConfirmation?: ToolConfirmationRequest;
  /** Token 使用统计 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ============================================================================
// 工具类
// ============================================================================

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ============================================================================
// 事件类型
// ============================================================================

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