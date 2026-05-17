import { describe, expect, it } from 'vitest';
import { loadApiAuthOptionsFromEnv, parseApiAuthTokenSpec } from '../src/server-auth-config.js';

describe('server auth config', () => {
  it('可以解析单个 token 规格', () => {
    const token = parseApiAuthTokenSpec('secret-token:alice:approver');
    expect(token).toEqual({
      token: 'secret-token',
      actorId: 'alice',
      role: 'approver',
    });
  });

  it('启用鉴权时可以从环境变量加载多个 token', () => {
    const auth = loadApiAuthOptionsFromEnv({
      API_AUTH_ENABLED: 'true',
      API_AUTH_TOKENS: 'viewer-token:viewer-1:viewer, approver-token:approver-1:approver',
    });

    expect(auth).toEqual({
      enabled: true,
      tokens: [
        { token: 'viewer-token', actorId: 'viewer-1', role: 'viewer' },
        { token: 'approver-token', actorId: 'approver-1', role: 'approver' },
      ],
    });
  });

  it('未启用鉴权时返回 undefined', () => {
    expect(loadApiAuthOptionsFromEnv({ API_AUTH_ENABLED: 'false' })).toBeUndefined();
  });

  it('启用鉴权但缺少 token 时抛出结构化配置错误', () => {
    expect(() => loadApiAuthOptionsFromEnv({ API_AUTH_ENABLED: 'true' })).toThrowError(
      expect.objectContaining({
        code: 'API_AUTH_TOKENS_MISSING',
        message: 'API_AUTH_ENABLED is true but API_AUTH_TOKENS is empty',
      }),
    );
  });
});
