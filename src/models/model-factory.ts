import { ChatModel, ModelConfig } from '../core/types.js';
import { ConfigurationError } from '../errors.js';
import { MockModel } from './mock-model.js';
import { OpenAIModel } from './openai-model.js';

export class ModelFactory {
  static create(config: ModelConfig): ChatModel {
    switch (config.provider) {
      case 'openai':
        return new OpenAIModel(config);
      case 'custom':
        return new MockModel(config);
      default:
        throw new ConfigurationError(`Unsupported model provider: ${config.provider}`, 'UNSUPPORTED_MODEL_PROVIDER', {
          provider: config.provider,
          model: config.model,
        });
    }
  }
}
