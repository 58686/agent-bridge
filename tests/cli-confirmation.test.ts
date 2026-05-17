import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mainModule from '../src/main.js';

const projectPath = path.resolve(
  process.cwd(),
  'projects/example/confirmation-demo.yaml',
);

describe('CLI confirmation flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('批准后会打印继续执行信息并输出工具调用结果', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true, source: 'cli-test' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const confirmMock = vi.fn().mockResolvedValue(true);

    await mainModule.runAgent(projectPath, '请创建评论', false, {
      confirm: confirmMock,
    });

    const output = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output).toContain('=== Project: Confirmation Demo Project ===');
    expect(output).toContain('已批准，正在继续执行原请求...');
    expect(output).toContain('=== Tool Calls ===');
    expect(output).toContain('- create_comment');
  });

  it('拒绝后会打印拒绝提示且不会执行工具', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const confirmMock = vi.fn().mockResolvedValue(false);

    await mainModule.runAgent(projectPath, '请创建评论', false, {
      confirm: confirmMock,
    });

    const output = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toContain('=== Project: Confirmation Demo Project ===');
    expect(output).toContain('已拒绝本次高风险工具执行。');
    expect(output).not.toContain('=== Tool Calls ===');
  });
});
