export function getMinimalUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent-bridge Demo Console</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #111827; }
    header { padding: 20px 24px; background: radial-gradient(circle at top left, #2563eb 0, #111827 40%, #020617 100%); color: white; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    header h1 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
    header input { width: 300px; max-width: 42vw; border: 1px solid rgba(255,255,255,.22); border-radius: 10px; padding: 9px 11px; background: rgba(15, 23, 42, .72); color: white; }
    header input::placeholder { color: #cbd5e1; }
    main { display: grid; grid-template-columns: 320px minmax(390px, 1fr) 430px; gap: 16px; padding: 16px; }
    section { background: white; border: 1px solid #e5e7eb; border-radius: 16px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05); overflow: hidden; }
    section h2 { margin: 0; padding: 14px 16px; font-size: 15px; border-bottom: 1px solid #e5e7eb; background: #fafafa; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .body { padding: 14px 16px; }
    button { border: 0; border-radius: 10px; background: #2563eb; color: white; padding: 8px 12px; font-weight: 700; cursor: pointer; }
    button.secondary { background: #4b5563; }
    button.danger { background: #dc2626; }
    button.ghost { background: #eef2ff; color: #1e3a8a; }
    button.success { background: #047857; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    textarea, input, select { width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px 10px; font: inherit; }
    textarea { min-height: 112px; resize: vertical; }
    pre { margin: 0; padding: 12px; background: #0f172a; color: #dbeafe; border-radius: 10px; overflow: auto; font-size: 12px; line-height: 1.45; max-height: 360px; }
    .row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .row > * { flex: 1; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toolbar > * { flex: none; }
    .stack { display: grid; gap: 10px; }
    .hero { display: grid; gap: 6px; max-width: 760px; }
    .tagline { color: #cbd5e1; font-size: 13px; line-height: 1.5; }
    .header-actions { display: grid; gap: 8px; justify-items: end; }
    .mini-flow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .mini-flow span { background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.18); color: #e0f2fe; border-radius: 999px; padding: 4px 8px; font-size: 12px; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px; background: #fff; }
    .card.clickable { cursor: pointer; transition: border-color .15s, background .15s, transform .15s; }
    .card.clickable:hover { border-color: #93c5fd; transform: translateY(-1px); }
    .card.active { border-color: #2563eb; background: #eff6ff; }
    .card.warn { border-color: #f59e0b; background: #fffbeb; }
    .card.error { border-color: #fca5a5; background: #fef2f2; color: #7f1d1d; }
    .hint { border: 1px solid #bfdbfe; background: #eff6ff; color: #1e3a8a; border-radius: 12px; padding: 10px; font-size: 12px; line-height: 1.5; }
    .muted { color: #6b7280; font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .pill { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 2px 8px; background: #e5e7eb; color: #374151; font-size: 12px; margin: 2px 4px 2px 0; }
    .pill.completed, .pill.finished, .pill.approved, .pill.ok { background: #d1fae5; color: #065f46; }
    .pill.waiting_confirmation, .pill.waiting, .pill.pending, .pill.attention { background: #fef3c7; color: #92400e; }
    .pill.failed, .pill.rejected, .pill.blocked, .pill.error { background: #fee2e2; color: #991b1b; }
    .pill.running { background: #dbeafe; color: #1d4ed8; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .kv { display: grid; grid-template-columns: 92px 1fr; gap: 4px 8px; align-items: start; font-size: 12px; }
    .kv .k { color: #6b7280; }
    .status-box { padding: 10px; border-radius: 12px; background: #f8fafc; border: 1px solid #e5e7eb; }
    .analysis-card { background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%); }
    .analysis-card strong { display: block; margin-bottom: 6px; }
    .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
    .metric { border: 1px solid #e5e7eb; border-radius: 10px; padding: 7px; background: #fff; }
    .metric .label { color: #6b7280; font-size: 11px; }
    .metric .value { font-weight: 800; font-size: 14px; }
    .config-grid { display: grid; gap: 8px; }
    .config-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .tool-list { display: grid; gap: 4px; margin-top: 6px; }
    .tool-item { display: grid; grid-template-columns: auto 1fr; gap: 4px 6px; align-items: center; font-size: 12px; }
    .empty { padding: 12px; border: 1px dashed #d1d5db; border-radius: 12px; color: #6b7280; text-align: center; }
    .error-panel { display: none; }
    .error-panel.show { display: block; }
    label.inline { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #dbeafe; }
    label.inline input { width: auto; }
    @media (max-width: 1180px) { main { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } header input { max-width: 100%; width: 100%; } .header-actions { justify-items: stretch; width: 100%; } .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="hero">
      <h1>agent-bridge Demo Console</h1>
      <div class="tagline">Safe runtime for connecting AI agents to company APIs, workflows, and business systems.</div>
      <div class="mini-flow"><span>Company API</span><span>Tool policy</span><span>Human approval</span><span>Audit trail</span></div>
    </div>
    <div class="header-actions">
      <label class="inline"><input id="autoRefresh" type="checkbox" /> Auto refresh every 5s</label>
      <input id="token" placeholder="Bearer token, optional" />
    </div>
  </header>
  <main>
    <section>
      <h2><span>1. Sessions</span><span id="sessionCount" class="pill">0</span></h2>
      <div class="body stack">
        <div class="hint">Create or select a session. A session keeps messages, tool calls, pending approvals, and recovery state.</div>
        <div class="toolbar">
          <button data-action="create-session">New Session</button>
          <button class="ghost" data-action="load-sessions">Refresh</button>
        </div>
        <div id="project" class="muted">Loading project...</div>
        <div id="sessions" class="stack"></div>
      </div>
    </section>

    <section>
      <h2><span>2. Run agent</span><span id="lastRefresh" class="muted">Not refreshed</span></h2>
      <div class="body stack">
        <div class="status-box">
          <div class="muted">Current session</div>
          <div id="currentSession" class="mono">None selected</div>
          <div id="summary" class="muted">No summary yet</div>
        </div>
        <textarea id="input" placeholder="Ask the agent to use company tools. Example: analyze training data for USER-001"></textarea>
        <div class="toolbar">
          <button data-action="run-session">Run</button>
          <button class="secondary" data-action="resume-session">Resume</button>
          <button class="ghost" data-action="refresh-current">Refresh details</button>
        </div>
        <div id="status" class="muted"></div>
        <div id="analysisResult" class="card analysis-card empty">No saved analysis result yet</div>
        <pre id="messages">[]</pre>
      </div>
    </section>

    <section>
      <h2><span>3. Approval & audit</span><span id="pendingCount" class="pill">0 pending</span></h2>
      <div class="body stack">
        <div class="hint">Risky or write tools can pause here for a human decision before the company API is called.</div>
        <div id="pending" class="stack"></div>
        <div id="error" class="card error error-panel"></div>
        <div class="split">
          <div>
            <div class="muted">Tool executions</div>
            <pre id="tools">[]</pre>
          </div>
          <div>
            <div class="muted">Audit events</div>
            <pre id="audit">[]</pre>
          </div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const state = {
      sessionId: localStorage.getItem('agentBridge.sessionId') || '',
      refreshTimer: null,
      busy: false,
    };
    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), 'g'), '&#096;');
    }

    function json(value) {
      return JSON.stringify(value, null, 2);
    }

    function renderJson(value) {
      return '<pre>' + escapeHtml(json(value)) + '</pre>';
    }

    function tokenHeaders() {
      const token = $('token').value.trim();
      return token ? { authorization: 'Bearer ' + token } : {};
    }

    async function api(path, options) {
      const init = options || {};
      init.headers = Object.assign({}, init.headers || {}, tokenHeaders());
      if (init.body && !init.headers['content-type']) init.headers['content-type'] = 'application/json';
      const response = await fetch(path, init);
      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await response.json() : await response.text();
      if (!response.ok) {
        const err = data && data.error ? data.error : { code: 'HTTP_' + response.status, message: String(data), retryable: response.status >= 500 };
        err.statusCode = response.status;
        throw err;
      }
      return data;
    }

    function normalizeRecords(data, primaryKey) {
      if (!data) return [];
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.records)) return data.records;
      if (Array.isArray(data[primaryKey])) return data[primaryKey];
      if (Array.isArray(data.sessions)) return data.sessions;
      return [];
    }

    function getSessionId(item) {
      return item.id || item.sessionId || '';
    }

    function pill(value) {
      const normalized = String(value || 'unknown');
      return '<span class="pill ' + escapeAttr(normalized) + '">' + escapeHtml(normalized) + '</span>';
    }

    function setError(error) {
      const target = $('error');
      if (!error) {
        target.classList.remove('show');
        target.innerHTML = '';
        return;
      }
      const retryable = Boolean(error.retryable);
      target.classList.add('show');
      target.innerHTML =
        '<strong>Error</strong> ' + pill(error.code || 'ERROR') + pill(retryable ? 'retryable' : 'not_retryable') +
        '<div class="kv" style="margin-top:8px">' +
          '<div class="k">message</div><div>' + escapeHtml(error.message || error) + '</div>' +
          '<div class="k">requestId</div><div class="mono">' + escapeHtml(error.requestId || '-') + '</div>' +
          '<div class="k">status</div><div>' + escapeHtml(error.statusCode || '-') + '</div>' +
        '</div>';
    }

    function setStatus(message, kind) {
      $('status').innerHTML = message ? '<span class="pill ' + escapeAttr(kind || 'ok') + '">' + escapeHtml(message) + '</span>' : '';
    }

    function setCurrent(sessionId) {
      state.sessionId = sessionId || '';
      if (state.sessionId) localStorage.setItem('agentBridge.sessionId', state.sessionId);
      $('currentSession').textContent = state.sessionId || 'None selected';
    }

    function setLastRefresh() {
      $('lastRefresh').textContent = new Date().toLocaleTimeString();
    }

    function parseJsonText(text) {
      try {
        return JSON.parse(text || '{}');
      } catch (_) {
        return null;
      }
    }

    function findLatestAnalysisRecord(messages) {
      if (!Array.isArray(messages)) return null;
      for (const message of [...messages].reverse()) {
        if (message.role !== 'tool' || message.name !== 'save_training_analysis') continue;
        const payload = parseJsonText(message.content);
        const record = payload && payload.data && payload.data.record ? payload.data.record : null;
        if (record) return record;
      }
      return null;
    }

    function renderAnalysisResult(messages) {
      const target = $('analysisResult');
      const record = findLatestAnalysisRecord(messages);
      if (!record) {
        target.className = 'card analysis-card empty';
        target.textContent = 'No saved analysis result yet';
        return;
      }

      const evidence = record.evidence || {};
      const recommendations = Array.isArray(record.recommendations) ? record.recommendations : [];
      target.className = 'card analysis-card';
      target.innerHTML =
        '<strong>Last saved analysis result</strong>' +
        '<div>' + pill(record.scoreLevel || '-') + pill(record.riskLevel || '-') + '</div>' +
        '<div class="kv" style="margin-top:8px">' +
          '<div class="k">analysisId</div><div class="mono">' + escapeHtml(record.analysisId || '-') + '</div>' +
          '<div class="k">userId</div><div class="mono">' + escapeHtml(record.userId || '-') + '</div>' +
          '<div class="k">standard</div><div class="mono">' + escapeHtml(record.standardId || '-') + '</div>' +
          '<div class="k">summary</div><div>' + escapeHtml(record.summary || '-') + '</div>' +
        '</div>' +
        '<div class="metric-grid">' +
          metric('completion', evidence.completionRate) +
          metric('avg score', evidence.averageScore) +
          metric('overdue', evidence.overdueCourses) +
          metric('completed', (evidence.completedCourses == null ? '-' : evidence.completedCourses) + '/' + (evidence.requiredCourses == null ? '-' : evidence.requiredCourses)) +
        '</div>' +
        '<div class="muted" style="margin-top:8px">Recommendations</div>' +
        '<ul>' + (recommendations.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') || '<li>None</li>') + '</ul>';
    }

    function metric(label, value) {
      return '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value == null ? '-' : value) + '</div></div>';
    }

    function renderProjectSummary(project) {
      const connectors = Array.isArray(project.connectors) ? project.connectors : [];
      const totalTools = connectors.reduce((sum, connector) => sum + Number(connector.toolCount || 0), 0);
      const redaction = project.security && project.security.redaction ? project.security.redaction : null;
      const analysis = project.analysis || null;
      return '<div class="config-grid">' +
        '<div class="config-title"><strong>' + escapeHtml(project.name || 'Project config') + '</strong>' + pill(project.id || 'project') + '</div>' +
        '<div class="muted">Project config check: model, tools, approval, analysis, and redaction.</div>' +
        '<div class="card">' +
          '<strong>Model</strong>' +
          '<div class="kv" style="margin-top:8px">' +
            '<div class="k">provider</div><div>' + escapeHtml(project.model && project.model.provider || '-') + '</div>' +
            '<div class="k">model</div><div class="mono">' + escapeHtml(project.model && project.model.model || '-') + '</div>' +
            '<div class="k">temperature</div><div>' + escapeHtml(project.model && project.model.temperature != null ? project.model.temperature : '-') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<strong>Connectors</strong> ' + pill(totalTools + ' tools') +
          renderConnectors(connectors) +
        '</div>' +
        '<div class="card">' +
          '<strong>Analysis rules</strong>' +
          '<div style="margin-top:6px">' + (analysis ? pill((analysis.levelsCount || 0) + ' levels') + pill(analysis.fallbackRiskLevel || 'fallback') : pill('not configured')) + '</div>' +
          '<div class="muted mono">standard: ' + escapeHtml(analysis && analysis.standardId || '-') + '</div>' +
        '</div>' +
        '<div class="card">' +
          '<strong>Security redaction</strong>' +
          '<div style="margin-top:6px">' + (redaction && redaction.enabled ? pill('enabled') : pill('built-in only')) + pill(redaction && redaction.replacement || '[REDACTED]') + '</div>' +
          '<div class="muted">extra keys: ' + escapeHtml(redaction && redaction.extraSensitiveKeys && redaction.extraSensitiveKeys.length ? redaction.extraSensitiveKeys.join(', ') : 'none') + '</div>' +
        '</div>' +
        '<div class="card">' +
          '<strong>Tool policy</strong>' +
          '<div style="margin-top:6px">' + renderPolicyPills(project.toolPolicy || {}) + '</div>' +
        '</div>' +
      '</div>';
    }

    function renderConnectors(connectors) {
      if (!connectors.length) return '<div class="empty" style="margin-top:8px">No connectors configured</div>';
      return '<div class="tool-list">' + connectors.map((connector) => {
        const tools = Array.isArray(connector.tools) ? connector.tools : [];
        return '<div class="status-box">' +
          '<div><strong>' + escapeHtml(connector.name || connector.id) + '</strong> ' + pill(connector.type || 'connector') + pill((connector.toolCount || 0) + ' tools') + '</div>' +
          (tools.length ? '<div class="tool-list">' + tools.map(renderToolItem).join('') + '</div>' : '<div class="muted">No configured tool summary</div>') +
        '</div>';
      }).join('') + '</div>';
    }

    function renderToolItem(tool) {
      return '<div class="tool-item"><span>' + pill(tool.method || 'tool') + '</span><span><strong class="mono">' + escapeHtml(tool.name || '-') + '</strong> <span class="muted">' + escapeHtml(tool.path || '') + '</span></span></div>';
    }

    function renderPolicyPills(policy) {
      const parts = [];
      parts.push(pill(policy.requireConfirmation ? 'all tools confirm' : 'rule-based'));
      parts.push(pill('timeout ' + (policy.confirmationTimeoutMs || 900000) + 'ms'));
      if (Array.isArray(policy.confirmationRules)) parts.push(pill(policy.confirmationRules.length + ' rules'));
      if (policy.maxConsecutiveCalls) parts.push(pill('max calls ' + policy.maxConsecutiveCalls));
      return parts.join('');
    }

    async function guarded(fn) {
      if (state.busy) return;
      state.busy = true;
      try {
        setError(null);
        await fn();
      } catch (error) {
        setError(error);
      } finally {
        state.busy = false;
      }
    }

    async function loadProject() {
      try {
        const data = await api('/project');
        $('project').innerHTML = renderProjectSummary(data.project || {});
      } catch (error) {
        $('project').innerHTML = 'Project requires a viewer token. If auth is disabled, you can ignore this message.';
      }
    }

    async function loadSessions() {
      const data = await api('/sessions?limit=20&sortBy=updatedAt&sortOrder=desc');
      const records = normalizeRecords(data, 'sessions');
      $('sessionCount').textContent = String(records.length);
      $('sessions').innerHTML = records.map((item) => {
        const id = getSessionId(item);
        const status = item.status || item.lifecycleStatus || item.executionState || 'unknown';
        const queue = item.queue || item.derivedState?.queue || item.approvalState || '';
        const pending = item.pendingConfirmationCount || item.summary?.pendingConfirmationCount || 0;
        const failed = item.failedToolExecutionCount || item.summary?.failedToolExecutionCount || 0;
        const active = id === state.sessionId ? ' active' : '';
        return '<div class="card clickable' + active + '" data-action="select-session" data-id="' + escapeAttr(id) + '">' +
          '<strong class="mono">' + escapeHtml(id) + '</strong><br />' +
          pill(status) + (queue ? pill(queue) : '') +
          '<div class="muted">pending=' + escapeHtml(pending) + ' · failed=' + escapeHtml(failed) + '</div>' +
        '</div>';
      }).join('') || '<div class="empty">No sessions yet</div>';
    }

    async function createSession() {
      await guarded(async () => {
        const data = await api('/sessions', { method: 'POST' });
        setCurrent(data.sessionId);
        setStatus('created', 'ok');
        await loadSessions();
        await refreshCurrent();
      });
    }

    async function selectSession(sessionId) {
      setCurrent(sessionId);
      await guarded(async () => {
        await loadSessions();
        await refreshCurrent();
      });
    }

    async function runSession() {
      if (!state.sessionId) return setError({ message: 'Create or select a session first.', retryable: false });
      await guarded(async () => {
        const input = $('input').value.trim();
        const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/run', { method: 'POST', body: JSON.stringify({ input }) });
        setStatus('run: ' + data.status, data.status);
        await refreshCurrent();
      });
    }

    async function resumeSession() {
      if (!state.sessionId) return setError({ message: 'Create or select a session first.', retryable: false });
      await guarded(async () => {
        const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/resume', { method: 'POST' });
        setStatus('resume: ' + data.status, data.status);
        await refreshCurrent();
      });
    }

    async function refreshCurrent() {
      if (!state.sessionId) return;
      await Promise.all([loadSummary(), loadMessages(), loadPending(), loadTools(), loadAudit(), loadSessions()]);
      setLastRefresh();
    }

    async function loadSummary() {
      try {
        const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/state-summary');
        const summary = data.summary || data;
        $('summary').innerHTML =
          'status ' + pill(summary.status || summary.lifecycleStatus || '-') +
          ' pending ' + pill(summary.pendingConfirmationCount || 0) +
          ' grants ' + pill(summary.activeGrantCount || 0) +
          ' failed ' + pill(summary.failedToolExecutionCount || 0);
      } catch (error) {
        $('summary').textContent = 'Summary failed to load';
      }
    }

    async function loadMessages() {
      const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/messages');
      const messages = data.messages || data;
      $('messages').textContent = json(messages);
      renderAnalysisResult(messages);
    }

    async function loadPending() {
      const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/pending-confirmations');
      const items = normalizeRecords(data, 'pendingConfirmations');
      $('pendingCount').textContent = items.length + ' pending';
      $('pending').innerHTML = items.map((item) => '<div class="card warn">' +
        '<strong>Pending approval: ' + escapeHtml(item.tool) + '</strong> ' + pill(item.riskLevel || 'risk') +
        '<div class="kv" style="margin:8px 0">' +
          '<div class="k">id</div><div class="mono">' + escapeHtml(item.id) + '</div>' +
          '<div class="k">callId</div><div class="mono">' + escapeHtml(item.callId || '-') + '</div>' +
          '<div class="k">createdAt</div><div>' + escapeHtml(item.createdAt || '-') + '</div>' +
          '<div class="k">reason</div><div>' + escapeHtml(item.reason || '-') + '</div>' +
        '</div>' +
        renderJson(item.args || item) +
        '<div class="toolbar" style="margin-top:10px"><button class="success" data-action="approve" data-id="' + escapeAttr(item.id) + '">Approve</button><button class="danger" data-action="reject" data-id="' + escapeAttr(item.id) + '">Reject</button></div>' +
      '</div>').join('') || '<div class="empty">No pending approvals</div>';
    }

    async function approve(id) {
      await guarded(async () => {
        const data = await api('/confirmations/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: JSON.stringify({ reason: 'approved from demo console' }) });
        setStatus('approve: ' + data.status, data.status);
        await refreshCurrent();
      });
    }

    async function rejectConfirm(id) {
      await guarded(async () => {
        await api('/confirmations/' + encodeURIComponent(id) + '/reject', { method: 'POST', body: JSON.stringify({ reason: 'rejected from demo console' }) });
        setStatus('rejected', 'rejected');
        await refreshCurrent();
      });
    }

    async function loadTools() {
      const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/tool-executions?limit=20');
      $('tools').textContent = json(data.toolExecutions || data.records || data);
    }

    async function loadAudit() {
      const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/audit-events?limit=20');
      $('audit').textContent = json(data.events || data.records || data);
    }

    function updateAutoRefresh() {
      if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
      }
      if ($('autoRefresh').checked) {
        state.refreshTimer = setInterval(() => {
          if (state.sessionId && !state.busy) guarded(refreshCurrent);
        }, 5000);
      }
      localStorage.setItem('agentBridge.autoRefresh', $('autoRefresh').checked ? '1' : '0');
    }

    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (action === 'create-session') createSession();
      if (action === 'load-sessions') guarded(loadSessions);
      if (action === 'select-session') selectSession(id);
      if (action === 'run-session') runSession();
      if (action === 'resume-session') resumeSession();
      if (action === 'refresh-current') guarded(refreshCurrent);
      if (action === 'approve') approve(id);
      if (action === 'reject') rejectConfirm(id);
    });

    $('token').value = localStorage.getItem('agentBridge.token') || '';
    $('token').addEventListener('change', () => {
      localStorage.setItem('agentBridge.token', $('token').value.trim());
      guarded(async () => { await loadProject(); await loadSessions(); if (state.sessionId) await refreshCurrent(); });
    });
    $('autoRefresh').checked = localStorage.getItem('agentBridge.autoRefresh') === '1';
    $('autoRefresh').addEventListener('change', updateAutoRefresh);

    setCurrent(state.sessionId);
    updateAutoRefresh();
    guarded(async () => {
      await loadProject();
      await loadSessions();
      if (state.sessionId) await refreshCurrent();
    });
  </script>
</body>
</html>`;
}
