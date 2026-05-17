import {
  ChatModel,
  Message,
  ModelConfig,
  ModelResponse,
  ToolDefinition,
  ToolCall,
} from '../core/types.js';
import { ConfigurationError, ValidationError } from '../errors.js';

interface OpenAIChatCompletionChoice {
  message: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

interface OpenAIChatCompletionResponse {
  choices: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIModel implements ChatModel {
  config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ModelResponse> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new ConfigurationError(
        'OpenAI API key is missing. Set model.apiKey or model.envApiKey.',
        'OPENAI_API_KEY_MISSING',
        { model: this.config.model, provider: this.config.provider }
      );
    }

    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature ?? 0.2,
        max_tokens: this.config.maxTokens,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
          name: message.name,
          tool_call_id: message.toolCallId,
          tool_calls: message.toolCalls?.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments),
            },
          })),
        })),
        tools: (tools ?? []).length > 0
          ? (tools ?? []).map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: this.toJsonSchema(tool.parameters),
              },
            }))
          : undefined,
      }),
    });

    const rawText = await response.text();
    const payload = this.tryParseJson(rawText) as OpenAIChatCompletionResponse | string;

    if (!response.ok) {
      throw new ValidationError(
        `OpenAI request failed: HTTP ${response.status} ${response.statusText} - ${rawText}`,
        'OPENAI_REQUEST_FAILED',
        {
          status: response.status,
          statusText: response.statusText,
          model: this.config.model,
          baseUrl,
        }
      );
    }

    if (typeof payload === 'string') {
      throw new ValidationError('OpenAI response is not valid JSON', 'OPENAI_RESPONSE_INVALID_JSON', {
        model: this.config.model,
        baseUrl,
      });
    }

    const choice = payload.choices?.[0];
    if (!choice) {
      throw new ValidationError('OpenAI response contains no choices', 'OPENAI_RESPONSE_EMPTY_CHOICES', {
        model: this.config.model,
        baseUrl,
      });
    }

    const toolCalls = this.parseToolCalls(choice.message.tool_calls);
    return {
      content: choice.message.content ?? '',
      toolCalls,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
      finishReason: this.mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    };
  }

  private resolveApiKey(): string | undefined {
    if (this.config.apiKey) {
      return this.config.apiKey;
    }

    if (this.config.envApiKey) {
      return process.env[this.config.envApiKey];
    }

    return process.env.OPENAI_API_KEY;
  }

  private parseToolCalls(
    toolCalls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>
  ): ToolCall[] {
    return (toolCalls ?? []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: this.safeParseArguments(toolCall.function.arguments),
    }));
  }

  private safeParseArguments(value: string): Record<string, unknown> {
    if (!value) {
      return {};
    }

    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: value };
    }
  }

  private mapFinishReason(
    reason: OpenAIChatCompletionChoice['finish_reason'],
    hasToolCalls: boolean
  ): ModelResponse['finishReason'] {
    if (hasToolCalls || reason === 'tool_calls') {
      return 'tool_call';
    }

    if (reason === 'length') {
      return 'length';
    }

    if (reason === 'stop' || reason === null) {
      return 'stop';
    }

    return 'error';
  }

  private toJsonSchema(parameters: ToolDefinition['parameters']): Record<string, unknown> {
    const required = Object.entries(parameters)
      .filter(([, value]) => value.required)
      .map(([key]) => key);

    const properties = Object.fromEntries(
      Object.entries(parameters).map(([key, value]) => [key, this.mapToolParameter(value)])
    );

    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  private mapToolParameter(parameter: ToolDefinition['parameters'][string]): Record<string, unknown> {
    const result: Record<string, unknown> = {
      type: parameter.type,
      description: parameter.description,
    };

    if (parameter.enum) {
      result.enum = parameter.enum;
    }

    if (parameter.default !== undefined) {
      result.default = parameter.default;
    }

    if (parameter.properties) {
      result.properties = Object.fromEntries(
        Object.entries(parameter.properties).map(([key, value]) => [key, this.mapToolParameter(value)])
      );
      result.additionalProperties = false;
    }

    if (parameter.items) {
      result.items = this.mapToolParameter(parameter.items);
    }

    return result;
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
