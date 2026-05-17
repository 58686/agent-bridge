import { ConnectorRegistry } from './connector-registry.js';
import { EchoConnector } from './examples/echo-connector.js';
import { ApiConnector } from './examples/api-connector.js';

export function createDefaultConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();

  registry.register('echo', (config) => new EchoConnector());
  registry.register('api', (config) => new ApiConnector());

  return registry;
}
