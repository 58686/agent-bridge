import { ToolParameter } from '../core/types.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  normalizedArgs: Record<string, unknown>;
  issues: ValidationIssue[];
}

export function validateToolArguments(
  args: Record<string, unknown>,
  schema: Record<string, ToolParameter>
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const normalizedArgs: Record<string, unknown> = {};

  for (const [key, parameter] of Object.entries(schema)) {
    const hasValue = Object.prototype.hasOwnProperty.call(args, key);
    const rawValue = args[key];

    if (!hasValue || rawValue === undefined || rawValue === null) {
      if (parameter.required) {
        issues.push({
          path: key,
          message: `缺少必填参数: ${key}`,
        });
      } else if (parameter.default !== undefined) {
        normalizedArgs[key] = parameter.default;
      }
      continue;
    }

    const validated = validateValue(rawValue, parameter, key, issues);
    if (validated !== undefined) {
      normalizedArgs[key] = validated;
    }
  }

  return {
    valid: issues.length === 0,
    normalizedArgs,
    issues,
  };
}

function validateValue(
  value: unknown,
  parameter: ToolParameter,
  path: string,
  issues: ValidationIssue[]
): unknown {
  switch (parameter.type) {
    case 'string':
      if (typeof value !== 'string') {
        issues.push({ path, message: `${path} 应为 string` });
        return undefined;
      }
      if (parameter.enum && !parameter.enum.includes(value)) {
        issues.push({ path, message: `${path} 必须是 ${parameter.enum.join(', ')} 之一` });
        return undefined;
      }
      return value;

    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        issues.push({ path, message: `${path} 应为 number` });
        return undefined;
      }
      return value;

    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ path, message: `${path} 应为 boolean` });
        return undefined;
      }
      return value;

    case 'array':
      if (!Array.isArray(value)) {
        issues.push({ path, message: `${path} 应为 array` });
        return undefined;
      }
      if (!parameter.items) {
        return value;
      }
      return value
        .map((item, index) => validateValue(item, parameter.items as ToolParameter, `${path}[${index}]`, issues))
        .filter((item) => item !== undefined);

    case 'object':
      if (!isPlainObject(value)) {
        issues.push({ path, message: `${path} 应为 object` });
        return undefined;
      }

      if (!parameter.properties) {
        return value;
      }

      const objectResult: Record<string, unknown> = {};
      for (const [childKey, childSchema] of Object.entries(parameter.properties)) {
        const childHasValue = Object.prototype.hasOwnProperty.call(value, childKey);
        const childValue = (value as Record<string, unknown>)[childKey];

        if (!childHasValue || childValue === undefined || childValue === null) {
          if (childSchema.required) {
            issues.push({
              path: `${path}.${childKey}`,
              message: `缺少必填参数: ${path}.${childKey}`,
            });
          } else if (childSchema.default !== undefined) {
            objectResult[childKey] = childSchema.default;
          }
          continue;
        }

        const validatedChild = validateValue(childValue, childSchema, `${path}.${childKey}`, issues);
        if (validatedChild !== undefined) {
          objectResult[childKey] = validatedChild;
        }
      }
      return objectResult;

    default:
      issues.push({ path, message: `${path} 使用了不支持的参数类型` });
      return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
