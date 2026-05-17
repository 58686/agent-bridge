import http from 'node:http';
import { URL } from 'node:url';

const host = process.env.WORKFLOW_API_HOST || '127.0.0.1';
const port = Number(process.env.WORKFLOW_API_PORT || 4020);
const expectedToken = process.env.WORKFLOW_API_TOKEN || 'example-workflow-token';

let nextWorkflowNumber = 1;
const workflows = new Map([
  [
    'WF-001',
    {
      workflowId: 'WF-001',
      type: 'refund',
      status: 'pending_business_approval',
      subjectId: 'ORDER-001',
      reason: 'Customer reported duplicate charge.',
      createdBy: 'finance-operator-1',
      createdAt: '2026-05-17T00:00:00.000Z',
      approvalSystem: 'mock-company-workflow',
    },
  ],
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

function isAuthorized(request) {
  const authorization = request.headers.authorization || '';
  return authorization === `Bearer ${expectedToken}`;
}

function nextWorkflowId() {
  nextWorkflowNumber += 1;
  return `WF-${String(nextWorkflowNumber).padStart(3, '0')}`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);

    if (url.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'mock-workflow-api' });
      return;
    }

    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized mock workflow API request' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/workflow/status') {
      const workflowId = url.searchParams.get('workflowId') || '';
      const workflow = workflows.get(workflowId);

      if (!workflow) {
        sendJson(response, 404, { error: 'Workflow not found', workflowId });
        return;
      }

      sendJson(response, 200, workflow);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/workflow/refund/start') {
      const body = await readJson(request);
      const subjectId = String(body.ticketId || body.orderId || '');
      const reason = String(body.content || body.reason || '');

      if (!subjectId.trim()) {
        sendJson(response, 400, { error: 'subject id is required' });
        return;
      }

      if (!reason.trim()) {
        sendJson(response, 400, { error: 'reason is required' });
        return;
      }

      const workflowId = nextWorkflowId();
      const workflow = {
        workflowId,
        type: 'refund',
        status: 'pending_business_approval',
        subjectId,
        reason,
        createdBy: 'agent-bridge',
        createdAt: new Date().toISOString(),
        approvalSystem: 'mock-company-workflow',
      };

      workflows.set(workflowId, workflow);

      console.log(`[mock-workflow-api] refund workflow started: ${workflowId} for ${subjectId}`);

      sendJson(response, 200, {
        ok: true,
        workflow,
        note: 'Business approval is still handled by the company workflow system.',
      });
      return;
    }

    sendJson(response, 404, {
      error: 'Route not found',
      method: request.method,
      path: url.pathname,
    });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Mock workflow API listening on http://${host}:${port}`);
  console.log(`Bearer token: ${expectedToken}`);
  console.log('Available routes:');
  console.log('  GET  /health');
  console.log('  GET  /workflow/status?workflowId=WF-001');
  console.log('  POST /workflow/refund/start');
});
