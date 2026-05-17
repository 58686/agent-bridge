# Security Policy

agent-bridge is designed for connecting AI agents to company systems. Please treat any deployment as security-sensitive.

## Reporting a vulnerability

If you find a vulnerability, please do not open a public issue with exploit details.

Recommended reporting path:

1. Open a private GitHub security advisory for this repository, if available.
2. If private advisories are unavailable, contact the repository owner with a minimal description and reproduction steps.
3. Do not include real customer data, production tokens, or secrets in the report.

Please include:

- affected version or commit
- deployment mode
- project configuration shape, with secrets redacted
- reproduction steps
- expected impact

## Supported versions

This project is currently an early MVP. Security fixes target the `main` branch unless release branches are introduced later.

## Security model

agent-bridge should sit between an AI agent and company systems:

```text
AI model -> agent-bridge -> company API / workflow system
```

Recommended boundaries:

- expose business capabilities as controlled tools
- require approval for risky or state-changing tools
- keep existing company APIs and workflow engines as the source of truth
- persist audit events for tool calls, approvals, denials, and failures
- avoid direct writes to production databases

## Secrets

Do not commit real secrets.

Use environment variables or a secret manager for:

- `OPENAI_API_KEY`
- `API_AUTH_TOKENS`
- connector bearer tokens
- connector API keys
- database credentials, if added in your deployment

The repository intentionally ignores:

- `.env`
- `.env.*` except `.env.example`
- `.agent-data/`
- `*.sqlite`
- logs and build output

## Production hardening checklist

Before using agent-bridge with real company systems:

- enable API authentication
- use distinct `viewer`, `operator`, and `approver` tokens
- require approval for write tools and high-risk actions
- restrict connector credentials to least privilege
- use staging APIs before production APIs
- define clear timeout settings for external APIs
- review audit logs and exports regularly
- redact sensitive fields from tool inputs and outputs
- run behind TLS and your normal ingress/auth controls
- monitor failed tool executions and rejected approvals

## AI-specific risks

AI models can misunderstand instructions or produce incorrect analysis. Do not rely on model output as the only control for high-impact actions.

Use agent-bridge controls:

- keep tool schemas narrow
- validate project configuration at startup
- require human approval for writes
- store audit trails
- route final writes through company APIs that enforce business rules

## Example tokens

Example tokens in docs and tests, such as `example-training-token` or `viewer-token`, are not secrets. Replace them before any real deployment.
