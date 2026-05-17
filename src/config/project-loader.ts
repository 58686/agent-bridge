import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ProjectConfig } from '../core/types.js';
import { ConfigurationError } from '../errors.js';

const ENV_PLACEHOLDER_PATTERN = /\$\{([A-Z0-9_]+)\}/gi;
const API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_API_METHODS = new Set(['GET']);

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

interface ValidationIssue {
  path: string;
  message: string;
}

export interface ProjectLoadOptions {
  env?: NodeJS.ProcessEnv;
}

export class ProjectLoader {
  static load(filePath: string, options: ProjectLoadOptions = {}): ProjectConfig {
    const absolutePath = path.resolve(filePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const ext = path.extname(absolutePath).toLowerCase();

    if (ext === '.yaml' || ext === '.yml') {
      const project = this.resolveEnvPlaceholders(YAML.parse(content), options.env ?? process.env, absolutePath) as unknown as ProjectConfig;
      this.validateProject(project, absolutePath);
      return project;
    }

    if (ext === '.json') {
      const project = this.resolveEnvPlaceholders(JSON.parse(content), options.env ?? process.env, absolutePath) as unknown as ProjectConfig;
      this.validateProject(project, absolutePath);
      return project;
    }

    throw new ConfigurationError(`Unsupported config file: ${absolutePath}`, 'PROJECT_CONFIG_UNSUPPORTED_FILE', {
      filePath: absolutePath,
      extension: ext,
    });
  }

  private static resolveEnvPlaceholders(value: JsonLike, env: NodeJS.ProcessEnv, filePath: string): JsonLike {
    if (typeof value === 'string') {
      return value.replace(ENV_PLACEHOLDER_PATTERN, (match, name: string) => {
        const envValue = env[name];
        if (envValue === undefined) {
          throw new ConfigurationError(
            `Environment variable ${name} referenced in project config is not set`,
            'PROJECT_CONFIG_ENV_VAR_MISSING',
            { filePath, envVar: name, placeholder: match },
          );
        }

        return envValue;
      });
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveEnvPlaceholders(item, env, filePath));
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, this.resolveEnvPlaceholders(nested, env, filePath)]),
      );
    }

    return value;
  }

  private static validateProject(project: unknown, filePath: string): void {
    const issues: ValidationIssue[] = [];

    if (!isPlainObject(project)) {
      this.throwInvalid(filePath, [{ path: '$', message: 'Project config must be an object' }]);
    }

    requireString(project, 'id', 'id', issues);
    requireString(project, 'name', 'name', issues);

    const model = getObject(project, 'model', 'model', issues);
    if (model) {
      this.validateModelConfig(model, issues);
    }

    const analysis = getOptionalObject(project, 'analysis', 'analysis', issues);
    if (analysis) {
      this.validateAnalysisConfig(analysis, issues);
    }

    const connectors = getArray(project, 'connectors', 'connectors', issues);
    if (connectors) {
      this.validateConnectors(connectors, project, issues);
    }

    const toolPolicy = getOptionalObject(project, 'toolPolicy', 'toolPolicy', issues);
    if (toolPolicy) {
      const maxConsecutiveCalls = toolPolicy.maxConsecutiveCalls;
      if (
        maxConsecutiveCalls !== undefined
        && (typeof maxConsecutiveCalls !== 'number' || !Number.isInteger(maxConsecutiveCalls) || maxConsecutiveCalls <= 0)
      ) {
        issues.push({ path: 'toolPolicy.maxConsecutiveCalls', message: 'toolPolicy.maxConsecutiveCalls must be a positive integer' });
      }
      const requireConfirmation = toolPolicy.requireConfirmation;
      if (requireConfirmation !== undefined && typeof requireConfirmation !== 'boolean') {
        issues.push({ path: 'toolPolicy.requireConfirmation', message: 'toolPolicy.requireConfirmation must be boolean' });
      }
      validatePositiveInteger(toolPolicy, 'confirmationTimeoutMs', 'toolPolicy.confirmationTimeoutMs', issues);

      this.validateConfirmationRules(toolPolicy.confirmationRules, issues);
    }

    if (issues.length > 0) {
      this.throwInvalid(filePath, issues);
    }
  }

  private static validateModelConfig(model: Record<string, unknown>, issues: ValidationIssue[]): void {
    requireString(model, 'provider', 'model.provider', issues);
    requireString(model, 'model', 'model.model', issues);
    validateOptionalString(model, 'apiKey', 'model.apiKey', issues);
    validateOptionalString(model, 'envApiKey', 'model.envApiKey', issues);
    validateOptionalString(model, 'baseUrl', 'model.baseUrl', issues);
    validatePositiveInteger(model, 'maxTokens', 'model.maxTokens', issues);
    validatePositiveInteger(model, 'timeoutMs', 'model.timeoutMs', issues);

    const temperature = model.temperature;
    if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
      issues.push({ path: 'model.temperature', message: 'model.temperature must be a number between 0 and 2' });
    }

    const extra = model.extra;
    if (extra !== undefined && !isPlainObject(extra)) {
      issues.push({ path: 'model.extra', message: 'model.extra must be an object' });
    }
  }

  private static validateAnalysisConfig(analysis: Record<string, unknown>, issues: ValidationIssue[]): void {
    validateOptionalString(analysis, 'standardId', 'analysis.standardId', issues);

    const levels = analysis.levels;
    if (levels !== undefined) {
      if (!Array.isArray(levels) || levels.length === 0) {
        issues.push({ path: 'analysis.levels', message: 'analysis.levels must be a non-empty array when provided' });
      } else {
        levels.forEach((level, index) => {
          const levelPath = `analysis.levels[${index}]`;
          if (!isPlainObject(level)) {
            issues.push({ path: levelPath, message: 'analysis level must be an object' });
            return;
          }

          requireString(level, 'level', `${levelPath}.level`, issues);
          validateRiskLevel(level.riskLevel, `${levelPath}.riskLevel`, issues);
          const when = getObject(level, 'when', `${levelPath}.when`, issues);
          if (when) {
            this.validateAnalysisConditions(when, `${levelPath}.when`, issues);
          }
          validateStringArray(level, 'recommendations', `${levelPath}.recommendations`, issues);
        });
      }
    }

    const fallback = analysis.fallback;
    if (fallback !== undefined) {
      if (!isPlainObject(fallback)) {
        issues.push({ path: 'analysis.fallback', message: 'analysis.fallback must be an object' });
      } else {
        validateOptionalString(fallback, 'level', 'analysis.fallback.level', issues);
        if (fallback.riskLevel !== undefined) {
          validateRiskLevel(fallback.riskLevel, 'analysis.fallback.riskLevel', issues);
        }
        validateStringArray(fallback, 'recommendations', 'analysis.fallback.recommendations', issues);
      }
    }
  }

  private static validateAnalysisConditions(when: Record<string, unknown>, pathPrefix: string, issues: ValidationIssue[]): void {
    for (const [metric, condition] of Object.entries(when)) {
      const conditionPath = `${pathPrefix}.${metric}`;
      if (!isPlainObject(condition)) {
        issues.push({ path: conditionPath, message: 'analysis condition must be an object' });
        continue;
      }

      const allowedKeys = new Set(['gte', 'lte', 'eq']);
      for (const key of Object.keys(condition)) {
        if (!allowedKeys.has(key)) {
          issues.push({ path: `${conditionPath}.${key}`, message: 'analysis condition supports only gte, lte, and eq' });
        }
      }

      const hasOperator = ['gte', 'lte', 'eq'].some((key) => condition[key] !== undefined);
      if (!hasOperator) {
        issues.push({ path: conditionPath, message: 'analysis condition must define at least one operator' });
      }

      for (const key of ['gte', 'lte'] as const) {
        if (condition[key] !== undefined && typeof condition[key] !== 'number') {
          issues.push({ path: `${conditionPath}.${key}`, message: `analysis condition ${key} must be a number` });
        }
      }

      const eq = condition.eq;
      if (eq !== undefined && !['string', 'number', 'boolean'].includes(typeof eq)) {
        issues.push({ path: `${conditionPath}.eq`, message: 'analysis condition eq must be a string, number, or boolean' });
      }
    }
  }

  private static validateConfirmationRules(value: unknown, issues: ValidationIssue[]): void {
    if (value === undefined) {
      return;
    }

    if (!Array.isArray(value)) {
      issues.push({ path: 'toolPolicy.confirmationRules', message: 'toolPolicy.confirmationRules must be an array' });
      return;
    }

    value.forEach((entry, index) => {
      const rulePath = `toolPolicy.confirmationRules[${index}]`;
      if (!isPlainObject(entry)) {
        issues.push({ path: rulePath, message: 'confirmation rule must be an object' });
        return;
      }

      requireString(entry, 'tool', `${rulePath}.tool`, issues);
      if (typeof entry.requireConfirmation !== 'boolean') {
        issues.push({ path: `${rulePath}.requireConfirmation`, message: 'confirmation rule requireConfirmation must be boolean' });
      }
    });
  }

  private static toolRequiresConfirmationByRule(toolName: string, rules: unknown[]): boolean | undefined {
    let result: boolean | undefined;
    for (const rule of rules) {
      if (!isPlainObject(rule)) {
        continue;
      }

      if (rule.tool === toolName && typeof rule.requireConfirmation === 'boolean') {
        result = rule.requireConfirmation;
      }
    }

    return result;
  }

  private static validateConnectors(connectors: unknown[], project: Record<string, unknown>, issues: ValidationIssue[]): void {
    const connectorIds = new Set<string>();
    const toolNames = new Set<string>();
    const toolPolicy = project.toolPolicy as { requireConfirmation?: unknown; confirmationRules?: unknown } | undefined;
    const requireConfirmation = toolPolicy?.requireConfirmation === true;
    const confirmationRules = Array.isArray(toolPolicy?.confirmationRules) ? toolPolicy.confirmationRules : [];

    connectors.forEach((connector, connectorIndex) => {
      const connectorPath = `connectors[${connectorIndex}]`;
      if (!isPlainObject(connector)) {
        issues.push({ path: connectorPath, message: 'Connector must be an object' });
        return;
      }

      const connectorId = requireString(connector, 'id', `${connectorPath}.id`, issues);
      if (connectorId) {
        if (connectorIds.has(connectorId)) {
          issues.push({ path: `${connectorPath}.id`, message: `Duplicate connector id: ${connectorId}` });
        }
        connectorIds.add(connectorId);
      }

      const connectorType = requireString(connector, 'type', `${connectorPath}.type`, issues);
      requireString(connector, 'name', `${connectorPath}.name`, issues);
      const connectorConfig = getObject(connector, 'config', `${connectorPath}.config`, issues);

      if (connectorType === 'api' && connectorConfig) {
        this.validateApiConnectorConfig(connectorConfig, connectorPath, toolNames, requireConfirmation, confirmationRules, issues);
      }
    });
  }

  private static validateApiConnectorConfig(
    config: Record<string, unknown>,
    connectorPath: string,
    toolNames: Set<string>,
    requireConfirmation: boolean,
    confirmationRules: unknown[],
    issues: ValidationIssue[],
  ): void {
    requireString(config, 'baseUrl', `${connectorPath}.config.baseUrl`, issues);
    validatePositiveInteger(config, 'timeoutMs', `${connectorPath}.config.timeoutMs`, issues);

    const auth = getOptionalObject(config, 'auth', `${connectorPath}.config.auth`, issues);
    if (auth?.type !== undefined && !['none', 'bearer', 'apiKey'].includes(String(auth.type))) {
      issues.push({ path: `${connectorPath}.config.auth.type`, message: 'auth.type must be one of none, bearer, apiKey' });
    }

    const tools = getArray(config, 'tools', `${connectorPath}.config.tools`, issues);
    if (!tools) {
      return;
    }

    if (tools.length === 0) {
      issues.push({ path: `${connectorPath}.config.tools`, message: 'API connector requires at least one tool' });
      return;
    }

    tools.forEach((tool, toolIndex) => {
      const toolPath = `${connectorPath}.config.tools[${toolIndex}]`;
      if (!isPlainObject(tool)) {
        issues.push({ path: toolPath, message: 'API tool must be an object' });
        return;
      }

      const name = requireString(tool, 'name', `${toolPath}.name`, issues);
      requireString(tool, 'description', `${toolPath}.description`, issues);
      requireString(tool, 'path', `${toolPath}.path`, issues);

      if (name) {
        if (toolNames.has(name)) {
          issues.push({ path: `${toolPath}.name`, message: `Duplicate tool name: ${name}` });
        }
        toolNames.add(name);
      }

      const methodRaw = tool.method;
      const method = methodRaw === undefined ? 'GET' : String(methodRaw).toUpperCase();
      if (!API_METHODS.has(method)) {
        issues.push({ path: `${toolPath}.method`, message: 'API tool method must be one of GET, POST, PUT, PATCH, DELETE' });
      }

      const toolRequiresConfirmation = name ? this.toolRequiresConfirmationByRule(name, confirmationRules) : undefined;
      const hasConfirmationBoundary = requireConfirmation || toolRequiresConfirmation === true;
      if (API_METHODS.has(method) && !SAFE_API_METHODS.has(method) && !hasConfirmationBoundary) {
        issues.push({
          path: `${toolPath}.method`,
          message: `State-changing API tool ${name ?? '<unnamed>'} uses ${method}; set toolPolicy.requireConfirmation: true or add a matching toolPolicy.confirmationRules entry`,
        });
      }

      validateStringArray(tool, 'queryParams', `${toolPath}.queryParams`, issues);
      validateStringArray(tool, 'bodyParams', `${toolPath}.bodyParams`, issues);
      validatePositiveInteger(tool, 'timeoutMs', `${toolPath}.timeoutMs`, issues);

      const parameters = getOptionalObject(tool, 'parameters', `${toolPath}.parameters`, issues);
      if (parameters) {
        this.validateToolParameters(parameters, `${toolPath}.parameters`, issues);
      }
    });
  }

  private static validateToolParameters(parameters: Record<string, unknown>, pathPrefix: string, issues: ValidationIssue[]): void {
    for (const [paramName, parameter] of Object.entries(parameters)) {
      this.validateToolParameter(parameter, `${pathPrefix}.${paramName}`, issues);
    }
  }

  private static validateToolParameter(parameter: unknown, parameterPath: string, issues: ValidationIssue[]): void {
    if (!isPlainObject(parameter)) {
      issues.push({ path: parameterPath, message: 'Tool parameter must be an object' });
      return;
    }

    const type = String(parameter.type);
    if (!['string', 'number', 'boolean', 'object', 'array'].includes(type)) {
      issues.push({ path: `${parameterPath}.type`, message: 'Tool parameter type is invalid' });
    }
    requireString(parameter, 'description', `${parameterPath}.description`, issues);

    const required = parameter.required;
    if (required !== undefined && typeof required !== 'boolean') {
      issues.push({ path: `${parameterPath}.required`, message: 'Tool parameter required must be boolean' });
    }

    const enumValues = parameter.enum;
    if (enumValues !== undefined) {
      if (!Array.isArray(enumValues) || enumValues.length === 0) {
        issues.push({ path: `${parameterPath}.enum`, message: 'Tool parameter enum must be a non-empty array' });
      } else if (enumValues.some((item) => !['string', 'number', 'boolean'].includes(typeof item))) {
        issues.push({ path: `${parameterPath}.enum`, message: 'Tool parameter enum values must be strings, numbers, or booleans' });
      }
    }

    if (type === 'array') {
      if (parameter.items !== undefined) {
        this.validateToolParameter(parameter.items, `${parameterPath}.items`, issues);
      }
    } else if (parameter.items !== undefined) {
      issues.push({ path: `${parameterPath}.items`, message: 'Tool parameter items is only valid for array parameters' });
    }

    if (type === 'object') {
      if (parameter.properties !== undefined) {
        if (!isPlainObject(parameter.properties)) {
          issues.push({ path: `${parameterPath}.properties`, message: 'Tool parameter properties must be an object' });
        } else {
          this.validateToolParameters(parameter.properties, `${parameterPath}.properties`, issues);
        }
      }
    } else if (parameter.properties !== undefined) {
      issues.push({ path: `${parameterPath}.properties`, message: 'Tool parameter properties is only valid for object parameters' });
    }
  }

  private static throwInvalid(filePath: string, issues: ValidationIssue[]): never {
    throw new ConfigurationError('Invalid project config', 'PROJECT_CONFIG_INVALID', { filePath, issues });
  }
}

function requireString(input: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): string | undefined {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: `${path} must be a non-empty string` });
    return undefined;
  }
  return value;
}

function getArray(input: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): unknown[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} must be an array` });
    return undefined;
  }
  return value;
}

function getObject(input: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  const value = input[key];
  if (!isPlainObject(value)) {
    issues.push({ path, message: `${path} must be an object` });
    return undefined;
  }
  return value;
}

function getOptionalObject(input: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    issues.push({ path, message: `${path} must be an object` });
    return undefined;
  }
  return value;
}

function validateOptionalString(input: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  const value = input[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: `${path} must be a non-empty string` });
  }
}

function validateRiskLevel(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!['low', 'medium', 'high'].includes(String(value))) {
    issues.push({ path, message: `${path} must be one of low, medium, high` });
  }
}

function validateStringArray(input: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  const value = input[key];
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    issues.push({ path, message: `${path} must be an array of non-empty strings` });
  }
}

function validatePositiveInteger(input: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  const value = input[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    issues.push({ path, message: `${path} must be a positive integer` });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
