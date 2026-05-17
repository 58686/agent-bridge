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
          message: `Missing required parameter: ${key}`,
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
        issues.push({ path, message: `${path} must be a string` });
        return undefined;
      }
      if (!validateEnum(value, parameter, path, issues)) {
        return undefined;
      }
      return value;

    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        issues.push({ path, message: `${path} must be a number` });
        return undefined;
      }
      if (!validateEnum(value, parameter, path, issues)) {
        return undefined;
      }
      return value;

    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ path, message: `${path} must be a boolean` });
        return undefined;
      }
      if (!validateEnum(value, parameter, path, issues)) {
        return undefined;
      }
      return value;

    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `${path} must be an array` });
        return undefined;
      }

      if (!parameter.items) {
        return value;
      }

      const arrayResult: unknown[] = [];
      value.forEach((item, index) => {
        const validatedItem = validateValue(item, parameter.items as ToolParameter, `${path}[${index}]`, issues);
        if (validatedItem !== undefined) {
          arrayResult.push(validatedItem);
        }
      });
      return arrayResult;
    }

    case 'object': {
      if (!isPlainObject(value)) {
        issues.push({ path, message: `${path} must be an object` });
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
              message: `Missing required parameter: ${path}.${childKey}`,
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
    }

    default:
      issues.push({ path, message: `${path} uses an unsupported parameter type` });
      return undefined;
  }
}

function validateEnum(value: string | number | boolean, parameter: ToolParameter, path: string, issues: ValidationIssue[]): boolean {
  if (!parameter.enum) {
    return true;
  }

  if (!parameter.enum.some((item) => item === value)) {
    issues.push({ path, message: `${path} must be one of: ${parameter.enum.join(', ')}` });
    return false;
  }

  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
