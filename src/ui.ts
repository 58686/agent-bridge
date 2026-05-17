export function getMinimalUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent-bridge Demo Console</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #111827; }
    header { padding: 18px 24px; background: linear-gradient(135deg, #111827, #1e3a8a); color: white; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    header h1 { margin: 0; font-size: 18px; }
    header input { width: 300px; max-width: 42vw; border: 1px solid rgba(255,255,255,.22); border-radius: 9px; padding: 8px 10px; background: rgba(15, 23, 42, .72); color: white; }
    header input::placeholder { color: #cbd5e1; }
    main { display: grid; grid-template-columns: 310px minmax(380px, 1fr) 410px; gap: 16px; padding: 16px; }
    section { background: white; border: 1px solid #e5e7eb; border-radius: 14px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05); overflow: hidden; }
    section h2 { margin: 0; padding: 14px 16px; font-size: 15px; border-bottom: 1px solid #e5e7eb; background: #fafafa; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .body { padding: 14px 16px; }
    button { border: 0; border-radius: 9px; background: #2563eb; color: white; padding: 8px 11px; font-weight: 600; cursor: pointer; }
    button.secondary { background: #4b5563; }
    button.danger { background: #dc2626; }
    button.ghost { background: #eef2ff; color: #1e3a8a; }
    button.success { background: #047857; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    textarea, input, select { width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px 10px; font: inherit; }
    textarea { min-height: 96px; resize: vertical; }
    pre { margin: 0; padding: 12px; background: #0f172a; color: #dbeafe; border-radius: 10px; overflow: auto; font-size: 12px; line-height: 1.45; max-height: 360px; }
    .row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .row > * { flex: 1; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toolbar > * { flex: none; }
    .stack { display: grid; gap: 10px; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px; background: #fff; }
    .card.clickable { cursor: pointer; transition: border-color .15s, background .15s, transform .15s; }
    .card.clickable:hover { border-color: #93c5fd; transform: translateY(-1px); }
    .card.active { border-color: #2563eb; background: #eff6ff; }
    .card.warn { border-color: #f59e0b; background: #fffbeb; }
    .card.error { border-color: #fca5a5; background: #fef2f2; color: #7f1d1d; }
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
    .empty { padding: 12px; border: 1px dashed #d1d5db; border-radius: 12px; color: #6b7280; text-align: center; }
    .error-panel { display: none; }
    .error-panel.show { display: block; }
    label.inline { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #dbeafe; }
    label.inline input { width: auto; }
    @media (max-width: 1180px) { main { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } header input { max-width: 100%; width: 100%; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>agent-bridge Demo Console</h1>
      <div class="muted" style="color:#cbd5e1">Developer console for sessions, tool calls, approvals, and audit trails</div>
    </div>
    <div class="toolbar">
      <label class="inline"><input id="autoRefresh" type="checkbox" /> 自动刷新 5s</label>
      <input id="token" placeholder="Bearer token，可留空" />
    </div>
  </header>
  <main>
    <section>
      <h2><span>Sessions</span><span id="sessionCount" class="pill">0</span></h2>
      <div class="body stack">
        <div class="toolbar">
          <button data-action="create-session">新建 Session</button>
          <button class="ghost" data-action="load-sessions">刷新</button>
        </div>
        <div id="project" class="muted">加载 project...</div>
        <div id="sessions" class="stack"></div>
      </div>
    </section>

    <section>
      <h2><span>Run / Messages</span><span id="lastRefresh" class="muted">未刷新</span></h2>
      <div class="body stack">
        <div class="status-box">
          <div class="muted">当前 Session</div>
          <div id="currentSession" class="mono">未选择</div>
          <div id="summary" class="muted">暂无摘要</div>
        </div>
        <textarea id="input" placeholder="输入要让 Agent 执行的任务，例如：请创建评论"></textarea>
        <div class="toolbar">
          <button data-action="run-session">Run</button>
          <button class="secondary" data-action="resume-session">Resume</button>
          <button class="ghost" data-action="refresh-current">刷新详情</button>
        </div>
        <div id="status" class="muted"></div>
        <pre id="messages">[]</pre>
      </div>
    </section>

    <section>
      <h2><span>Approval / Debug</span><span id="pendingCount" class="pill">0 pending</span></h2>
      <div class="body stack">
        <div id="pending" class="stack"></div>
        <div id="error" class="card error error-panel"></div>
        <div class="split">
          <div>
            <div class="muted">Tool Executions</div>
            <pre id="tools">[]</pre>
          </div>
          <div>
            <div class="muted">Audit Events</div>
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
        '<strong>错误</strong> ' + pill(error.code || 'ERROR') + pill(retryable ? 'retryable' : 'not_retryable') +
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
      $('currentSession').textContent = state.sessionId || '未选择';
    }

    function setLastRefresh() {
      $('lastRefresh').textContent = new Date().toLocaleTimeString();
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
        $('project').innerHTML = escapeHtml(data.project.name) + '<br /><span class="mono">' + escapeHtml(data.project.id) + '</span>';
      } catch (error) {
        $('project').innerHTML = 'Project 需要 viewer token；如未开启鉴权可忽略。';
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
      }).join('') || '<div class="empty">暂无 session</div>';
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
      if (!state.sessionId) return setError({ message: '请先创建或选择 session', retryable: false });
      await guarded(async () => {
        const input = $('input').value.trim();
        const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/run', { method: 'POST', body: JSON.stringify({ input }) });
        setStatus('run: ' + data.status, data.status);
        await refreshCurrent();
      });
    }

    async function resumeSession() {
      if (!state.sessionId) return setError({ message: '请先创建或选择 session', retryable: false });
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
        $('summary').textContent = '摘要加载失败';
      }
    }

    async function loadMessages() {
      const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/messages');
      $('messages').textContent = json(data.messages || data);
    }

    async function loadPending() {
      const data = await api('/sessions/' + encodeURIComponent(state.sessionId) + '/pending-confirmations');
      const items = normalizeRecords(data, 'pendingConfirmations');
      $('pendingCount').textContent = items.length + ' pending';
      $('pending').innerHTML = items.map((item) => '<div class="card warn">' +
        '<strong>待审批：' + escapeHtml(item.tool) + '</strong> ' + pill(item.riskLevel || 'risk') +
        '<div class="kv" style="margin:8px 0">' +
          '<div class="k">id</div><div class="mono">' + escapeHtml(item.id) + '</div>' +
          '<div class="k">callId</div><div class="mono">' + escapeHtml(item.callId || '-') + '</div>' +
          '<div class="k">createdAt</div><div>' + escapeHtml(item.createdAt || '-') + '</div>' +
          '<div class="k">reason</div><div>' + escapeHtml(item.reason || '-') + '</div>' +
        '</div>' +
        renderJson(item.args || item) +
        '<div class="toolbar" style="margin-top:10px"><button class="success" data-action="approve" data-id="' + escapeAttr(item.id) + '">Approve</button><button class="danger" data-action="reject" data-id="' + escapeAttr(item.id) + '">Reject</button></div>' +
      '</div>').join('') || '<div class="empty">无待审批项</div>';
    }

    async function approve(id) {
      await guarded(async () => {
        const data = await api('/confirmations/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: JSON.stringify({ reason: 'approved from minimal ui' }) });
        setStatus('approve: ' + data.status, data.status);
        await refreshCurrent();
      });
    }

    async function rejectConfirm(id) {
      await guarded(async () => {
        await api('/confirmations/' + encodeURIComponent(id) + '/reject', { method: 'POST', body: JSON.stringify({ reason: 'rejected from minimal ui' }) });
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
