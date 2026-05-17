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
    const availableTools = tools ?? [];

    if (lastMessage?.role === 'tool') {
      const trainingSaveTool = availableTools.find((tool) => tool.name === 'save_training_analysis');
      if (lastMessage.name === 'get_training_stats' && trainingSaveTool) {
        const stats = this.extractToolData(lastMessage.content) as Record<string, unknown>;
        const analysis = this.buildTrainingAnalysis(stats);

        return {
          content: 'Training statistics loaded. I prepared a structured analysis result and will save it through save_training_analysis.',
          toolCalls: [
            {
              id: `mock-save-training-analysis-${analysis.userId}`,
              name: 'save_training_analysis',
              arguments: analysis,
            },
          ],
          finishReason: 'tool_call',
        };
      }

      return {
        content: `工具执行结果：${lastMessage.content}`,
        finishReason: 'stop',
      };
    }

    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const content = lastUserMessage?.content ?? '';
    const normalizedContent = content.toLowerCase();

    if (
      content.includes('列出工具') ||
      content.includes('可用工具') ||
      normalizedContent.includes('list tools') ||
      normalizedContent.includes('available tools')
    ) {
      return {
        content: `当前可用工具：${availableTools.map((tool) => tool.name).join(', ') || '无'}`,
        finishReason: 'stop',
      };
    }

    const trainingStatsTool = availableTools.find((tool) => tool.name === 'get_training_stats');
    if (
      trainingStatsTool &&
      (
        normalizedContent.includes('training') ||
        normalizedContent.includes('analyze') ||
        normalizedContent.includes('analysis') ||
        content.includes('培训') ||
        content.includes('分析')
      )
    ) {
      return {
        content: 'I will fetch the training statistics first, then analyze them against the configured standard.',
        toolCalls: [
          {
            id: `mock-get-training-stats-${this.extractUserId(content)}`,
            name: 'get_training_stats',
            arguments: {
              userId: this.extractUserId(content),
            },
          },
        ],
        finishReason: 'tool_call',
      };
    }

    const echoTool = availableTools.find((tool) => tool.name === 'echo_text');
    if (echoTool && (content.includes('调用 echo') || content.includes('回显') || normalizedContent.includes('echo'))) {
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
    if (createCommentTool && (content.includes('新增评论') || content.includes('创建评论') || normalizedContent.includes('comment'))) {
      const count = messages.filter(
        (message) =>
          message.role === 'user' &&
          (message.content.includes('新增评论') || message.content.includes('创建评论') || message.content.toLowerCase().includes('comment'))
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

  private extractUserId(content: string): string {
    const match = content.match(/\b(USER-[A-Za-z0-9_-]+|user-[A-Za-z0-9_-]+|u_[A-Za-z0-9_-]+)\b/i);
    return match?.[1] ?? 'USER-001';
  }

  private extractToolData(content: string): unknown {
    try {
      const parsed = JSON.parse(content) as { data?: unknown };
      return parsed.data ?? parsed;
    } catch {
      return {};
    }
  }

  private buildTrainingAnalysis(stats: Record<string, unknown>): Record<string, unknown> {
    const userId = String(stats.userId ?? 'USER-001');
    const standardId = String(stats.standardId ?? 'training-standard-v1');
    const completionRate = this.toNumber(stats.completionRate);
    const averageScore = this.toNumber(stats.averageScore);
    const overdueCourses = this.toNumber(stats.overdueCourses);
    const requiredCourses = this.toNumber(stats.requiredCourses);
    const completedCourses = this.toNumber(stats.completedCourses);

    let scoreLevel = 'needs_attention';
    let riskLevel = 'high';
    const recommendations: string[] = [];

    if (completionRate >= 0.9 && averageScore >= 85 && overdueCourses === 0) {
      scoreLevel = 'excellent';
      riskLevel = 'low';
      recommendations.push('Keep the current learning cadence and consider assigning advanced courses.');
    } else if (completionRate >= 0.75 && averageScore >= 70) {
      scoreLevel = 'qualified';
      riskLevel = overdueCourses > 0 ? 'medium' : 'low';
      recommendations.push('Follow up on overdue courses and review weak knowledge areas.');
    } else {
      recommendations.push('Create a remediation plan and schedule manager follow-up.');
      recommendations.push('Prioritize required courses with low completion or low exam scores.');
    }

    return {
      userId,
      standardId,
      scoreLevel,
      riskLevel,
      summary: `User ${userId} completed ${completedCourses}/${requiredCourses} required courses with average score ${averageScore}.`,
      recommendations,
      evidence: {
        completionRate,
        averageScore,
        overdueCourses,
        requiredCourses,
        completedCourses,
      },
    };
  }

  private toNumber(value: unknown): number {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }
}
