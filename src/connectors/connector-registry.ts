import {
  Connector,
  ConnectorConfig,
  ConnectorFactory,
} from '../core/types.js';

export class ConnectorRegistry {
  private factories = new Map<string, ConnectorFactory>();

  register(type: string, factory: ConnectorFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Connector type already registered: ${type}`);
    }
    this.factories.set(type, factory);
  }

  create(config: ConnectorConfig): Connector {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(`Unknown connector type: ${config.type}`);
    }
    return factory(config);
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  list(): string[] {
    return Array.from(this.factories.keys());
  }
}
