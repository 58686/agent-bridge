# Examples

This directory contains runnable and reference examples for connecting agent-bridge to company systems.

## Available examples

| Example | Purpose | Requires real API key |
|---|---|---|
| [`company-ticket-agent`](./company-ticket-agent) | Runnable mock company ticket API + agent-bridge project config | No |
| [`company-workflow-agent`](./company-workflow-agent) | Runnable mock company workflow API + approval-boundary example | No |

## Recommended learning path

1. Run the default project from the repository root:

```bash
npm run build
node dist/server-main.js --port 3000
```

2. Open the console:

```text
http://127.0.0.1:3000/
```

3. Run the ticket example:

```bash
node examples/company-ticket-agent/mock-api.mjs
$env:TICKET_API_TOKEN='example-ticket-token'
node dist/server-main.js --project examples/company-ticket-agent/project.yaml --port 3000
```

4. Run the workflow example:

```bash
node examples/company-workflow-agent/mock-api.mjs
$env:WORKFLOW_API_TOKEN='example-workflow-token'
node dist/server-main.js --project examples/company-workflow-agent/project.yaml --port 3000
```

5. Replace the mock API with your own dev/staging API.

## Planned examples

- OpenAI + company REST API
- Read-only data/analytics integration
- Custom connector skeleton
