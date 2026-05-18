#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ProjectLoader } from './config/project-loader.js';
import { createDefaultConnectorRegistry } from './connectors/default-registry.js';
import { RuntimeAgent } from './core/runtime-agent.js';
import { AgentRunResult, ToolConfirmationRequest } from './core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CliOptions {
  command: 'run' | 'demo';
  projectPath?: string;
  input?: string;
  debug: boolean;
}

export interface RunAgentOptions {
  confirm?: (request: ToolConfirmationRequest) => Promise<boolean>;
  sessionId?: string;
}

export interface RunAgentResponse {
  sessionId: string;
  result: AgentRunResult;
}

function parseArgs(argv: string[]): CliOptions {
  const [command = 'demo', ...rest] = argv;
  const options: CliOptions = {
    command: command === 'run' ? 'run' : 'demo',
    debug: false,
  };

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const next = rest[index + 1];

    if (arg === '--project' && next) {
      options.projectPath = next;
      index++;
      continue;
    }

    if (arg === '--input' && next) {
      options.input = next;
      index++;
      continue;
    }

    if (arg === '--debug') {
      options.debug = true;
    }
  }

  return options;
}

function getDefaultProjectPath(): string {
  return path.resolve(__dirname, '../projects/example/project.yaml');
}

export async function promptForConfirmation(request: ToolConfirmationRequest): Promise<boolean> {
  const rl = readline.createInterface({ input, output });

  try {
    console.log('\n=== Confirmation Required ===');
    console.log(`Tool: ${request.tool}`);
    console.log(`Risk: ${request.riskLevel}`);
    console.log(`Reason: ${request.reason}`);
    console.log(`Args: ${JSON.stringify(request.args, null, 2)}`);

    const answer = await rl.question('Approve this tool execution? (y/N): ');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export async function runAgent(
  projectPath: string,
  inputText: string,
  debug: boolean,
  options: RunAgentOptions = {},
): Promise<RunAgentResponse> {
  const project = ProjectLoader.load(projectPath);
  const connectorRegistry = createDefaultConnectorRegistry();
  const agent = new RuntimeAgent({ project, debug, sessionId: options.sessionId }, connectorRegistry);
  const confirm = options.confirm ?? promptForConfirmation;

  await agent.initialize();

  try {
    let result = await agent.run(inputText);

    while (result.pendingConfirmation) {
      console.log(`\n=== Project: ${project.name} ===`);
      if (result.response) {
        console.log(result.response);
      }

      const approved = await confirm(result.pendingConfirmation);
      if (!approved) {
        await agent.rejectConfirmation(result.pendingConfirmation.id, 'Rejected from CLI');
        console.log('\n已拒绝本次高风险工具执行。');
        return {
          sessionId: agent.sessionId,
          result,
        };
      }

      await agent.approveConfirmation(result.pendingConfirmation.id, 'Approved from CLI');
      await agent.clearHistory();
      console.log('\n已批准，正在继续执行原请求...');
      result = await agent.run(inputText);
    }

    console.log(`\n=== Project: ${project.name} ===`);
    console.log(result.response);

    if (result.toolCalls.length > 0) {
      console.log('\n=== Tool Calls ===');
      for (const toolCall of result.toolCalls) {
        console.log(`- ${toolCall.tool} (${toolCall.duration}ms): ${JSON.stringify(toolCall.result)}`);
      }
    }

    return {
      sessionId: agent.sessionId,
      result,
    };
  } finally {
    await agent.destroy();
  }
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === 'run') {
    const projectPath = options.projectPath
      ? path.resolve(process.cwd(), options.projectPath)
      : getDefaultProjectPath();
    const inputText = options.input ?? '请介绍一下当前 Agent 的能力，并列出可用工具';

    await runAgent(projectPath, inputText, options.debug);
    return;
  }

  await runAgent(
    getDefaultProjectPath(),
    '请介绍一下当前 Agent 的能力，并列出可用工具',
    true,
  );
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === __filename;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

