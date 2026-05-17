# agent-bridge

agent-bridge is a safe runtime for connecting AI agents to company tools, workflows, and APIs.

It is not a chatbot template, and it is not a replacement for your existing workflow engine, database, CRM, ticketing system, or internal platform. It provides the runtime layer that lets an AI model use those systems through controlled tools.

## What this project does

agent-bridge gives you a configurable backend for enterprise agent use cases:

- **Model adapter**: use a mock model for local demos or OpenAI for real model calls.
- **Connector system**: expose company APIs as tools through configuration.
- **Tool calling runtime**: let the model decide when to call a tool.
- **Human confirmation**: pause risky tool calls until a human approves or rejects them.
- **Session state**: persist messages, snapshots, confirmations, grants, and tool executions.
- **Recovery**: resume interrupted sessions and pending confirmations after restart.
- **Audit trail**: record API access, tool execution, approval decisions, and failures.
- **HTTP API and minimal console**: operate the runtime from an API or browser.

## What this project does not do

agent-bridge does not automatically know your company business. You tell it what your company systems can do by writing a `project.yaml` file.

It also should not bypass your existing business systems:

- Do not let the agent write directly to production databases.
- Prefer calling existing business APIs or workflow APIs.
- Keep your workflow engine as the source of truth for business approvals.
- Use agent-bridge confirmation to approve whether the agent may trigger an external action.

## Current status

This repository is an early enterprise-agent runtime. It is suitable for demos, internal evaluation, and controlled prototypes.

Current built-in capabilities:

- `custom / mock-model` for local demos without an API key
- `openai` model provider
- `echo` connector
- configurable REST `api` connector
- session / confirmation / resume HTTP APIs
- SQLite persistence
- structured audit logs
- startup project config validation
- minimal web console at `/`

## Quickstart: run without any API key

```bash
npm install
npm run build
node dist/server-main.js --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

The default project uses:

```yaml
model:
  provider: custom
  model: mock-model
```

So you can test sessions, tool calls, confirmations, recovery, and audit behavior without configuring `OPENAI_API_KEY`.

## Run a realistic company API example

This repository includes a runnable ticket-system example:

```bash
# terminal 1: start a mock company ticket API
node examples/company-ticket-agent/mock-api.mjs

# terminal 2: start agent-bridge with the ticket example project
npm run build
$env:TICKET_API_TOKEN='example-ticket-token'
node dist/server-main.js --project examples/company-ticket-agent/project.yaml --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

Then:

1. Click **New Session**.
2. Run a prompt such as:

```text
create comment for ticket TICKET-001
```

3. The runtime should enter `waiting_confirmation`.
4. Click **Approve**.
5. The agent calls the mock company API and records the execution and audit trail.

See [`examples/company-ticket-agent/README.md`](./examples/company-ticket-agent/README.md).

## Run an existing workflow-system example

This example shows the recommended boundary when your company already has a workflow engine:

```bash
# terminal 1: start a mock company workflow API
node examples/company-workflow-agent/mock-api.mjs

# terminal 2: start agent-bridge with the workflow example project
$env:WORKFLOW_API_TOKEN='example-workflow-token'
node dist/server-main.js --project examples/company-workflow-agent/project.yaml --port 3000
```

See [`examples/company-workflow-agent/README.md`](./examples/company-workflow-agent/README.md).

## Use a real model

Create `.env` from the template:

```bash
cp .env.example .env
```

Set:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

Then run with an OpenAI project config:

```bash
npm run build
node dist/server-main.js --project projects/example/openai-project.yaml --port 3000
```

A project config can also use an OpenAI-compatible gateway with `baseUrl`.

## Project configuration model

A project is defined by a YAML or JSON file:

```yaml
id: company-ticket-agent
name: Company Ticket Agent

model:
  provider: openai
  model: gpt-4o-mini
  envApiKey: OPENAI_API_KEY

connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: https://api.company.example
      timeoutMs: 30000
      auth:
        type: bearer
        token: ${COMPANY_API_TOKEN}
      tools:
        - name: get_ticket
          description: Get ticket details by ticket id
          method: GET
          path: /tickets/detail
          queryParams: [ticketId]
          parameters:
            ticketId:
              type: string
              description: Ticket id
              required: true

toolPolicy:
  maxConsecutiveCalls: 5
  requireConfirmation: true
```

The project file tells agent-bridge:

- which model to use
- which company systems are connected
- which tools are available
- how risky tool calls should be confirmed
- how long session memory should be kept

## REST API connector

The built-in `api` connector maps REST endpoints to agent tools.

Supported today:

- HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- query parameters
- JSON body parameters
- static headers
- bearer token auth
- API key auth
- JSON response parsing
- request timeout control with connector-level or tool-level `timeoutMs` values; default is `30000`
- method-based risk inference: `GET` = low, `POST/PUT/PATCH` = medium, `DELETE` = high

Project config supports `${ENV_VAR}` interpolation in string values, including connector secrets. If a referenced variable is missing, startup fails with `PROJECT_CONFIG_ENV_VAR_MISSING`. For production systems, still prefer a secret manager or environment-specific deployment config.

## HTTP API auth

HTTP API authentication is optional. Enable it with:

```env
API_AUTH_ENABLED=true
API_AUTH_TOKENS=viewer-token:viewer-1:viewer,operator-token:operator-1:operator,approver-token:approver-1:approver
```

Token format:

```text
token:actorId:role
```

Roles:

- `viewer`: read-only APIs
- `operator`: create and run sessions
- `approver`: approve or reject confirmations
- `admin`: full access

The web console has a **Bearer token** input for calling protected APIs.

## Core concepts

- **Project**: one agent configuration for one business context.
- **Connector**: an adapter that exposes company capabilities.
- **Tool**: a callable business operation exposed to the model.
- **Session**: a stateful conversation and execution timeline.
- **Confirmation**: a human approval gate before risky execution.
- **Grant**: a persisted approval that lets a specific tool call continue.
- **Audit event**: a structured record of API access, tool execution, approval, rejection, or failure.

## Recommended integration patterns

### 1. Existing REST APIs

Expose each safe business operation as one tool. Start with read-only APIs, then add write APIs behind confirmation.

### 2. Existing workflow engines

Do not replace the workflow engine. Let the agent prepare input and call `start_workflow`, `get_workflow_status`, or `add_workflow_comment` APIs.

### 3. Databases

Avoid direct write access to production databases. Prefer read-only APIs, read replicas, analytics APIs, or a restricted query gateway.

### 4. Internal SDKs

If your company already has an SDK, write a custom connector that wraps the SDK and exposes a small set of safe tools.

## Documentation

- [Integration guide](./docs/integration-guide.md)
- [Security model](./docs/security-model.md)
- [HTTP API reference](./docs/api.md)
- [Error codes](./docs/error-codes.md)
- [Deployment checklist](./docs/deployment-checklist.md)
- [Examples](./examples/README.md)

## Development

```bash
npm install
npm run build
npm run test:run
```

Current full regression target:

```text
7 test files / 100 tests
```

## Roadmap

Near-term priorities:

- clearer connector contract
- stronger secret redaction and production hardening
- more official examples: readonly data, OpenAI + company API
- stronger project config validation
- safer production defaults
- improved console onboarding

## License

MIT
