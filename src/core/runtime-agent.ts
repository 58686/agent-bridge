import { BaseAgent } from './agent.js';
import { ConsoleLogger } from './logger.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import { ModelFactory } from '../models/model-factory.js';
import {
  AgentConfig,
  ChatModel,
  Connector,
  ConnectorConfig,
  Logger,
} from './types.js';

export class RuntimeAgent extends BaseAgent {
  constructor(
    config: AgentConfig,
    private readonly connectorRegistry: ConnectorRegistry,
  ) {
    super(config);
  }

  protected createModel(config: AgentConfig['project']['model']): ChatModel {
    return ModelFactory.create(config);
  }

  protected createLogger(): Logger {
    return new ConsoleLogger();
  }

  protected createConnector(config: ConnectorConfig): Connector {
    return this.connectorRegistry.create(config);
  }
}
