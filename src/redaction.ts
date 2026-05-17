const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN = /(^|_|-|\.)(authorization|cookie|set_cookie|token|access_token|refresh_token|api_token|apikey|api_key|password|passwd|secret|credential|credentials|private_key)(_|-|\.|$)/i;
const CAMEL_CASE_BOUNDARY_PATTERN = /([a-z0-9])([A-Z])/g;
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi;

export function isSensitiveKey(key: string): boolean {
  const normalizedKey = key.replace(CAMEL_CASE_BOUNDARY_PATTERN, '$1_$2').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(normalizedKey);
}

export function redactSensitiveValue<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, stack: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSensitiveString(value);
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (stack.has(value)) {
    return '[Circular]';
  }
  stack.add(value);

  if (Array.isArray(value)) {
    const redactedArray = value.map((item) => redactValue(item, stack));
    stack.delete(value);
    return redactedArray;
  }

  const redactedObject = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      if (isSensitiveKey(key)) {
        return [key, REDACTED];
      }
      return [key, redactValue(nested, stack)];
    }),
  );
  stack.delete(value);
  return redactedObject;
}

function redactSensitiveString(value: string): string {
  return value.replace(BEARER_VALUE_PATTERN, 'Bearer [REDACTED]');
}
