// @ts-nocheck
/**
 * @fileoverview Inline HTML multi-agent dashboard SPA for Wunderland Hub.
 * @module wunderland/cli/commands/dashboard/routes/hub-html
 *
 * Self-contained SPA with 3 tabs: Agents, Spawn, Logs.
 * Same cyberpunk theme (dark/light toggle) as the per-agent dashboard.
 * Zero build step, zero external dependencies.
 */

// eslint-disable-next-line no-irregular-whitespace
export const HUB_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wunderland Hub</title>
    <style>
      /* ---- CSS Variables -- dark mode (default) ---- */
      :root, [data-theme="dark"] {
        --bg: #0b1020;
        --panel: #111833;
        --text: #e8ecff;
        --muted: #9aa6d8;
        --accent: #53d6c7;
        --danger: #ff6b6b;
        --ok: #63e6be;
        --warn: #ffd43b;
        --font-sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --bg-gradient: radial-gradient(1200px 800px at 20% 20%, #18244a, var(--bg));
        --header-bg: rgba(11,16,32,0.85);
        --tabs-bg: rgba(11,16,32,0.6);
        --card-bg: rgba(17,24,51,0.78);
        --input-bg: rgba(0,0,0,0.22);
        --border: rgba(255,255,255,0.10);
        --border-subtle: rgba(255,255,255,0.06);
        --border-hover: rgba(255,255,255,0.14);
        --shadow: rgba(0,0,0,0.22);
      }
      /* ---- Light mode ---- */
      [data-theme="light"] {
        --bg: #f5f6fa;
        --panel: #ffffff;
        --text: #1a1e2e;
        --muted: #5c6380;
        --accent: #0e9384;
        --danger: #dc3545;
        --ok: #198754;
        --warn: #cc8a00;
        --bg-gradient: linear-gradient(135deg, #eef1f8, #f5f6fa);
        --header-bg: rgba(255,255,255,0.88);
        --tabs-bg: rgba(245,246,250,0.9);
        --card-bg: rgba(255,255,255,0.92);
        --input-bg: rgba(0,0,0,0.04);
        --border: rgba(0,0,0,0.10);
        --border-subtle: rgba(0,0,0,0.06);
        --border-hover: rgba(0,0,0,0.18);
        --shadow: rgba(0,0,0,0.06);
      }

      /* ---- Reset & base ---- */
      *, *::before, *::after { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--font-sans);
        background: var(--bg-gradient);
        color: var(--text);
        min-height: 100vh;
        transition: background 0.3s, color 0.3s;
      }

      /* ---- Header ---- */
      header {
        padding: 12px 20px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        backdrop-filter: blur(6px);
        position: sticky;
        top: 0;
        background: var(--header-bg);
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .header-left { display: flex; align-items: center; gap: 14px; }
      .header-left h1 { margin: 0; font-size: 16px; letter-spacing: 0.2px; }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--border-hover);
        font-size: 11px;
        color: var(--muted);
      }
      .pill.ok { border-color: rgba(99,230,190,0.3); color: var(--ok); }
      .pill .dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--muted);
      }
      .pill.ok .dot { background: var(--ok); }
      .header-right { display: flex; align-items: center; gap: 8px; }

      /* ---- Tabs ---- */
      .tabs {
        display: flex;
        gap: 2px;
        padding: 0 20px;
        background: var(--tabs-bg);
        border-bottom: 1px solid var(--border-subtle);
        overflow-x: auto;
      }
      .tab {
        padding: 10px 16px;
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        white-space: nowrap;
        transition: color 0.15s, border-color 0.15s;
        user-select: none;
      }
      .tab:hover { color: var(--text); }
      .tab.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }

      /* ---- Main content ---- */
      main {
        padding: 18px 20px;
        max-width: 1200px;
        margin: 0 auto;
      }
      .tab-content { display: none; }
      .tab-content.active { display: block; }

      /* ---- Auth card ---- */
      .auth-card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px;
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .auth-card label { font-size: 12px; color: var(--muted); font-weight: 600; }
      input, textarea {
        border-radius: 10px;
        border: 1px solid var(--border-hover);
        background: var(--input-bg);
        color: var(--text);
        padding: 8px 10px;
        font-family: var(--font-sans);
        font-size: 13px;
        outline: none;
      }
      input:focus, textarea:focus {
        border-color: rgba(83,214,199,0.4);
      }
      .auth-card input { width: 280px; max-width: 100%; }
      .auth-hint { font-size: 11px; color: var(--muted); }
      .secret-wrap { position: relative; display: inline-flex; align-items: center; }
      .secret-wrap input { padding-right: 32px; }
      .eye-toggle {
        position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
        background: none; border: none; color: var(--muted); cursor: pointer;
        font-size: 14px; padding: 2px 4px; line-height: 1;
      }
      .eye-toggle:hover { color: var(--accent); }

      /* ---- Card ---- */
      .card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 20px 40px var(--shadow);
        margin-bottom: 16px;
      }
      .card h2 {
        margin: 0 0 10px;
        font-size: 13px;
        color: var(--muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      /* ---- Buttons ---- */
      button {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        padding: 8px 12px;
        border-radius: 10px;
        cursor: pointer;
        font-weight: 600;
        font-size: 12px;
        transition: border-color 0.15s, background 0.15s;
      }
      button:hover { border-color: rgba(83,214,199,0.55); }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      button.ok { background: rgba(99,230,190,0.12); border-color: rgba(99,230,190,0.28); }
      button.bad { background: rgba(255,107,107,0.10); border-color: rgba(255,107,107,0.30); }
      button.accent { background: rgba(83,214,199,0.12); border-color: rgba(83,214,199,0.35); }

      /* ---- Agent grid ---- */
      .agent-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 14px;
      }
      .agent-card {
        background: rgba(0,0,0,0.14);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px;
        transition: border-color 0.2s;
      }
      .agent-card:hover { border-color: var(--border-hover); }
      .agent-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 10px;
      }
      .agent-name {
        font-weight: 700;
        font-size: 14px;
        word-break: break-word;
      }
      .agent-seed {
        font-family: var(--font-mono);
        font-size: 10px;
        color: var(--muted);
        margin-top: 2px;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        flex-shrink: 0;
      }
      .status-pill.running {
        background: rgba(99,230,190,0.12);
        color: var(--ok);
        border: 1px solid rgba(99,230,190,0.25);
      }
      .status-pill.stopped {
        background: rgba(255,255,255,0.06);
        color: var(--muted);
        border: 1px solid var(--border);
      }
      .status-pill .sdot {
        width: 5px; height: 5px; border-radius: 50%;
      }
      .status-pill.running .sdot { background: var(--ok); }
      .status-pill.stopped .sdot { background: var(--muted); }
      .agent-meta {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px 12px;
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 10px;
      }
      .agent-meta span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .agent-meta .val { color: var(--text); }
      .agent-actions { display: flex; gap: 6px; flex-wrap: wrap; }

      /* ---- Spawn form ---- */
      .spawn-form textarea {
        width: 100%;
        min-height: 80px;
        resize: vertical;
        margin-bottom: 10px;
      }
      .spawn-form .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .spawn-form input { width: 100px; }
      .spawn-result {
        margin-top: 14px;
        padding: 12px;
        border-radius: 10px;
        font-size: 12px;
        white-space: pre-wrap;
        font-family: var(--font-mono);
        max-height: 300px;
        overflow-y: auto;
      }
      .spawn-result.ok { background: rgba(99,230,190,0.08); border: 1px solid rgba(99,230,190,0.2); color: var(--ok); }
      .spawn-result.error { background: rgba(255,107,107,0.08); border: 1px solid rgba(255,107,107,0.2); color: var(--danger); }
      .spawn-result.pending { background: rgba(83,214,199,0.06); border: 1px solid rgba(83,214,199,0.15); color: var(--accent); }

      /* ---- Logs viewer ---- */
      .logs-header { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
      .logs-header select {
        border-radius: 10px;
        border: 1px solid var(--border-hover);
        background: var(--input-bg);
        color: var(--text);
        padding: 6px 10px;
        font-size: 12px;
        outline: none;
        min-width: 180px;
      }
      .logs-viewer {
        background: rgba(0,0,0,0.3);
        border: 1px solid var(--border-subtle);
        border-radius: 10px;
        padding: 12px;
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1.6;
        max-height: 500px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--text);
      }
      .logs-empty { color: var(--muted); font-style: italic; }

      /* ---- Theme toggle ---- */
      .theme-toggle {
        background: none;
        border: 1px solid var(--border-hover);
        border-radius: 8px;
        padding: 6px 8px;
        cursor: pointer;
        color: var(--muted);
        font-size: 16px;
        line-height: 1;
        transition: color 0.2s, border-color 0.2s;
      }
      .theme-toggle:hover { color: var(--accent); border-color: var(--accent); }

      /* ---- Scrollbar ---- */
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

      /* ---- Empty state ---- */
      .empty-state {
        text-align: center;
        padding: 40px 20px;
        color: var(--muted);
        font-size: 13px;
      }
      .empty-state .big { font-size: 32px; margin-bottom: 10px; }

      /* ---- Status text ---- */
      .status-text { font-size: 12px; color: var(--muted); }
    </style>
  </head>
  <body>
    <!-- Header -->
    <header>
      <div class="header-left">
        <h1>Wunderland Hub</h1>
        <span class="pill" id="agentCountPill">
          <span class="dot"></span>
          <span id="agentCount">0 agents</span>
        </span>
      </div>
      <div class="header-right">
        <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle light/dark mode">&#9790;</button>
      </div>
    </header>

    <!-- Tab bar -->
    <nav class="tabs" id="tabBar">
      <div class="tab active" data-tab="agents">Agents</div>
      <div class="tab" data-tab="spawn">Spawn</div>
      <div class="tab" data-tab="logs">Logs</div>
    </nav>

    <!-- Main -->
    <main>
      <!-- Auth card -->
      <div class="auth-card" id="authCard">
        <label>Admin Secret</label>
        <span class="secret-wrap">
          <input id="secretInput" type="password" placeholder="Paste from terminal output" />
          <button class="eye-toggle" id="eyeToggle" type="button" title="Show/hide secret" onclick="toggleSecretVisibility()">&#128065;</button>
        </span>
        <button class="ok" id="connectBtn" onclick="authenticate()">Connect</button>
        <span class="auth-hint" id="authHint">Find this in the terminal where you ran <code>wunderland dashboard</code></span>
      </div>

      <!-- Agents tab -->
      <div class="tab-content active" id="tab-agents">
        <div class="card">
          <h2>Agent Fleet</h2>
          <div id="agentGrid" class="agent-grid">
            <div class="empty-state">
              <div class="big">&#128373;</div>
              Enter admin secret and click Connect to load agents.
            </div>
          </div>
        </div>
      </div>

      <!-- Spawn tab -->
      <div class="tab-content" id="tab-spawn">
        <div class="card">
          <h2>Spawn New Agent</h2>
          <div class="spawn-form">
            <textarea id="spawnDesc" placeholder="Describe your agent in plain English...&#10;e.g. A research assistant that monitors AI news"></textarea>
            <div class="row">
              <label style="font-size:12px;color:var(--muted);font-weight:600">Port (optional):</label>
              <input id="spawnPort" type="number" placeholder="auto" min="1" max="65535" />
              <button class="accent" id="spawnBtn" onclick="spawnAgent()">Spawn</button>
            </div>
          </div>
          <div id="spawnResult" style="display:none"></div>
        </div>
      </div>

      <!-- Logs tab -->
      <div class="tab-content" id="tab-logs">
        <div class="card">
          <h2>Agent Logs</h2>
          <div class="logs-header">
            <select id="logAgentSelect" onchange="loadLogs()">
              <option value="">-- Select an agent --</option>
            </select>
            <button onclick="loadLogs()">Refresh</button>
            <button onclick="clearLogViewer()">Clear</button>
          </div>
          <div id="logViewer" class="logs-viewer">
            <span class="logs-empty">Select a running agent to view logs.</span>
          </div>
        </div>
      </div>
    </main>

    <script>
      /* ---- State ---- */
      let secret = '';
      let authenticated = false;
      let agents = [];
      let refreshTimer = null;
      let logPollTimer = null;

      /* ---- Theme ---- */
      function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('wunderland-hub-theme', next);
        document.getElementById('themeToggle').innerHTML = next === 'dark' ? '&#9790;' : '&#9788;';
      }
      (function initTheme() {
        const saved = localStorage.getItem('wunderland-hub-theme');
        if (saved) {
          document.documentElement.setAttribute('data-theme', saved);
          document.getElementById('themeToggle').innerHTML = saved === 'dark' ? '&#9790;' : '&#9788;';
        }
      })();

      /* ---- Secret visibility ---- */
      function toggleSecretVisibility() {
        const inp = document.getElementById('secretInput');
        inp.type = inp.type === 'password' ? 'text' : 'password';
      }

      /* ---- Tabs ---- */
      document.getElementById('tabBar').addEventListener('click', function(e) {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = document.getElementById('tab-' + tab.dataset.tab);
        if (target) target.classList.add('active');
      });

      /* ---- Auth ---- */
      function authenticate() {
        secret = document.getElementById('secretInput').value.trim();
        if (!secret) { alert('Please enter the admin secret.'); return; }
        authenticated = true;
        document.getElementById('authHint').textContent = 'Authenticated';
        document.getElementById('authHint').style.color = 'var(--ok)';
        document.getElementById('connectBtn').textContent = 'Connected';
        document.getElementById('connectBtn').disabled = true;
        fetchAgents();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(fetchAgents, 10000);
      }

      /* Allow Enter key in secret input */
      document.getElementById('secretInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') authenticate();
      });

      /* ---- API helpers ---- */
      function apiUrl(path) {
        return path + (path.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
      }

      async function apiFetch(path, opts) {
        const res = await fetch(apiUrl(path), opts || {});
        if (res.status === 401) {
          authenticated = false;
          document.getElementById('authHint').textContent = 'Invalid secret. Please re-enter.';
          document.getElementById('authHint').style.color = 'var(--danger)';
          document.getElementById('connectBtn').textContent = 'Connect';
          document.getElementById('connectBtn').disabled = false;
          throw new Error('Unauthorized');
        }
        return res;
      }

      /* ---- Fetch agents ---- */
      async function fetchAgents() {
        if (!authenticated) return;
        try {
          const res = await apiFetch('/api/agents');
          agents = await res.json();
          renderAgents();
          updateAgentCount();
          updateLogSelect();
        } catch (e) {
          if (e.message !== 'Unauthorized') console.error('Failed to fetch agents:', e);
        }
      }

      /* ---- Render agent grid ---- */
      function renderAgents() {
        const grid = document.getElementById('agentGrid');
        if (!agents.length) {
          grid.innerHTML = '<div class="empty-state"><div class="big">&#128373;</div>No agents found. Create one in the Spawn tab.</div>';
          return;
        }
        grid.innerHTML = agents.map(a => {
          const running = a.status === 'running';
          const statusClass = running ? 'running' : 'stopped';
          const uptimeStr = a.uptime ? formatUptime(a.uptime) : '--';
          const memStr = a.memory ? formatBytes(a.memory.rss || 0) : '--';
          const toolsStr = typeof a.tools === 'number' ? a.tools : '--';
          const channelsStr = typeof a.channels === 'number' ? a.channels : '--';
          const portStr = a.port ? a.port : '--';

          let actions = '';
          if (running) {
            actions += '<button class="accent" onclick="openDashboard(' + a.port + ')">Open Dashboard</button>';
            actions += '<button class="bad" onclick="stopAgent(\\'' + escAttr(a.seedId) + '\\')">Stop</button>';
          } else {
            actions += '<button class="ok" onclick="startAgent(\\'' + escAttr(a.seedId) + '\\')">Start</button>';
          }

          return '<div class="agent-card">' +
            '<div class="agent-card-header">' +
              '<div><div class="agent-name">' + esc(a.name || a.seedId) + '</div>' +
                '<div class="agent-seed">' + esc(a.seedId) + '</div></div>' +
              '<span class="status-pill ' + statusClass + '"><span class="sdot"></span>' + statusClass + '</span>' +
            '</div>' +
            '<div class="agent-meta">' +
              '<span>Port</span><span class="val">' + portStr + '</span>' +
              '<span>Uptime</span><span class="val">' + uptimeStr + '</span>' +
              '<span>Memory</span><span class="val">' + memStr + '</span>' +
              '<span>Tools</span><span class="val">' + toolsStr + '</span>' +
              '<span>Channels</span><span class="val">' + channelsStr + '</span>' +
            '</div>' +
            '<div class="agent-actions">' + actions + '</div>' +
          '</div>';
        }).join('');
      }

      function updateAgentCount() {
        const running = agents.filter(a => a.status === 'running').length;
        const total = agents.length;
        const el = document.getElementById('agentCount');
        el.textContent = total + ' agent' + (total !== 1 ? 's' : '') + ' (' + running + ' running)';
        const pill = document.getElementById('agentCountPill');
        pill.className = 'pill' + (running > 0 ? ' ok' : '');
      }

      /* ---- Agent actions ---- */
      function openDashboard(port) {
        window.open('http://localhost:' + port + '/', '_blank');
      }

      async function startAgent(seedId) {
        try {
          const res = await apiFetch('/api/agents/' + encodeURIComponent(seedId) + '/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const data = await res.json();
          if (!res.ok) { alert('Failed to start: ' + (data.error || 'unknown error')); return; }
          setTimeout(fetchAgents, 2000);
        } catch (e) {
          alert('Error starting agent: ' + e.message);
        }
      }

      async function stopAgent(seedId) {
        try {
          const res = await apiFetch('/api/agents/' + encodeURIComponent(seedId) + '/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const data = await res.json();
          if (!res.ok) { alert('Failed to stop: ' + (data.error || 'unknown error')); return; }
          setTimeout(fetchAgents, 1000);
        } catch (e) {
          alert('Error stopping agent: ' + e.message);
        }
      }

      /* ---- Spawn ---- */
      async function spawnAgent() {
        const desc = document.getElementById('spawnDesc').value.trim();
        if (!desc) { alert('Please describe your agent.'); return; }
        const portVal = document.getElementById('spawnPort').value.trim();
        const port = portVal ? parseInt(portVal, 10) : undefined;

        const resultEl = document.getElementById('spawnResult');
        resultEl.style.display = 'block';
        resultEl.className = 'spawn-result pending';
        resultEl.textContent = 'Spawning agent... this may take a moment.';

        const btn = document.getElementById('spawnBtn');
        btn.disabled = true;

        try {
          const body = { description: desc };
          if (port && port > 0 && port <= 65535) body.port = port;

          const res = await apiFetch('/api/spawn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();

          if (res.ok) {
            resultEl.className = 'spawn-result ok';
            resultEl.textContent = 'Agent spawned successfully!\\n\\n' +
              'Name: ' + (data.displayName || data.seedId) + '\\n' +
              'Seed ID: ' + (data.seedId || '--') + '\\n' +
              'Port: ' + (data.port || '--') + '\\n' +
              'Config: ' + (data.configPath || '--');
            setTimeout(fetchAgents, 3000);
          } else {
            resultEl.className = 'spawn-result error';
            resultEl.textContent = 'Spawn failed: ' + (data.error || JSON.stringify(data));
          }
        } catch (e) {
          resultEl.className = 'spawn-result error';
          resultEl.textContent = 'Spawn error: ' + e.message;
        } finally {
          btn.disabled = false;
        }
      }

      /* ---- Logs ---- */
      function updateLogSelect() {
        const sel = document.getElementById('logAgentSelect');
        const current = sel.value;
        const running = agents.filter(a => a.status === 'running');

        sel.innerHTML = '<option value="">-- Select an agent --</option>' +
          running.map(a => '<option value="' + escAttr(a.seedId) + '"' +
            (a.seedId === current ? ' selected' : '') + '>' +
            esc(a.name || a.seedId) + ' (' + a.port + ')' +
          '</option>').join('');
      }

      async function loadLogs() {
        const seedId = document.getElementById('logAgentSelect').value;
        const viewer = document.getElementById('logViewer');
        if (!seedId) {
          viewer.innerHTML = '<span class="logs-empty">Select a running agent to view logs.</span>';
          if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
          return;
        }

        try {
          const res = await apiFetch('/api/agents/' + encodeURIComponent(seedId) + '/logs');
          const data = await res.json();
          if (res.ok) {
            viewer.textContent = data.lines || '(no output yet)';
            viewer.scrollTop = viewer.scrollHeight;
          } else {
            viewer.textContent = 'Error: ' + (data.error || 'unknown');
          }
        } catch (e) {
          viewer.textContent = 'Error loading logs: ' + e.message;
        }

        /* Auto-refresh logs every 3s while a log agent is selected */
        if (logPollTimer) clearInterval(logPollTimer);
        logPollTimer = setInterval(async function() {
          const sel = document.getElementById('logAgentSelect').value;
          if (!sel) { clearInterval(logPollTimer); logPollTimer = null; return; }
          try {
            const res = await apiFetch('/api/agents/' + encodeURIComponent(sel) + '/logs');
            const data = await res.json();
            if (res.ok) {
              const v = document.getElementById('logViewer');
              const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 40;
              v.textContent = data.lines || '(no output yet)';
              if (atBottom) v.scrollTop = v.scrollHeight;
            }
          } catch (_) { /* ignore poll errors */ }
        }, 3000);
      }

      function clearLogViewer() {
        document.getElementById('logViewer').innerHTML = '<span class="logs-empty">Cleared.</span>';
      }

      /* ---- Helpers ---- */
      function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
      function escAttr(s) { return s.replace(/'/g, "\\\\'").replace(/"/g, '&quot;'); }

      function formatUptime(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm ' + (s % 60) + 's';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ' + (m % 60) + 'm';
        const d = Math.floor(h / 24);
        return d + 'd ' + (h % 24) + 'h';
      }

      function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
      }
    </script>
  </body>
</html>`;
