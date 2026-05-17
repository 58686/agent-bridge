# Company Workflow Agent Example

This example shows how agent-bridge can connect to an existing company workflow system.

The important idea:

> agent-bridge may start a workflow after human confirmation, but the company workflow system still owns the real business approval.

## What this demonstrates

```text
User asks the agent to start a business process
-> Agent proposes a tool call
-> agent-bridge asks for confirmation
-> Human approves the agent action
-> Agent calls the company workflow API
-> Company workflow enters its own business approval process
```

agent-bridge confirmation and company workflow approval are separate layers:

| Layer | Question answered |
|---|---|
| agent-bridge confirmation | May the agent call this workflow API with these arguments? |
| Company workflow approval | Should the business action be approved? |

## Start the mock workflow API

From the repository root:

```bash
node examples/company-workflow-agent/mock-api.mjs
```

The mock API listens on:

```text
http://127.0.0.1:4020
```

It exposes:

```text
GET  /health
GET  /workflow/status?workflowId=WF-001
POST /workflow/refund/start
```

The default mock bearer token is:

```text
example-workflow-token
```

agent-bridge reads the connector token from `WORKFLOW_API_TOKEN`. Set it before starting the agent server:

```bash
# macOS/Linux
export WORKFLOW_API_TOKEN=example-workflow-token

# Windows PowerShell
$env:WORKFLOW_API_TOKEN='example-workflow-token'
```

## Start agent-bridge with this project

Open another terminal:

```bash
npm run build
node dist/server-main.js --project examples/company-workflow-agent/project.yaml --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

## Run the workflow flow

1. Click **New Session**.
2. Enter this prompt:

```text
create comment for ticket TICKET-001
```

3. Click **Run**.
4. The session should enter `waiting_confirmation`.
5. Review the pending confirmation.
6. Click **Approve**.
7. The mock workflow API terminal should print a message similar to:

```text
[mock-workflow-api] refund workflow started: WF-002 for TICKET-001
```

8. The console should show tool execution and audit records.

## Why the tool is named create_comment in this demo

The built-in `mock-model` is deterministic and currently triggers a tool named `create_comment` when the prompt contains `comment`.

For the runnable no-key demo, this project maps that tool name to:

```text
POST /workflow/refund/start
```

In a real project using OpenAI or another real model, use a business-specific name instead:

```yaml
- name: start_refund_workflow
  description: Start a refund workflow in the company workflow system.
  method: POST
  path: /workflow/refund/start
```

## Replace the mock workflow API with your company workflow API

Edit `project.yaml`:

```yaml
connectors:
  - id: company-workflow-api
    type: api
    config:
      baseUrl: https://workflow.company.example
      auth:
        type: bearer
        token: ${WORKFLOW_API_TOKEN}
```

Then map your own workflow operations:

```yaml
- name: start_refund_workflow
  description: Start a refund workflow.
  method: POST
  path: /workflow/refund/start

- name: get_workflow_status
  description: Get current workflow status.
  method: GET
  path: /workflow/status
```

## Security note

This example demonstrates the safe boundary:

- agent-bridge does not approve the refund itself.
- agent-bridge only starts the workflow after confirmation.
- The workflow system keeps the business approval state.
- All agent-side tool execution and approval decisions are audited.

For real deployments:

- use staging workflow APIs first
- require confirmation for workflow-starting tools
- keep workflow tokens out of git
- do not let the model bypass the workflow engine
