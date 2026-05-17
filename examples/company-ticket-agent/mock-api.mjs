import http from 'node:http';
import { URL } from 'node:url';

const host = process.env.TICKET_API_HOST || '127.0.0.1';
const port = Number(process.env.TICKET_API_PORT || 4010);
const expectedToken = process.env.TICKET_API_TOKEN || 'example-ticket-token';

const tickets = new Map([
  [
    'TICKET-001',
    {
      ticketId: 'TICKET-001',
      title: 'Customer cannot access dashboard',
      status: 'open',
      priority: 'high',
      customer: 'Acme Corp',
      assignee: 'support-agent-1',
      comments: [
        {
          author: 'system',
          content: 'Ticket created from customer support portal.',
          createdAt: '2026-05-17T00:00:00.000Z',
        },
      ],
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

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);

    if (url.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'mock-ticket-api' });
      return;
    }

    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized mock ticket API request' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/tickets/detail') {
      const ticketId = url.searchParams.get('ticketId') || '';
      const ticket = tickets.get(ticketId);

      if (!ticket) {
        sendJson(response, 404, { error: 'Ticket not found', ticketId });
        return;
      }

      sendJson(response, 200, ticket);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/tickets/comment') {
      const body = await readJson(request);
      const ticketId = String(body.ticketId || '');
      const content = String(body.content || '');
      const ticket = tickets.get(ticketId);

      if (!ticket) {
        sendJson(response, 404, { error: 'Ticket not found', ticketId });
        return;
      }

      if (!content.trim()) {
        sendJson(response, 400, { error: 'content is required' });
        return;
      }

      const comment = {
        author: 'agent-bridge',
        content,
        createdAt: new Date().toISOString(),
      };

      ticket.comments.push(comment);

      console.log(`[mock-ticket-api] comment added to ${ticketId}: ${content}`);

      sendJson(response, 200, {
        ok: true,
        ticketId,
        comment,
        commentCount: ticket.comments.length,
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
  console.log(`Mock ticket API listening on http://${host}:${port}`);
  console.log(`Bearer token: ${expectedToken}`);
  console.log('Available routes:');
  console.log('  GET  /health');
  console.log('  GET  /tickets/detail?ticketId=TICKET-001');
  console.log('  POST /tickets/comment');
});
