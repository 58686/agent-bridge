# Training Analysis Agent

This runnable example shows a common enterprise scenario:

> A company system exposes training statistics through an API. agent-bridge lets an AI agent fetch the data, analyze it against a configured standard, and save the structured result back through the company API.

## Flow

```text
Company app / operator
  -> agent-bridge session
  -> get_training_stats
  -> AI analysis against the standard
  -> save_training_analysis
  -> company database
```

In this demo the company API is a local mock server. In production, replace it with your real training platform or internal API gateway.

## Why this is useful

This pattern keeps clear boundaries:

- the company system owns training data and database writes
- the AI model performs analysis and creates a structured result
- agent-bridge controls tool access, approval, audit logs, and recovery
- write operations can require human confirmation before they hit the company API

## Run the demo

From the repository root:

```bash
npm install
npm run build
```

Terminal 1: start the mock training API.

```bash
node examples/training-analysis-agent/mock-api.mjs
```

Terminal 2: start agent-bridge with this project config.

```bash
# macOS / Linux
export TRAINING_API_BASE_URL=http://127.0.0.1:4020
export TRAINING_API_TOKEN=example-training-token
node dist/server-main.js --project examples/training-analysis-agent/project.yaml --port 3000
```

```powershell
# Windows PowerShell
$env:TRAINING_API_BASE_URL='http://127.0.0.1:4020'
$env:TRAINING_API_TOKEN='example-training-token'
node dist/server-main.js --project examples/training-analysis-agent/project.yaml --port 3000
```

Open:

```text
http://127.0.0.1:3000/
```

## Try it

1. Click **New Session**.
2. Enter:

```text
analyze training data for USER-001
```

3. Click **Run**.
4. agent-bridge calls `get_training_stats` without approval because no confirmation rule is attached to the read tool.
5. The mock model prepares a structured result and calls `save_training_analysis`, which has a tool-specific confirmation rule.
6. Because saving is a write operation, the session enters `waiting_confirmation`.
7. Click **Approve**.
8. The mock company API saves the result and agent-bridge records tool execution and audit events.

Try a riskier user:

```text
analyze training data for USER-002
```

## Analysis standard

The demo standard is defined in `project.yaml`:

| Level | Rule |
|---|---|
| `excellent` | `completionRate >= 0.90`, `averageScore >= 85`, and `overdueCourses = 0` |
| `qualified` | `completionRate >= 0.75` and `averageScore >= 70` |
| `needs_attention` | Anything below `qualified` |

The saved result includes:

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

## API routes in the mock server

```text
GET  /health
GET  /training/stats?userId=USER-001
GET  /training/stats?userId=USER-002
POST /training/analysis
GET  /training/analysis?userId=USER-001
```

## Production notes

For a real company integration:

- replace the mock API with your training platform API
- keep real tokens in environment variables or a secret manager
- keep `save_training_analysis` behind confirmation if humans must review AI decisions
- store final results through your existing business API, not direct database writes
- use audit exports to review who approved saves and what data was written
