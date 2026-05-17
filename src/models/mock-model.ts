import {
  ChatModel,
  Message,
  ModelConfig,
  ModelResponse,
  ToolDefinition,
} from '../core/types.js';

export class MockModel implements ChatModel {
  config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ModelResponse> {
    const lastMessage = messages[messages.length - 1];

    if (lastMessage?.role === 'tool') {
      return {
        content: `工具执行结果：${lastMessage.content}`,
        finishReason: 'stop',
      };
    }

    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const content = lastUserMessage?.content ?? '';
    const availableTools = tools ?? [];

    if (content.includes('列出工具') || content.includes('可用工具')) {
      return {
        content: `当前可用工具：${availableTools.map((tool) => tool.name).join(', ') || '无'}`,
        finishReason: 'stop',
      };
    }

    const echoTool = availableTools.find((tool) => tool.name === 'echo_text');
    if (echoTool && (content.includes('调用 echo') || content.includes('回显'))) {
      return {
        content: '我将调用 echo_text 工具来处理这次请求。',
        toolCalls: [
          {
            id: 'mock-echo-call',
            name: 'echo_text',
            arguments: {
              text: content,
            },
          },
        ],
        finishReason: 'tool_call',
      };
    }

    const createCommentTool = availableTools.find((tool) => tool.name === 'create_comment');
    if (createCommentTool && (content.includes('新增评论') || content.includes('创建评论') || content.includes('comment'))) {
      const count = messages.filter(
        (message) =>
          message.role === 'user' &&
          (message.content.includes('新增评论') || message.content.includes('创建评论') || message.content.includes('comment'))
      ).length;
      const suffix = count > 1 ? `-${count}` : '';

      return {
        content: '我准备调用 create_comment 工具，但这可能需要确认。',
        toolCalls: [
          {
            id: `mock-create-comment-call${suffix}`,
            name: 'create_comment',
            arguments: {
              ticketId: 'TICKET-001',
              content: '来自 MockModel 的演示评论',
            },
          },
        ],
        finishReason: 'tool_call',
      };
    }

    return {
      content: `MockModel 已收到请求：${content}`,
      finishReason: 'stop',
    };
  }
}
