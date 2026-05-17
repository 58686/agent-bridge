# Security Model

agent-bridge is designed for controlled enterprise-agent experiments. Its core safety idea is simple:

> The model may propose tool calls, but the runtime controls execution, confirmation, persistence, and audit.

## 1. Trust boundaries

Typical deployment:

```text
User / internal operator
        -> agent-bridge HTTP API / Console
        -> Agent runtime, confirmation, audit, persistence
        -> Company APIs / workflow systems / read-only data services
        -> Company databases and business systems
```

agent-bridge should not become an unrestricted gateway to all company data. Expose only small, intentional tools.

## 2. Model boundary

The model is not trusted to enforce business policy by itself.

The runtime should enforce:

- which tools exist
- which tools are forbidden
- which calls require confirmation
- which actor can run or approve actions
- how executions are audited
- how interrupted state is recovered

Project prompts help guide behavior, but prompts are not a security boundary.

## 3. HTTP API authentication

API authentication is optional for local demos and should be enabled for internal testing.

```env
API_AUTH_ENABLED=true
API_AUTH_TOKENS=viewer-token:viewer-1:viewer,operator-token:operator-1:operator,approver-token:approver-1:approver
```

Token format:

```text
token:actorId:role
```

Roles:

| Role | Intended use |
|---|---|
| `viewer` | Read sessions, events, metrics, exports |
| `operator` | Create sessions and run/resume agent work |
| `approver` | Approve or reject confirmations |
| `admin` | Full access |

The minimal console has a Bearer token field for protected APIs.

## 4. Confirmation model

Confirmation is the runtime's human approval gate.

It answers this question:

> May the agent execute this specific tool call with these specific arguments?

It does not replace your company's formal business approval system.

Example with a company workflow:

```text
User asks to start refund
-> Agent prepares workflow request
-> agent-bridge asks for confirmation
-> Approver confirms the agent may call start_refund_workflow
-> Company workflow system starts the refund process
-> Finance/business approvers approve or reject inside the workflow system
```

## 5. Recommended tool safety rules

### Prefer narrow tools

Good:

```text
get_ticket(ticketId)
create_ticket_comment(ticketId, content)
start_refund_workflow(orderId, reason)
```

Avoid:

```text
call_any_endpoint(method, url, body)
run_sql(sql)
execute_shell(command)
```

### Require confirmation for writes

Recommended default for early internal testing:

```yaml
toolPolicy:
  requireConfirmation: true
```

Once your tool list is clear, prefer tool-specific rules so read tools can run directly while write tools pause for approval:

```yaml
toolPolicy:
  confirmationRules:
    - tool: save_training_analysis
      requireConfirmation: true
    - tool: trigger_refund_workflow
      requireConfirmation: true
```

This keeps the approval boundary explicit without slowing down safe read operations.

### Avoid direct production database writes

Preferred path:

```text
Agent -> Business API / Workflow API -> Existing business system -> Database
```

Avoid:

```text
Agent -> Direct production database UPDATE/DELETE
```

For analytics, use read-only APIs, read replicas, or restricted query gateways.

## 6. Secrets

Use environment variables for model keys and server auth tokens:

```env
OPENAI_API_KEY=...
API_AUTH_TOKENS=...
```

Project config supports `${ENV_VAR}` interpolation in string values, including connector secrets:

```yaml
auth:
  type: bearer
  token: ${COMPANY_API_TOKEN}
```

If a referenced variable is missing, startup fails with `PROJECT_CONFIG_ENV_VAR_MISSING`.

Recommended production practice:

- load secrets from environment variables or a secret manager
- keep real project files out of git
- use environment-specific config directories
- rotate tokens regularly

Do not log or commit real API keys.

## 7. Audit model

agent-bridge records structured audit events for important actions, including:

- API access
- session creation
- tool execution start/finish/failure
- confirmation requested
- confirmation approved/rejected
- request failures
- exports and metrics access

Default audit file path:

```text
.agent-data/audit.log
```

Use `requestId`, `sessionId`, `confirmationId`, and tool execution records to debug incidents.

## 8. Recovery model

The runtime persists core state such as:

- sessions
- messages and snapshots
- confirmations
- grants
- tool executions

This allows the service to recover pending confirmation state after restart.

Important boundary:

- Recovery is based on persisted session/tool-call state.
- It is not a general distributed transaction system for external company APIs.
- External systems should still implement idempotency and their own consistency controls.

## 9. Error model

HTTP errors return structured error objects with codes and retryability hints.

Examples:

- `AUTH_REQUIRED`
- `AUTH_FORBIDDEN`
- `CONFIRMATION_EXPIRED`
- `AGENT_ALREADY_RUNNING`
- `OPENAI_API_KEY_MISSING`
- `OPENAI_REQUEST_FAILED`

See [`docs/error-codes.md`](./error-codes.md).

## 10. Production readiness checklist

Before using with real company systems:

- [ ] Use staging APIs first.
- [ ] Enable `API_AUTH_ENABLED=true`.
- [ ] Configure distinct `viewer`, `operator`, and `approver` tokens.
- [ ] Require confirmation for write tools.
- [ ] Avoid direct production DB writes.
- [ ] Use company workflow systems for business approval.
- [ ] Keep secrets out of git.
- [ ] Review audit logs.
- [ ] Verify restart recovery for pending confirmations.
- [ ] Run `npm run build` and `npm run test:run`.

## 11. Safe default philosophy

For open-source users and internal adopters, the safest default is:

```text
read tools first
write tools later
confirmation before writes
audit everything
existing workflow remains the source of truth
```
