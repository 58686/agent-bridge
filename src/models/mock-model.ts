import {
  AnalysisConfig,
  AnalysisCondition,
  AnalysisLevelRule,
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
        const analysis = this.buildTrainingAnalysis(stats, this.extractAnalysisConfig(messages));

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

      if (lastMessage.name === 'save_training_analysis') {
        return {
          content: this.formatTrainingSaveResult(lastMessage.content),
          finishReason: 'stop',
        };
      }

      return {
        content: `Tool execution result: ${lastMessage.content}`,
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
        content: `Available tools: ${availableTools.map((tool) => tool.name).join(', ') || 'none'}`,
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
        content: 'I will call the echo_text tool for this request.',
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
        content: 'I am preparing to call create_comment. This may require confirmation.',
        toolCalls: [
          {
            id: `mock-create-comment-call${suffix}`,
            name: 'create_comment',
            arguments: {
              ticketId: 'TICKET-001',
              content: 'Demo comment from MockModel',
            },
          },
        ],
        finishReason: 'tool_call',
      };
    }

    return {
      content: `MockModel received: ${content}`,
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

  private extractAnalysisConfig(messages: Message[]): AnalysisConfig | undefined {
    const systemMessages = messages.filter((message) => message.role === 'system').map((message) => message.content);
    for (const content of systemMessages) {
      const marker = 'Analysis configuration JSON.';
      const markerIndex = content.indexOf(marker);
      if (markerIndex === -1) {
        continue;
      }

      const jsonStart = content.indexOf('{', markerIndex);
      if (jsonStart === -1) {
        continue;
      }

      try {
        return JSON.parse(content.slice(jsonStart)) as AnalysisConfig;
      } catch {
        continue;
      }
    }

    return undefined;
  }

  private formatTrainingSaveResult(content: string): string {
    const data = this.extractToolData(content) as {
      ok?: boolean;
      record?: {
        analysisId?: string;
        userId?: string;
        scoreLevel?: string;
        riskLevel?: string;
        summary?: string;
        recommendations?: string[];
        savedAt?: string;
      };
    };

    if (!data.ok || !data.record) {
      return `培训分析保存接口已返回，但结果需要人工检查：${content}`;
    }

    const record = data.record;
    const recommendations = Array.isArray(record.recommendations) && record.recommendations.length > 0
      ? record.recommendations.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : '无额外建议';

    return [
      '培训分析已保存成功。',
      '',
      `分析ID：${record.analysisId ?? '-'}`,
      `用户：${record.userId ?? '-'}`,
      `等级：${record.scoreLevel ?? '-'}`,
      `风险：${record.riskLevel ?? '-'}`,
      `结论：${record.summary ?? '-'}`,
      '',
      '建议：',
      recommendations,
      '',
      `保存时间：${record.savedAt ?? '-'}`,
    ].join('\n');
  }

  private buildTrainingAnalysis(stats: Record<string, unknown>, analysisConfig?: AnalysisConfig): Record<string, unknown> {
    const metrics = {
      completionRate: this.toNumber(stats.completionRate),
      averageScore: this.toNumber(stats.averageScore),
      overdueCourses: this.toNumber(stats.overdueCourses),
      requiredCourses: this.toNumber(stats.requiredCourses),
      completedCourses: this.toNumber(stats.completedCourses),
    };

    const userId = String(stats.userId ?? 'USER-001');
    const standardId = String(analysisConfig?.standardId ?? stats.standardId ?? 'training-standard-v1');
    const matchedRule = this.findMatchingLevel(metrics, analysisConfig?.levels);
    const fallback = analysisConfig?.fallback;

    const scoreLevel = matchedRule?.level ?? fallback?.level ?? 'needs_attention';
    const riskLevel = matchedRule?.riskLevel ?? fallback?.riskLevel ?? 'high';
    const recommendations = matchedRule?.recommendations ?? fallback?.recommendations ?? [
      'Create a remediation plan and schedule manager follow-up.',
      'Prioritize required courses with low completion or low exam scores.',
    ];

    return {
      userId,
      standardId,
      scoreLevel,
      riskLevel,
      summary: `User ${userId} completed ${metrics.completedCourses}/${metrics.requiredCourses} required courses with average score ${metrics.averageScore}.`,
      recommendations,
      evidence: metrics,
    };
  }

  private findMatchingLevel(
    metrics: Record<string, number>,
    levels: AnalysisLevelRule[] | undefined,
  ): AnalysisLevelRule | undefined {
    const configuredLevels = levels && levels.length > 0 ? levels : this.defaultTrainingLevels();
    return configuredLevels.find((level) => this.matchesAllConditions(metrics, level.when));
  }

  private defaultTrainingLevels(): AnalysisLevelRule[] {
    return [
      {
        level: 'excellent',
        riskLevel: 'low',
        when: {
          completionRate: { gte: 0.9 },
          averageScore: { gte: 85 },
          overdueCourses: { eq: 0 },
        },
        recommendations: ['Keep the current learning cadence and consider assigning advanced courses.'],
      },
      {
        level: 'qualified',
        riskLevel: 'medium',
        when: {
          completionRate: { gte: 0.75 },
          averageScore: { gte: 70 },
        },
        recommendations: ['Follow up on overdue courses and review weak knowledge areas.'],
      },
    ];
  }

  private matchesAllConditions(metrics: Record<string, number>, conditions: Record<string, AnalysisCondition>): boolean {
    return Object.entries(conditions).every(([metric, condition]) => {
      const actual = metrics[metric];
      if (actual === undefined) {
        return false;
      }

      if (condition.gte !== undefined && actual < condition.gte) {
        return false;
      }
      if (condition.lte !== undefined && actual > condition.lte) {
        return false;
      }
      if (condition.eq !== undefined && actual !== condition.eq) {
        return false;
      }

      return true;
    });
  }

  private toNumber(value: unknown): number {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }
}
