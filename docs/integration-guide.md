# Integration Guide

This guide explains how to connect agent-bridge to your own company systems.

agent-bridge does not know your business by default. You describe your business capabilities as tools in a project configuration file.

## 1. Decide the first business scenario

Start with one concrete scenario. Do not begin by exposing every internal system.

Good first scenarios:

- Query a ticket and summarize it.
- Create a ticket comment after human confirmation.
- Start an existing workflow after human confirmation.
- Query customer/order summary from a read-only API.

Avoid as a first scenario:

- Direct production database writes.
- Broad admin operations.
- Unbounded SQL execution.
- Automatic approval of business workflows.

## 2. Choose an integration pattern

### Pattern A: Existing REST API

Use the built-in `api` connector.

Best for:

- ticket systems
- CRM APIs
- workflow APIs
- monitoring APIs
- internal gateway APIs
- knowledge-base APIs

Example:

```yaml
connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: https://api.company.example
      timeoutMs: 30000
      auth:
        type: bearer
        token: YOUR_API_TOKEN
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
```

### Pattern B: Existing workflow engine

Keep your workflow system as the business source of truth.

Recommended tool shape:

- `start_workflow`
- `get_workflow_status`
- `add_workflow_comment`
- `attach_workflow_evidence`

Recommended flow:

```text
User asks for an action
-> Agent prepares workflow input
-> agent-bridge confirmation asks: may the agent start this workflow?
-> Human approves
-> Agent calls company workflow API
-> Company workflow handles business approval
```

agent-bridge confirmation and your company workflow approval are different layers:

- agent-bridge confirmation controls whether the agent may trigger an external action.
- Company workflow approval controls whether the business action is approved.

### Pattern C: Read-only data access

For databases, prefer exposing a restricted read-only API instead of direct DB access.

Good options:

- internal analytics API
- read-only query gateway
- data warehouse API
- BI API
- read replica with strict allowlists

Rules:

- only allow `SELECT`-style operations
- restrict tables and fields
- set row limits
- set query timeouts; use connector-level `timeoutMs` and override per tool when a specific endpoint needs a tighter limit
- redact sensitive fields
- audit every query

### Pattern D: Custom connector

Write a custom connector when you already have an internal SDK or need non-HTTP protocols.

A connector should:

1. initialize the company client
2. expose a small number of `ToolDefinition`s
3. validate arguments
4. call the real system
5. return structured results
6. avoid leaking secrets in errors or logs

## 3. Map business actions to tools

A tool should be a small, auditable business capability.

Good tools:

```text
get_ticket(ticketId)
create_ticket_comment(ticketId, content)
start_refund_workflow(orderId, reason)
get_customer_summary(customerId)
```

Bad tools:

```text
call_any_api(method, path, body)
run_sql(sql)
admin_execute(command)
update_anything(entity, patch)
```

The model should choose among safe tools, not receive a blank check to operate your whole system.

## 4. Classify risk

Recommended default:

| Operation type | Example | Confirmation |
|---|---|---|
| Read-only | `get_ticket` | usually no |
| Append-only | `create_comment` | yes for internal testing |
| State-changing | `change_status` | yes |
| Money/data deletion | `refund`, `delete_record` | yes, plus company workflow approval |

The built-in REST connector infers risk from HTTP method:

- `GET` -> low
- `POST`, `PUT`, `PATCH` -> medium
- `DELETE` -> high

You can use either a global confirmation policy or tool-specific rules. Tool-specific rules are recommended once you know which tools write data:

```yaml
toolPolicy:
  maxConsecutiveCalls: 5
  confirmationRules:
    - tool: create_comment
      requireConfirmation: true
    - tool: change_status
      requireConfirmation: true
```

## 5. Write the project file

A minimal project contains:

```yaml
id: your-company-agent
name: Your Company Agent

model:
  provider: openai
  model: gpt-4o-mini
  envApiKey: OPENAI_API_KEY
  timeoutMs: 60000

analysis:
  standardId: your-business-standard-v1
  levels:
    - level: healthy
      riskLevel: low
      when:
        score:
          gte: 80
  fallback:
    level: needs_attention
    riskLevel: high

connectors:
  - id: company-api
    type: api
    name: Company API
    config:
      baseUrl: https://api.company.example
      tools: []

systemPrompt: |
  You are an internal company agent.
  Use tools for factual business data.
  Do not invent records.
  Ask for confirmation before state-changing operations.

toolPolicy:
  maxConsecutiveCalls: 5
  confirmationRules:
    - tool: your_write_tool
      requireConfirmation: true

memory:
  enabled: true
  maxMessages: 20
  type: sliding
```

## 6. Project config validation

agent-bridge validates project config at startup. Invalid config fails fast with `PROJECT_CONFIG_INVALID` and an `issues` list containing exact paths.

Current startup validation checks:

- required root fields: `id`, `name`, `model`, `connectors`
- required model fields: `model.provider`, `model.model`
- model options such as `model.timeoutMs`, `model.maxTokens`, `model.temperature`, `model.envApiKey`, and `model.baseUrl`
- analysis standards such as `analysis.levels`, rule conditions, fallback risk level, and recommendations
- duplicate connector ids
- duplicate API tool names across configured API connectors
- API connector `baseUrl`
- API connector/tool `timeoutMs`
- API tool `name`, `description`, `path`, and `method`
- API auth type: `none`, `bearer`, or `apiKey`
- string arrays such as `queryParams` and `bodyParams`
- parameter type and description
- state-changing API tools (`POST`, `PUT`, `PATCH`, `DELETE`) require either `toolPolicy.requireConfirmation: true` or a matching `toolPolicy.confirmationRules` entry

This makes configuration mistakes visible before a company API is called.

## 7. Start small and test the chain

Recommended order:

1. Run the default mock project.
2. Run the ticket example in `examples/company-ticket-agent`.
3. Replace the mock API base URL with a dev/staging company API.
4. Add one read tool.
5. Add one write tool behind confirmation.
6. Turn on API auth.
7. Review audit logs.
8. Restart the service and verify recovery.

## 8. Start the server

```bash
npm run build
node dist/server-main.js --project path/to/project.yaml --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

## 9. Production notes

Before production-like use:

- turn on HTTP API auth
- use environment-specific secrets
- avoid committing connector tokens
- use staging APIs first
- require confirmation for all write tools
- keep company workflow approvals in the company workflow system
- monitor audit logs
- run `npm run build` and `npm run test:run`

## 10. Known current limitations

- Real model support is currently OpenAI-focused.
- Connector config supports `${ENV_VAR}` interpolation in string values and fails fast when a referenced variable is missing.
- The web console is an internal control console, not a polished end-user product.
- Fine-grained enterprise RBAC is still evolving.
- Direct database connector is intentionally not provided as a default safe path.
