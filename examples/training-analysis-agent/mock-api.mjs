import http from 'node:http';
import { URL } from 'node:url';

const host = process.env.TRAINING_API_HOST || '127.0.0.1';
const port = Number(process.env.TRAINING_API_PORT || 4020);
const expectedToken = process.env.TRAINING_API_TOKEN || 'example-training-token';

const trainingStats = new Map([
  [
    'USER-001',
    {
      userId: 'USER-001',
      userName: 'Alice Chen',
      department: 'Customer Success',
      standardId: 'annual-compliance-2026',
      requiredCourses: 8,
      completedCourses: 8,
      completionRate: 1,
      averageScore: 91,
      overdueCourses: 0,
      weakAreas: ['advanced data privacy scenarios'],
      lastActivityAt: '2026-05-16T09:30:00.000Z',
    },
  ],
  [
    'USER-002',
    {
      userId: 'USER-002',
      userName: 'Ben Li',
      department: 'Operations',
      standardId: 'annual-compliance-2026',
      requiredCourses: 8,
      completedCourses: 5,
      completionRate: 0.625,
      averageScore: 68,
      overdueCourses: 2,
      weakAreas: ['security awareness', 'incident escalation'],
      lastActivityAt: '2026-05-10T15:20:00.000Z',
    },
  ],
]);

const savedAnalyses = [];

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
      sendJson(response, 200, { ok: true, service: 'mock-training-api' });
      return;
    }

    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized mock training API request' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/training/stats') {
      const userId = url.searchParams.get('userId') || '';
      const stats = trainingStats.get(userId);

      if (!stats) {
        sendJson(response, 404, { error: 'Training stats not found', userId });
        return;
      }

      sendJson(response, 200, stats);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/training/analysis') {
      const body = await readJson(request);
      const userId = String(body.userId || '');

      if (!trainingStats.has(userId)) {
        sendJson(response, 404, { error: 'Cannot save analysis for unknown user', userId });
        return;
      }

      if (!body.scoreLevel || !body.riskLevel || !body.summary) {
        sendJson(response, 400, { error: 'scoreLevel, riskLevel, and summary are required' });
        return;
      }

      const record = {
        analysisId: `analysis-${savedAnalyses.length + 1}`,
        userId,
        standardId: body.standardId,
        scoreLevel: body.scoreLevel,
        riskLevel: body.riskLevel,
        summary: body.summary,
        recommendations: Array.isArray(body.recommendations) ? body.recommendations : [],
        evidence: body.evidence || {},
        savedAt: new Date().toISOString(),
      };

      savedAnalyses.push(record);
      console.log(`[mock-training-api] analysis saved for ${userId}: ${record.scoreLevel}/${record.riskLevel}`);

      sendJson(response, 200, {
        ok: true,
        record,
        savedCount: savedAnalyses.length,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/training/analysis') {
      const userId = url.searchParams.get('userId');
      const records = userId ? savedAnalyses.filter((item) => item.userId === userId) : savedAnalyses;
      sendJson(response, 200, { records });
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
  console.log(`Mock training API listening on http://${host}:${port}`);
  console.log(`Bearer token: ${expectedToken}`);
  console.log('Available routes:');
  console.log('  GET  /health');
  console.log('  GET  /training/stats?userId=USER-001');
  console.log('  GET  /training/stats?userId=USER-002');
  console.log('  POST /training/analysis');
  console.log('  GET  /training/analysis?userId=USER-001');
});
