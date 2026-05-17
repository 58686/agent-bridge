import { Logger } from './types.js';

export class ConsoleLogger implements Logger {
  debug(message: string, ...args: unknown[]): void {
    console.debug(`[DEBUG] ${message}`, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    console.info(`[INFO] ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`[WARN] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }
}
