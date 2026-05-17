import { ApiAuthOptions, ApiAuthToken, ApiRole } from './api-security.js';
import { ConfigurationError } from './errors.js';

function parseRole(value: string, source: string): ApiRole {
  if (value === 'viewer' || value === 'operator' || value === 'approver' || value === 'admin') {
    return value;
  }

  throw new ConfigurationError(`Invalid API role in ${source}: ${value}`, 'API_AUTH_ROLE_INVALID', {
    source,
    role: value,
  });
}

export function parseApiAuthTokenSpec(spec: string, source = 'API_AUTH_TOKENS'): ApiAuthToken {
  const parts = spec.split(':');
  if (parts.length !== 3) {
    throw new ConfigurationError(`Invalid API auth token spec in ${source}. Expected token:actorId:role`, 'API_AUTH_TOKEN_SPEC_INVALID', {
      source,
      spec,
    });
  }

  const [token, actorId, roleRaw] = parts.map((part) => part.trim());
  if (!token || !actorId || !roleRaw) {
    throw new ConfigurationError(`Invalid API auth token spec in ${source}. token, actorId and role are required`, 'API_AUTH_TOKEN_SPEC_INVALID', {
      source,
      spec,
    });
  }

  return {
    token,
    actorId,
    role: parseRole(roleRaw, source),
  };
}

export function loadApiAuthOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ApiAuthOptions | undefined {
  const enabledRaw = env.API_AUTH_ENABLED?.trim();
  const tokensRaw = env.API_AUTH_TOKENS?.trim();

  const enabled = enabledRaw === 'true' || enabledRaw === '1';
  if (!enabled) {
    return undefined;
  }

  if (!tokensRaw) {
    throw new ConfigurationError('API_AUTH_ENABLED is true but API_AUTH_TOKENS is empty', 'API_AUTH_TOKENS_MISSING');
  }

  const tokens = tokensRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => parseApiAuthTokenSpec(entry, `API_AUTH_TOKENS[${index}]`));

  if (tokens.length === 0) {
    throw new ConfigurationError('API_AUTH_ENABLED is true but no valid API auth tokens were provided', 'API_AUTH_TOKENS_INVALID');
  }

  return {
    enabled: true,
    tokens,
  };
}
