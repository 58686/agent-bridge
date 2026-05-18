#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqlitePersistence } from './persistence/sqlite.js';
import { loadApiAuthOptionsFromEnv } from './server-auth-config.js';
import { createApiServer } from './server.js';
import { ProjectLoader } from './config/project-loader.js';
import { CompositeApiAuditSink, ConsoleApiAuditSink, FileApiAuditSink } from './api-security.js';
import { ConfigurationError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerCliOptions {
  host: string;
  port: number;
  projectPath?: string;
  dbPath?: string;
  auditLogPath?: string;
  debug: boolean;
}

function getDefaultProjectPath(): string {
  return path.resolve(__dirname, '../projects/example/project.yaml');
}

function getDefaultDbPath(): string {
  return path.resolve(process.cwd(), '.agent-data/agent-bridge.sqlite');
}

function getDefaultAuditLogPath(): string {
  return path.resolve(process.cwd(), '.agent-data/audit.log');
}

function ensureParentWritable(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
}

function runStartupChecks(projectPath: string, dbPath: string, auditLogPath: string): void {
  if (!fs.existsSync(projectPath)) {
    throw new ConfigurationError(`Project config not found: ${projectPath}`, 'PROJECT_CONFIG_NOT_FOUND', { projectPath });
  }

  ProjectLoader.load(projectPath);
  ensureParentWritable(dbPath);
  ensureParentWritable(auditLogPath);
}

function parseArgs(argv: string[]): ServerCliOptions {
  const options: ServerCliOptions = {
    host: '127.0.0.1',
    port: 3000,
    debug: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === '--port' || arg === '-p') && next) {
      const port = Number(next);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new ConfigurationError(`Invalid port: ${next}`, 'SERVER_PORT_INVALID', { port: next });
      }
      options.port = port;
      index++;
      continue;
    }

    if ((arg === '--host' || arg === '-H') && next) {
      options.host = next;
      index++;
      continue;
    }

    if ((arg === '--project' || arg === '-P') && next) {
      options.projectPath = path.resolve(process.cwd(), next);
      index++;
      continue;
    }

    if ((arg === '--db' || arg === '-d') && next) {
      options.dbPath = path.resolve(process.cwd(), next);
      index++;
      continue;
    }

    if (arg === '--audit-log' && next) {
      options.auditLogPath = path.resolve(process.cwd(), next);
      index++;
      continue;
    }

    if (arg === '--debug') {
      options.debug = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new ConfigurationError(`Unknown argument: ${arg}`, 'SERVER_ARG_UNKNOWN', { arg });
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: agent-server [options]\n\nOptions:\n  -p, --port <port>       Port to listen on (default: 3000)\n  -H, --host <host>       Host to bind (default: 127.0.0.1)\n  -P, --project <path>    Path to project config (default: example project)\n  -d, --db <path>         Path to SQLite database (default: .agent-data/agent-bridge.sqlite)\n      --audit-log <path>  Path to structured audit log file (default: .agent-data/audit.log)\n      --debug             Enable debug mode\n  -h, --help              Show help`);
}

export async function startApiServer(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const projectPath = options.projectPath ?? getDefaultProjectPath();
  const dbPath = options.dbPath ?? getDefaultDbPath();
  const auditLogPath = options.auditLogPath ?? getDefaultAuditLogPath();

  runStartupChecks(projectPath, dbPath, auditLogPath);

  const persistence = await createSqlitePersistence(dbPath);
  const auth = loadApiAuthOptionsFromEnv();
  const auditSink = new CompositeApiAuditSink([
    new ConsoleApiAuditSink(),
    new FileApiAuditSink(auditLogPath),
  ]);
  const server = createApiServer({
    projectPath,
    debug: options.debug,
    persistence,
    auth,
    auditSink,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(
    `API server listening on http://${options.host}:${options.port} using project ${projectPath} and sqlite ${dbPath} (auth ${auth?.enabled ? 'enabled' : 'disabled'})`,
  );

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down API server...`);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === __filename;

if (isDirectExecution) {
  startApiServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
