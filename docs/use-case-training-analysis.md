# Use case: Training data analysis

This use case shows how a company can use agent-bridge for a common enterprise workflow:

> A company system exposes an API for user training statistics. An AI agent reads those statistics, analyzes them against a configured standard, and saves the structured result back through the company API so the company system can persist it in its own database.

The same pattern can be reused for compliance checks, learning plans, customer risk reviews, ticket triage, workflow summaries, or any business process where AI should reason over company data but writes must still go through controlled company APIs.

## Business flow

```text
Company app / operator
  -> starts or resumes an agent-bridge session
  -> agent-bridge calls get_training_stats
  -> company training API returns trusted statistics
  -> AI analyzes the data against the configured standard
  -> agent-bridge pauses before the write tool
  -> human approver reviews the pending save
  -> agent-bridge calls save_training_analysis
  -> company API saves the result to the company database
  -> audit events and session state remain available for review
```

agent-bridge does not replace the company training system. The company system still owns the source data, business database, authentication, and final persistence. agent-bridge provides the runtime layer for safe tool use, approval, auditing, and recovery.

## Example company APIs

A real company could expose APIs like these:

```text
GET  /training/stats?userId=USER-001
POST /training/analysis
```

The read API returns the facts the model is allowed to use:

```json
{
  "userId": "USER-001",
  "requiredCourses": 8,
  "completedCourses": 8,
  "completionRate": 1,
  "averageScore": 91,
  "overdueCourses": 0,
  "weakAreas": ["advanced data privacy scenarios"]
}
```

The write API accepts the structured result that the company system wants to save:

```json
{
  "userId": "USER-001",
  "standardId": "annual-compliance-2026",
  "scoreLevel": "excellent",
  "riskLevel": "low",
  "summary": "User USER-001 completed 8/8 required courses with average score 91.",
  "recommendations": [
    "Keep the current learning cadence and consider assigning advanced courses."
  ],
  "evidence": {
    "completionRate": 1,
    "averageScore": 91,
    "overdueCourses": 0,
    "requiredCourses": 8,
    "completedCourses": 8
  }
}
```

In production, the company API should still validate permissions, required fields, enum values, and business rules before writing to the database.

## agent-bridge project configuration

The runnable demo lives in:

```text
examples/training-analysis-agent/project.yaml
```

The connector maps company API routes to tools:

```yaml
connectors:
  - id: company-training-api
    type: api
    name: Company Training API
    config:
      baseUrl: ${TRAINING_API_BASE_URL}
      timeoutMs: 30000
      auth:
        type: bearer
        token: ${TRAINING_API_TOKEN}
      tools:
        - name: get_training_stats
          method: GET
          path: /training/stats
          queryParams: [userId]

        - name: save_training_analysis
          method: POST
          path: /training/analysis
          bodyParams:
            - userId
            - standardId
            - scoreLevel
            - riskLevel
            - summary
            - recommendations
            - evidence
```

The analysis standard is configuration, not hard-coded TypeScript:

```yaml
analysis:
  standardId: annual-compliance-2026
  levels:
    - level: excellent
      riskLevel: low
      when:
        completionRate:
          gte: 0.9
        averageScore:
          gte: 85
        overdueCourses:
          eq: 0
      recommendations:
        - Keep the current learning cadence and consider assigning advanced courses.
  fallback:
    level: needs_attention
    riskLevel: high
```

The write operation is protected by human confirmation:

```yaml
toolPolicy:
  maxConsecutiveCalls: 6
  confirmationTimeoutMs: 900000
  confirmationRules:
    - tool: save_training_analysis
      requireConfirmation: true
```

This means read tools can run directly, while the save operation pauses in `waiting_confirmation` until an approver accepts it.

## Run with Docker Compose

From the repository root:

```bash
docker compose up --build
```

Open:

```text
http://127.0.0.1:3000/
```

The compose stack starts:

- `agent-bridge` on port `3000`
- a mock training API on port `4020`
- a persistent Docker volume for SQLite state and audit logs

Try this prompt in the console:

```text
analyze training data for USER-001
```

Then approve the pending `save_training_analysis` tool call.

To stop the demo:

```bash
docker compose down
```

## Run manually without Docker

Terminal 1:

```bash
node examples/training-analysis-agent/mock-api.mjs
```

Terminal 2:

```bash
npm run build
TRAINING_API_BASE_URL=http://127.0.0.1:4020 \
TRAINING_API_TOKEN=example-training-token \
node dist/server-main.js --project examples/training-analysis-agent/project.yaml --port 3000
```

Windows PowerShell:

```powershell
$env:TRAINING_API_BASE_URL='http://127.0.0.1:4020'
$env:TRAINING_API_TOKEN='example-training-token'
node dist/server-main.js --project examples/training-analysis-agent/project.yaml --port 3000
```

## How to adapt this to a real company

1. Replace `examples/training-analysis-agent/mock-api.mjs` with the real company API.
2. Keep tokens in environment variables or a secret manager.
3. Change `TRAINING_API_BASE_URL` to the internal API gateway or service URL.
4. Update tool names, paths, query parameters, and body parameters in `project.yaml`.
5. Update the `analysis` section to match the company's scoring or compliance standard.
6. Keep write tools behind confirmation until the company is comfortable automating them.
7. Use the audit log and session history to review what data was read, what result was generated, and who approved the save.
8. Switch the model provider from `custom / mock-model` to `openai` or an OpenAI-compatible gateway for real AI analysis.

## Production checklist for this use case

Before using this pattern in a real environment, verify:

- the company API enforces its own authentication and authorization
- write APIs validate all AI-generated fields server-side
- write tools have confirmation rules or a separate company workflow approval
- secrets are not stored in `project.yaml`
- audit logs are retained according to company policy
- SQLite state is backed up or moved to an approved persistence strategy
- API timeouts and retry behavior match internal SLA expectations
- sensitive fields are covered by `security.redaction.extraSensitiveKeys`
- a rollback or correction process exists for saved analysis records

## Why this is generic

The training example is only one concrete scenario. The reusable structure is:

```text
read company facts -> analyze with configured business rules -> confirm risky action -> write through company API -> audit and recover
```

Any company that can expose controlled APIs can use this structure without changing agent-bridge core code. Most changes happen in `project.yaml`, environment variables, and the company's own API implementation.
