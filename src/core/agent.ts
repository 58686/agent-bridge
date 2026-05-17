/**
 * agent-bridge - Agent 基类实现
 */

import { v4 as uuidv4 } from 'uuid';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import {
  AgentConfig,
  AgentState,
  AgentRunResult,
  AgentEvent,
  AgentEventHandler,
  Message,
  ToolContext,
  ToolResult,
  ToolCall,
  Connector,
  ConnectorConfig,
  ChatModel,
  Logger,
  ToolConfirmationRequest,
  ToolConfirmationResolution,
} from './types.js';
import { validateToolArguments } from '../tools/validator.js';
import {
  AgentPersistence,
  NoopApprovalGrantRepository,
  NoopConfirmationRepository,
  NoopSessionRepository,
  NoopToolExecutionRepository,
} from '../persistence/interfaces.js';
import { ApprovalGrantRecord, SessionRecord, SessionRestoreState, SessionStatus } from '../persistence/types.js';

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000;

type RuntimePersistence = {
  sessions: NonNullable<AgentPersistence['sessions']>;
  confirmations: NonNullable<AgentPersistence['confirmations']>;
  approvalGrants: NonNullable<AgentPersistence['approvalGrants']>;
  toolExecutions: NonNullable<AgentPersistence['toolExecutions']>;
  auditEvents?: AgentPersistence['auditEvents'];
};

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected state: AgentState;
  protected model: ChatModel;
  protected logger: Logger;
  protected eventHandlers: Set<AgentEventHandler> = new Set();
  protected persistence: RuntimePersistence;

  constructor(config: AgentConfig) {
    this.config = config;
    this.state = {
      sessionId: config.sessionId || uuidv4(),
      messages: [],
      connectors: new Map(),
      tools: new Map(),
      state: new Map(),
      pendingConfirmations: new Map(),
      isRunning: false,
    };
    this.logger = this.createLogger();
    this.model = this.createModel(config.project.model);
    this.persistence = {
      sessions: config.persistence?.sessions ?? new NoopSessionRepository(),
      confirmations: config.persistence?.confirmations ?? new NoopConfirmationRepository(),
      approvalGrants: config.persistence?.approvalGrants ?? new NoopApprovalGrantRepository(),
      toolExecutions: config.persistence?.toolExecutions ?? new NoopToolExecutionRepository(),
      auditEvents: config.persistence?.auditEvents,
    };
  }

  protected abstract createModel(config: AgentConfig['project']['model']): ChatModel;

  protected abstract createLogger(): Logger;

  protected abstract createConnector(config: ConnectorConfig): Connector;

  protected buildInitialSystemMessages(): Message[] {
    const messages: Message[] = [];

    if (this.config.project.systemPrompt) {
      messages.push({
        role: 'system',
        content: this.config.project.systemPrompt,
      });
    }

    if (this.config.project.analysis) {
      messages.push({
        role: 'system',
        content: [
          'Analysis configuration JSON. Use these business rules as the source of truth when scoring or classifying analysis results:',
          JSON.stringify(this.config.project.analysis, null, 2),
        ].join('\n'),
      });
    }

    return messages;
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  get messages(): Message[] {
    return [...this.state.messages];
  }

  get pendingConfirmation(): ToolConfirmationRequest | undefined {
    return Array.from(this.state.pendingConfirmations.values())[0];
  }

  getPendingConfirmations(): ToolConfirmationRequest[] {
    return Array.from(this.state.pendingConfirmations.values());
  }

  async restoreSessionState(): Promise<SessionRestoreState> {
    const now = new Date().toISOString();
    await this.persistence.confirmations.expirePending(now);
    await this.persistence.approvalGrants.expireActive(now);
    await this.persistence.toolExecutions.markInterrupted(
      this.state.sessionId,
      now,
      'session restored after process interruption',
    );

    const [session, snapshot, pendingConfirmations, approvalGrants] = await Promise.all([
      this.persistence.sessions.getById(this.state.sessionId),
      this.persistence.sessions.loadSnapshot(this.state.sessionId),
      this.persistence.confirmations.listPending(this.state.sessionId),
      this.persistence.approvalGrants.listActive(this.state.sessionId),
    ]);

    if (snapshot) {
      this.state.messages = [...snapshot.messages];
    }

    this.state.pendingConfirmations.clear();
    for (const request of pendingConfirmations) {
      this.state.pendingConfirmations.set(request.id, {
        id: request.id,
        tool: request.tool,
        riskLevel: request.riskLevel,
        args: request.args,
        reason: request.reason,
        createdAt: request.createdAt,
        callId: request.callId,
      });
    }

    for (const key of Array.from(this.state.state.keys())) {
      if (key.startsWith('approved-confirmation:')) {
        this.state.state.delete(key);
      }
    }

    for (const grant of approvalGrants) {
      this.state.state.set(this.getApprovedConfirmationStateKey(grant.requestId), this.mapApprovalGrantToState(grant));
    }

    if (session) {
      const restoredStatus: SessionStatus = pendingConfirmations.length > 0
        ? 'waiting_confirmation'
        : session.status === 'running'
          ? 'failed'
          : session.status;

      if (restoredStatus !== session.status) {
        await this.persistence.sessions.updateStatus(this.state.sessionId, restoredStatus, {
          updatedAt: now,
          lastError: restoredStatus === 'failed'
            ? (session.lastError ?? 'Session interrupted before completion')
            : session.lastError,
        });
      }
    }

    return {
      session: session ?? undefined,
      snapshot: snapshot ?? undefined,
      pendingConfirmations: this.getPendingConfirmations(),
      approvalGrants,
    };
  }

  async approveConfirmation(
    requestId: string,
    reason?: string,
    actor?: string,
  ): Promise<ToolConfirmationResolution> {
    const request = this.state.pendingConfirmations.get(requestId);
    if (!request) {
      throw new NotFoundError(`Confirmation request not found: ${requestId}`, 'CONFIRMATION_NOT_FOUND', { requestId });
    }

    const persisted = await this.persistence.confirmations.getById(requestId);
    if (persisted?.status === 'expired') {
      this.state.pendingConfirmations.delete(requestId);
      throw new ValidationError(`Confirmation request has expired: ${requestId}`, 'CONFIRMATION_EXPIRED', { requestId });
    }

    const decidedAt = new Date().toISOString();

    await this.persistence.confirmations.markApproved(requestId, decidedAt);
    await this.persistence.confirmations.appendDecision({
      id: uuidv4(),
      requestId,
      sessionId: this.state.sessionId,
      decision: 'approved',
      actor,
      reason,
      createdAt: decidedAt,
    });
    await this.persistence.approvalGrants.createGrant({
      requestId,
      sessionId: this.state.sessionId,
      tool: request.tool,
      callId: request.callId,
      args: request.args,
      approvedAt: decidedAt,
      approvedBy: actor,
      reason,
    });

    this.state.pendingConfirmations.delete(requestId);
    this.state.state.set(this.getApprovedConfirmationStateKey(requestId), {
      requestId,
      tool: request.tool,
      callId: request.callId,
      args: request.args,
      approvedAt: decidedAt,
      approvedBy: actor,
      reason,
    });
    await this.persistSessionSnapshot(decidedAt);
    await this.persistence.sessions.updateStatus(this.state.sessionId, 'idle', {
      updatedAt: decidedAt,
    });

    const resolution: ToolConfirmationResolution = {
      requestId,
      approved: true,
      decidedAt,
      reason,
    };

    this.emit('confirmation_resolved', {
      request,
      resolution,
    });

    return resolution;
  }

  async rejectConfirmation(
    requestId: string,
    reason?: string,
    actor?: string,
  ): Promise<ToolConfirmationResolution> {
    const request = this.state.pendingConfirmations.get(requestId);
    if (!request) {
      throw new NotFoundError(`Confirmation request not found: ${requestId}`, 'CONFIRMATION_NOT_FOUND', { requestId });
    }

    const persisted = await this.persistence.confirmations.getById(requestId);
    if (persisted?.status === 'expired') {
      this.state.pendingConfirmations.delete(requestId);
      throw new ValidationError(`Confirmation request has expired: ${requestId}`, 'CONFIRMATION_EXPIRED', { requestId });
    }

    const decidedAt = new Date().toISOString();

    await this.persistence.confirmations.markRejected(requestId, decidedAt);
    await this.persistence.confirmations.appendDecision({
      id: uuidv4(),
      requestId,
      sessionId: this.state.sessionId,
      decision: 'rejected',
      actor,
      reason,
      createdAt: decidedAt,
    });

    this.state.pendingConfirmations.delete(requestId);
    this.state.state.delete(this.getApprovedConfirmationStateKey(requestId));
    await this.persistSessionSnapshot(decidedAt);
    await this.persistence.sessions.updateStatus(this.state.sessionId, 'idle', {
      updatedAt: decidedAt,
    });

    const resolution: ToolConfirmationResolution = {
      requestId,
      approved: false,
      decidedAt,
      reason,
    };

    this.emit('confirmation_resolved', {
      request,
      resolution,
    });

    return resolution;
  }

  on(handler: AgentEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async initialize(): Promise<void> {
    for (const connectorConfig of this.config.project.connectors) {
      await this.loadConnector(connectorConfig);
    }

    const existingSession = this.config.sessionId
      ? await this.persistence.sessions.getById(this.state.sessionId)
      : null;

    if (existingSession) {
      await this.restoreSessionState();
    } else {
      this.state.messages.push(...this.buildInitialSystemMessages());

      const now = new Date().toISOString();
      await this.persistence.sessions.create({
        id: this.state.sessionId,
        projectId: this.config.project.id,
        actorId: this.config.actorId,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      });
      await this.persistSessionSnapshot(now);
    }

    this.logger.info(`Agent initialized with ${this.state.tools.size} tools`);
  }

  async run(input: string): Promise<AgentRunResult> {
    if (this.state.isRunning) {
      throw new ConflictError('Agent is already running', 'AGENT_ALREADY_RUNNING', { sessionId: this.state.sessionId });
    }

    this.state.isRunning = true;
    const startedAt = new Date().toISOString();
    await this.persistence.sessions.updateStatus(this.state.sessionId, 'running', {
      updatedAt: startedAt,
      lastInput: input,
      lastError: undefined,
    });

    try {
      this.emit('start', { input });
      this.state.messages.push({ role: 'user', content: input });
      return await this.continueRunLoop();
    } catch (error) {
      const failedAt = new Date().toISOString();
      await this.persistSessionSnapshot(failedAt);
      await this.persistence.sessions.updateStatus(this.state.sessionId, 'failed', {
        updatedAt: failedAt,
        lastInput: input,
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.emit('error', { error });
      throw error;
    } finally {
      this.state.isRunning = false;
    }
  }

  async resume(): Promise<AgentRunResult> {
    if (this.state.isRunning) {
      throw new ConflictError('Agent is already running', 'AGENT_ALREADY_RUNNING', { sessionId: this.state.sessionId });
    }

    const session = await this.persistence.sessions.getById(this.state.sessionId);
    const lastInput = session?.lastInput;
    if (!lastInput) {
      throw new ValidationError(`Session cannot be resumed without lastInput: ${this.state.sessionId}`, 'SESSION_LAST_INPUT_MISSING', {
        sessionId: this.state.sessionId,
      });
    }

    const resumableFrame = await this.findResumableToolCallFrame();
    if (!resumableFrame) {
      return this.run(lastInput);
    }

    this.state.isRunning = true;
    const startedAt = new Date().toISOString();
    await this.persistence.sessions.updateStatus(this.state.sessionId, 'running', {
      updatedAt: startedAt,
      lastInput,
      lastError: undefined,
    });

    try {
      this.emit('start', { input: lastInput, resumed: true });
      return await this.continueRunLoop();
    } catch (error) {
      const failedAt = new Date().toISOString();
      await this.persistSessionSnapshot(failedAt);
      await this.persistence.sessions.updateStatus(this.state.sessionId, 'failed', {
        updatedAt: failedAt,
        lastInput,
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.emit('error', { error });
      throw error;
    } finally {
      this.state.isRunning = false;
    }
  }

  protected async continueRunLoop(): Promise<AgentRunResult> {
    const toolCallRecords: AgentRunResult['toolCalls'] = [];
    let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let shouldContinue = true;
    let iterations = 0;
    const maxIterations = this.config.project.toolPolicy?.maxConsecutiveCalls || 10;

    while (shouldContinue && iterations < maxIterations) {
      iterations++;

      const resumableFrame = await this.findResumableToolCallFrame();

      if (resumableFrame) {
        if (resumableFrame.pendingConfirmationId) {
          this.state.pendingConfirmations.delete(resumableFrame.pendingConfirmationId);
        }

        for (const toolCall of resumableFrame.toolCalls) {
          const result = await this.executeTool(toolCall.name, toolCall.arguments, toolCall.id);

          toolCallRecords.push({
            tool: toolCall.name,
            args: toolCall.arguments,
            result: result.result,
            duration: result.duration,
          });

          this.state.messages.push({
            role: 'tool',
            content: JSON.stringify(result.result),
            name: toolCall.name,
            toolCallId: toolCall.id,
          });

          if (result.result.metadata?.confirmationRequired) {
            shouldContinue = false;
            break;
          }
        }

        if (!shouldContinue) {
          break;
        }

        continue;
      }

      const response = await this.model.chat(
        this.state.messages,
        Array.from(this.state.tools.values())
      );

      if (response.usage) {
        totalUsage.promptTokens += response.usage.promptTokens;
        totalUsage.completionTokens += response.usage.completionTokens;
        totalUsage.totalTokens += response.usage.totalTokens;
      }

      this.state.messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      this.emit('message', { content: response.content, toolCalls: response.toolCalls });

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const toolCall of response.toolCalls) {
          const result = await this.executeTool(toolCall.name, toolCall.arguments, toolCall.id);

          toolCallRecords.push({
            tool: toolCall.name,
            args: toolCall.arguments,
            result: result.result,
            duration: result.duration,
          });

          this.state.messages.push({
            role: 'tool',
            content: JSON.stringify(result.result),
            name: toolCall.name,
            toolCallId: toolCall.id,
          });

          if (result.result.metadata?.confirmationRequired) {
            shouldContinue = false;
            break;
          }
        }
      } else {
        shouldContinue = false;
      }

      if (response.finishReason === 'stop' || response.finishReason === 'error') {
        shouldContinue = false;
      }
    }

    const session = await this.persistence.sessions.getById(this.state.sessionId);
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    const finalResponse = lastMessage?.role === 'assistant' ? lastMessage.content : '';
    const pendingConfirmation = this.pendingConfirmation;
    const completedAt = new Date().toISOString();

    await this.persistSessionSnapshot(completedAt);
    await this.persistence.sessions.updateStatus(
      this.state.sessionId,
      pendingConfirmation ? 'waiting_confirmation' : 'completed',
      {
        updatedAt: completedAt,
        lastInput: session?.lastInput,
      },
    );

    this.emit('end', { response: finalResponse, pendingConfirmation });

    return {
      response: finalResponse,
      messages: this.state.messages,
      toolCalls: toolCallRecords,
      pendingConfirmation,
      usage: totalUsage,
    };
  }

  protected async findResumableToolCallFrame(): Promise<{
    pendingConfirmationId?: string;
    toolCalls: ToolCall[];
  } | null> {
    const lastAssistantWithToolCalls = [...this.state.messages].reverse().find(
      (message) => message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0,
    );
    if (!lastAssistantWithToolCalls?.toolCalls?.length) {
      return null;
    }

    const pendingConfirmation = this.pendingConfirmation;
    if (pendingConfirmation?.callId) {
      const resumableToolCalls = lastAssistantWithToolCalls.toolCalls.filter(
        (toolCall) => toolCall.id === pendingConfirmation.callId,
      );
      if (resumableToolCalls.length > 0) {
        return {
          pendingConfirmationId: pendingConfirmation.id,
          toolCalls: resumableToolCalls,
        };
      }
    }

    const resumableByGrant = await Promise.all(
      lastAssistantWithToolCalls.toolCalls.map(async (toolCall) => {
        const persistedGrant = await this.persistence.approvalGrants.findMatchingGrant(
          this.state.sessionId,
          toolCall.name,
          toolCall.id,
          toolCall.arguments,
        );
        return persistedGrant ? toolCall : null;
      }),
    );
    const approvedToolCalls = resumableByGrant.filter((toolCall): toolCall is ToolCall => Boolean(toolCall));
    if (approvedToolCalls.length > 0) {
      return {
        toolCalls: approvedToolCalls,
      };
    }

    return null;
  }

  async *stream(input: string): AsyncIterableIterator<string> {
    if (!this.model.stream) {
      const result = await this.run(input);
      yield result.response;
      return;
    }

    this.state.isRunning = true;
    try {
      this.state.messages.push({ role: 'user', content: input });

      for await (const chunk of this.model.stream(
        this.state.messages,
        Array.from(this.state.tools.values())
      )) {
        if (chunk.content) {
          yield chunk.content;
        }
      }
    } finally {
      this.state.isRunning = false;
    }
  }

  async clearHistory(): Promise<void> {
    const systemMessages = this.state.messages.filter((message) => message.role === 'system');
    this.state.messages = systemMessages;
    await this.persistSessionSnapshot();
  }

  async destroy(): Promise<void> {
    await this.persistSessionSnapshot();

    const now = new Date().toISOString();
    const persisted = await this.persistence.sessions.getById(this.state.sessionId);
    const nextStatus: SessionStatus | undefined = this.pendingConfirmation
      ? 'waiting_confirmation'
      : persisted?.status === 'running'
        ? 'failed'
        : undefined;

    if (nextStatus) {
      await this.persistence.sessions.updateStatus(this.state.sessionId, nextStatus, {
        updatedAt: now,
        lastError: nextStatus === 'failed'
          ? (persisted?.lastError ?? 'Session interrupted before completion')
          : persisted?.lastError,
      });
    }

    for (const connector of this.state.connectors.values()) {
      await connector.destroy();
    }
    this.state.connectors.clear();
    this.state.tools.clear();
  }

  protected async loadConnector(config: ConnectorConfig): Promise<void> {
    const connector = this.createConnector(config);
    await connector.initialize(config);

    this.state.connectors.set(config.id, connector);

    const tools = connector.getTools();
    for (const tool of tools) {
      if (config.enabledTools && !config.enabledTools.includes(tool.name)) {
        continue;
      }
      if (config.disabledTools?.includes(tool.name)) {
        continue;
      }

      tool.connectorId = config.id;
      this.state.tools.set(tool.name, tool);
    }

    this.logger.info(`Loaded connector: ${config.id} with ${tools.length} tools`);
  }

  protected async executeTool(
    name: string,
    args: Record<string, unknown>,
    callId: string
  ): Promise<{ result: ToolResult; duration: number }> {
    const tool = this.state.tools.get(name);
    if (!tool) {
      return {
        result: { success: false, error: `Tool not found: ${name}` },
        duration: 0,
      };
    }

    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    await this.persistence.toolExecutions.create({
      id: callId,
      sessionId: this.state.sessionId,
      tool: name,
      callId,
      args,
      status: 'started',
      startedAt,
    });
    this.emit('tool_call', { name, args, callId });

    try {
      const validation = validateToolArguments(args, tool.parameters);
      if (!validation.valid) {
        const result: ToolResult = {
          success: false,
          error: `Tool argument validation failed for ${name}`,
          metadata: {
            issues: validation.issues,
          },
        };
        const duration = Date.now() - startTime;
        await this.persistence.toolExecutions.finish(callId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: duration,
          error: result.error,
          result: { metadata: result.metadata as Record<string, unknown> },
        });
        this.emit('tool_result', { name, args, result, duration });
        return { result, duration };
      }

      const approvedRequestId = await this.consumeApprovedConfirmation(tool.name, validation.normalizedArgs, callId);
      const confirmation = await this.evaluateToolConfirmation(
        tool.name,
        tool.riskLevel,
        validation.normalizedArgs,
        callId,
        approvedRequestId,
      );
      if (confirmation) {
        this.state.pendingConfirmations.set(confirmation.id, confirmation);
        await this.persistence.confirmations.createRequest({
          id: confirmation.id,
          sessionId: this.state.sessionId,
          projectId: this.config.project.id,
          tool: confirmation.tool,
          riskLevel: confirmation.riskLevel,
          args: confirmation.args,
          reason: confirmation.reason,
          callId: confirmation.callId,
          status: 'pending',
          createdAt: confirmation.createdAt,
          updatedAt: confirmation.createdAt,
          expiresAt: new Date(Date.now() + this.getConfirmationTimeoutMs()).toISOString(),
        });
        await this.persistence.sessions.updateStatus(this.state.sessionId, 'waiting_confirmation', {
          updatedAt: confirmation.createdAt,
        });
        this.emit('confirmation_requested', confirmation);

        const result: ToolResult = {
          success: false,
          error: confirmation.reason,
          metadata: {
            confirmationRequired: true,
            request: confirmation,
          },
        };
        const duration = Date.now() - startTime;
        await this.persistence.toolExecutions.finish(callId, {
          status: 'waiting_confirmation',
          finishedAt: new Date().toISOString(),
          durationMs: duration,
          error: result.error,
          result: {
            confirmationRequired: true,
            requestId: confirmation.id,
          },
        });
        this.emit('tool_result', { name, args: validation.normalizedArgs, result, duration });
        return { result, duration };
      }

      const context: ToolContext = {
        sessionId: this.state.sessionId,
        projectConfig: this.config.project,
        state: this.state.state,
        logger: this.logger,
      };

      const result = await tool.execute(validation.normalizedArgs, context);
      const duration = Date.now() - startTime;
      await this.persistence.toolExecutions.finish(callId, {
        status: result.success ? 'finished' : 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: duration,
        error: result.error,
        result: {
          success: result.success,
          metadata: (result.metadata ?? {}) as Record<string, unknown>,
          data: result.data as unknown,
        } as Record<string, unknown>,
      });

      this.emit('tool_result', { name, args: validation.normalizedArgs, result, duration });

      return { result, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      const result: ToolResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.persistence.toolExecutions.finish(callId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: duration,
        error: result.error,
        result: undefined,
      });

      this.emit('tool_result', { name, args, result, duration });

      return { result, duration };
    }
  }

  protected getConfirmationTimeoutMs(): number {
    return this.config.project.toolPolicy?.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  }

  protected getToolConfirmationRequirement(toolName: string): boolean {
    const policy = this.config.project.toolPolicy;
    let requirement = policy?.requireConfirmation ?? false;

    for (const rule of policy?.confirmationRules ?? []) {
      if (rule.tool === toolName) {
        requirement = rule.requireConfirmation;
      }
    }

    return requirement;
  }

  protected async evaluateToolConfirmation(
    toolName: string,
    riskLevel: 'low' | 'medium' | 'high' = 'low',
    args: Record<string, unknown>,
    callId?: string,
    approvedRequestId?: string
  ): Promise<ToolConfirmationRequest | null> {
    const policy = this.config.project.toolPolicy;
    const requireConfirmation = this.getToolConfirmationRequirement(toolName);
    const allowedHighRiskTools = policy?.allowedTools ?? [];

    const needsConfirmation = requireConfirmation || riskLevel === 'high';

    if (!needsConfirmation) {
      return null;
    }

    const explicitlyAllowed = Boolean(approvedRequestId) || allowedHighRiskTools.includes(toolName);
    if (explicitlyAllowed) {
      return null;
    }

    const existingRequest = Array.from(this.state.pendingConfirmations.values()).find(
      (request) =>
        request.tool === toolName &&
        request.callId === callId &&
        this.areArgsEqual(request.args, args)
    );
    if (existingRequest) {
      return existingRequest;
    }

    const persistedRequest = await this.persistence.confirmations.findPendingMatch(
      this.state.sessionId,
      toolName,
      callId,
      args,
    );
    if (persistedRequest) {
      const restoredRequest: ToolConfirmationRequest = {
        id: persistedRequest.id,
        tool: persistedRequest.tool,
        riskLevel: persistedRequest.riskLevel,
        args: persistedRequest.args,
        reason: persistedRequest.reason,
        createdAt: persistedRequest.createdAt,
        callId: persistedRequest.callId,
      };
      this.state.pendingConfirmations.set(restoredRequest.id, restoredRequest);
      return restoredRequest;
    }

    return {
      id: uuidv4(),
      tool: toolName,
      riskLevel,
      args,
      reason: `Tool ${toolName} requires confirmation before execution`,
      createdAt: new Date().toISOString(),
      callId,
    };
  }

  protected async consumeApprovedConfirmation(
    toolName: string,
    args: Record<string, unknown>,
    callId?: string
  ): Promise<string | undefined> {
    for (const [key, value] of this.state.state.entries()) {
      if (!key.startsWith('approved-confirmation:')) {
        continue;
      }

      const approval = value as {
        requestId?: string;
        tool?: string;
        callId?: string;
        args?: Record<string, unknown>;
      };

      if (
        approval.requestId &&
        approval.tool === toolName &&
        approval.callId === callId &&
        this.areArgsEqual(approval.args ?? {}, args)
      ) {
        const consumedAt = new Date().toISOString();
        await this.persistence.approvalGrants.consumeGrant(approval.requestId, consumedAt);
        await this.persistence.confirmations.markConsumed(approval.requestId, consumedAt);
        this.state.state.delete(key);
        return approval.requestId;
      }
    }

    const persistedGrant = await this.persistence.approvalGrants.findMatchingGrant(
      this.state.sessionId,
      toolName,
      callId,
      args,
    );
    if (!persistedGrant) {
      return undefined;
    }

    const consumedAt = new Date().toISOString();
    await this.persistence.approvalGrants.consumeGrant(persistedGrant.requestId, consumedAt);
    await this.persistence.confirmations.markConsumed(persistedGrant.requestId, consumedAt);
    return persistedGrant.requestId;
  }

  protected getApprovedConfirmationStateKey(requestId: string): string {
    return `approved-confirmation:${requestId}`;
  }

  protected mapApprovalGrantToState(grant: ApprovalGrantRecord): {
    requestId: string;
    tool: string;
    callId?: string;
    args: Record<string, unknown>;
    approvedAt: string;
    reason?: string;
  } {
    return {
      requestId: grant.requestId,
      tool: grant.tool,
      callId: grant.callId,
      args: grant.args,
      approvedAt: grant.approvedAt,
      reason: grant.reason,
    };
  }

  protected async persistSessionSnapshot(updatedAt = new Date().toISOString()): Promise<void> {
    await this.persistence.sessions.saveSnapshot({
      sessionId: this.state.sessionId,
      messages: [...this.state.messages],
      updatedAt,
    });
  }

  protected async persistSessionStatus(
    status: SessionStatus,
    patch?: Partial<Pick<SessionRecord, 'updatedAt' | 'lastInput' | 'lastError'>>,
  ): Promise<void> {
    await this.persistence.sessions.updateStatus(this.state.sessionId, status, patch);
  }

  protected areArgsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  protected emit(type: AgentEvent['type'], data: unknown): void {
    const event: AgentEvent = {
      type,
      data,
      timestamp: new Date(),
    };

    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error('Event handler error:', error);
      }
    }
  }
}
