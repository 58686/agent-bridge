# Company Ticket Agent Example

This example shows how agent-bridge connects to a company ticket system.

It uses:

- a local mock ticket API
- the built-in REST `api` connector
- `custom / mock-model`, so no model API key is required
- confirmation before write operations
- the agent-bridge web console

## What this demonstrates

A real company would replace the mock API with its own ticket, CRM, workflow, or internal API.

This example demonstrates the core pattern:

```text
User prompt
-> Agent proposes a tool call
-> agent-bridge pauses for confirmation
-> Human approves
-> agent-bridge calls the company API
-> Tool execution and audit records are persisted
```

## Start the mock company API

From the repository root:

```bash
node examples/company-ticket-agent/mock-api.mjs
```

The mock API listens on:

```text
http://127.0.0.1:4010
```

It exposes:

```text
GET  /health
GET  /tickets/detail?ticketId=TICKET-001
POST /tickets/comment
```

The default mock bearer token is:

```text
example-ticket-token
```

agent-bridge reads the connector token from `TICKET_API_TOKEN`. Set it before starting the agent server:

```bash
# macOS/Linux
export TICKET_API_TOKEN=example-ticket-token

# Windows PowerShell
$env:TICKET_API_TOKEN='example-ticket-token'
```

## Start agent-bridge with this project

Open another terminal:

```bash
npm run build
node dist/server-main.js --project examples/company-ticket-agent/project.yaml --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

## Run the approval flow

1. Click **New Session**.
2. Enter this prompt:

```text
create comment for ticket TICKET-001
```

3. Click **Run**.
4. The session should enter `waiting_confirmation`.
5. Review the pending confirmation.
6. Click **Approve**.
7. The mock API terminal should print a message similar to:

```text
[mock-ticket-api] comment added to TICKET-001: ...
```

8. The console should show tool execution and audit records.

## Why the mock model can trigger this

The built-in `mock-model` is deterministic. It triggers the `create_comment` tool when the user prompt contains the word `comment` and the project exposes a tool named `create_comment`.

For real natural-language behavior, use an OpenAI project config instead.

## Replace the mock API with your company API

Edit `project.yaml`:

```yaml
connectors:
  - id: company-ticket-api
    type: api
    config:
      baseUrl: https://your-company-api.example
      auth:
        type: bearer
        token: ${COMPANY_API_TOKEN}
```

Then replace the tools with your real endpoints.

For example:

```yaml
- name: get_ticket
  description: Get ticket details by ticket id.
  method: GET
  path: /tickets/detail
  queryParams:
    - ticketId
```

## Security note

This example keeps a fake bearer token in the YAML file for demo simplicity.

For real deployments:

- do not commit real tokens
- generate config from a secret manager or deployment system
- use staging APIs first
- require confirmation for write tools
- keep your existing workflow or ticket system as the source of truth

## Next step

After this example works, try replacing only one thing at a time:

1. Replace mock API with your staging API.
2. Replace mock model with OpenAI.
3. Turn on HTTP API auth.
4. Add one more read-only tool.
5. Add one write tool behind confirmation.
