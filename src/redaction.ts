export const REDACTED = '[REDACTED]';

export interface RedactionOptions {
  /** Additional field names that should be redacted for this project. */
  extraSensitiveKeys?: string[];
  /** Replacement string used for sensitive values. Defaults to [REDACTED]. */
  replacement?: string;
}

const SENSITIVE_KEY_PATTERN = /(^|_|-|\.)(authorization|cookie|set_cookie|token|access_token|refresh_token|api_token|apikey|api_key|password|passwd|secret|credential|credentials|private_key)(_|-|\.|$)/i;
const CAMEL_CASE_BOUNDARY_PATTERN = /([a-z0-9])([A-Z])/g;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]/g;
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi;

let defaultRedactionOptions: NormalizedRedactionOptions = normalizeRedactionOptions();

interface NormalizedRedactionOptions {
  extraSensitiveKeys: Set<string>;
  replacement: string;
}

export function configureRedaction(options: RedactionOptions = {}): void {
  defaultRedactionOptions = normalizeRedactionOptions(options);
}

export function createRedactor(options: RedactionOptions = {}): <T>(value: T) => T {
  const normalizedOptions = normalizeRedactionOptions(options);
  return <T>(value: T): T => redactValue(value, new WeakSet<object>(), normalizedOptions) as T;
}

export function isSensitiveKey(key: string, options: RedactionOptions = {}): boolean {
  const normalizedKey = normalizeKey(key);
  const normalizedOptions = normalizeRedactionOptions(options);
  return SENSITIVE_KEY_PATTERN.test(key.replace(CAMEL_CASE_BOUNDARY_PATTERN, '$1_$2').toLowerCase())
    || normalizedOptions.extraSensitiveKeys.has(normalizedKey);
}

export function redactSensitiveValue<T>(value: T, options?: RedactionOptions): T {
  const normalizedOptions = options ? normalizeRedactionOptions(options) : defaultRedactionOptions;
  return redactValue(value, new WeakSet<object>(), normalizedOptions) as T;
}

function redactValue(value: unknown, stack: WeakSet<object>, options: NormalizedRedactionOptions): unknown {
  if (typeof value === 'string') {
    return redactSensitiveString(value, options.replacement);
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (stack.has(value)) {
    return '[Circular]';
  }
  stack.add(value);

  if (Array.isArray(value)) {
    const redactedArray = value.map((item) => redactValue(item, stack, options));
    stack.delete(value);
    return redactedArray;
  }

  const redactedObject = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      if (isSensitiveKeyWithNormalizedOptions(key, options)) {
        return [key, options.replacement];
      }
      return [key, redactValue(nested, stack, options)];
    }),
  );
  stack.delete(value);
  return redactedObject;
}

function redactSensitiveString(value: string, replacement: string): string {
  return value.replace(BEARER_VALUE_PATTERN, `Bearer ${replacement}`);
}

function isSensitiveKeyWithNormalizedOptions(key: string, options: NormalizedRedactionOptions): boolean {
  const snakeLikeKey = key.replace(CAMEL_CASE_BOUNDARY_PATTERN, '$1_$2').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(snakeLikeKey) || options.extraSensitiveKeys.has(normalizeKey(key));
}

function normalizeRedactionOptions(options: RedactionOptions = {}): NormalizedRedactionOptions {
  return {
    extraSensitiveKeys: new Set((options.extraSensitiveKeys ?? []).map(normalizeKey).filter(Boolean)),
    replacement: options.replacement ?? REDACTED,
  };
}

function normalizeKey(key: string): string {
  return key
    .replace(CAMEL_CASE_BOUNDARY_PATTERN, '$1_$2')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_PATTERN, '');
}
