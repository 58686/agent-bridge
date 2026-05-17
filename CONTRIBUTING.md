# Contributing to agent-bridge

Thanks for your interest in contributing.

agent-bridge is focused on one goal:

> Help teams connect AI agents to company APIs, workflows, and business systems safely.

Please keep contributions aligned with that goal: tool access, approval boundaries, auditability, recovery, and practical enterprise integration.

## Development setup

```bash
npm install
npm run build
npm run test:run
```

Run the default server:

```bash
node dist/server-main.js --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

## Before opening a pull request

Please run:

```bash
npm run build
npm run test:run
```

Also check that you did not commit local runtime data:

- `.env`
- `.agent-data/`
- `*.sqlite`
- `dist/`
- `node_modules/`
- real customer data
- real API tokens or credentials

## Project structure

```text
src/        runtime, connectors, persistence, API server, UI
tests/      Vitest coverage for runtime, API, config, persistence
examples/   runnable company-system demos
docs/       integration, security, deployment, and API documentation
```

## Adding a new connector or example

Prefer examples that show a real enterprise pattern:

- read data from a company API
- let the model reason over that data
- write back through a controlled company API
- require approval for risky or state-changing tools
- include audit and recovery expectations

A runnable example should include:

- `project.yaml`
- `mock-api.mjs` when possible
- `README.md` with copy-paste commands
- no real secrets

## Coding guidelines

- Keep company-specific logic in project config or examples, not in core runtime.
- Prefer explicit errors with stable error codes.
- Avoid direct database writes to customer systems; use business APIs or workflow APIs.
- Keep model behavior deterministic in tests.
- Add tests for config validation, approval, recovery, and audit behavior when changing core runtime behavior.

## Commit messages

Use short, descriptive messages, for example:

```text
Add training analysis example
Improve demo console layout
Validate API connector timeout config
```

## Questions and proposals

For larger changes, open an issue first and explain:

1. the enterprise integration scenario
2. the proposed runtime behavior
3. the security and audit implications
4. how it will be tested
