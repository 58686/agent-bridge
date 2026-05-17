import { describe, expect, it } from 'vitest';
import { createRedactor, isSensitiveKey, redactSensitiveValue } from '../src/redaction.js';

describe('redaction', () => {
  it('redacts built-in sensitive keys and bearer tokens by default', () => {
    const value = redactSensitiveValue({
      apiToken: 'token-123',
      nested: {
        authorization: 'Bearer abc.def.ghi',
      },
      safe: 'Bearer abc.def.ghi',
    });

    expect(value).toEqual({
      apiToken: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
      },
      safe: 'Bearer [REDACTED]',
    });
  });

  it('supports project-specific sensitive keys across common naming styles', () => {
    const redactor = createRedactor({
      extraSensitiveKeys: ['employeeIdCard', 'mobile_phone'],
    });

    expect(isSensitiveKey('employee_id_card', { extraSensitiveKeys: ['employeeIdCard'] })).toBe(true);
    expect(redactor({
      employeeIdCard: 'ID-001',
      employee_id_card: 'ID-002',
      mobilePhone: '13800000000',
      nested: {
        mobile_phone: '13900000000',
      },
      userId: 'USER-001',
    })).toEqual({
      employeeIdCard: '[REDACTED]',
      employee_id_card: '[REDACTED]',
      mobilePhone: '[REDACTED]',
      nested: {
        mobile_phone: '[REDACTED]',
      },
      userId: 'USER-001',
    });
  });

  it('supports custom replacement text', () => {
    const redactor = createRedactor({
      extraSensitiveKeys: ['nationalId'],
      replacement: '[MASKED]',
    });

    expect(redactor({ nationalId: 'N-001', apiKey: 'key-001', header: 'Bearer secret-token' })).toEqual({
      nationalId: '[MASKED]',
      apiKey: '[MASKED]',
      header: 'Bearer [MASKED]',
    });
  });
});
