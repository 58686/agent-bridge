import {
  Connector,
  ConnectorConfig,
  ToolDefinition,
} from '../../core/types.js';

export class EchoConnector implements Connector {
  id = 'echo';
  name = 'Echo Connector';
  description = '一个演示连接器，用于说明如何把任意项目能力暴露给 Agent。';

  private config?: ConnectorConfig;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo_text',
        description: '原样返回输入文本，可用于验证 Agent → Tool → Connector 的链路。',
        parameters: {
          text: {
            type: 'string',
            description: '需要回显的文本',
            required: true,
          },
        },
        execute: async (args) => {
          return {
            success: true,
            data: {
              echoed: String(args.text ?? ''),
              connector: this.config?.name ?? this.name,
            },
          };
        },
      },
    ];
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async destroy(): Promise<void> {
    return;
  }
}
