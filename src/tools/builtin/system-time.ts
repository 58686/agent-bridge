import { ToolDefinition } from '../../core/types.js';

export const systemTimeTool: ToolDefinition = {
  name: 'system_time',
  description: '获取当前系统时间',
  parameters: {},
  execute: async () => {
    return {
      success: true,
      data: {
        now: new Date().toISOString(),
      },
    };
  },
};
