/**
 * @fileoverview Inline HTML dashboard for the Wunderland CLI HTTP server.
 * @module wunderland/cli/commands/start/routes/dashboard-html
 *
 * Self-contained SPA with 6 tabs: Overview, Chat, HITL, Graph, Events, Extensions.
 * Same dark cyberpunk theme as /pairing and /hitl pages.
 * Zero build step, zero external dependencies.
 */

// eslint-disable-next-line no-irregular-whitespace
export const DASHBOARD_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wunderland Dashboard</title>
    <style>
      /* ── CSS Variables (shared with /pairing and /hitl) ──────────────── */
      :root {
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
      }

      /* ── Reset & base ───────────────────────────────────────────────── */
      *, *::before, *::after { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--font-sans);
        background: radial-gradient(1200px 800px at 20% 20%, #18244a, var(--bg));
        color: var(--text);
        min-height: 100vh;
      }

      /* ── Header ─────────────────────────────────────────────────────── */
      header {
        padding: 12px 20px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        backdrop-filter: blur(6px);
        position: sticky;
        top: 0;
        background: rgba(11,16,32,0.85);
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
        border: 1px solid rgba(255,255,255,0.14);
        font-size: 11px;
        color: var(--muted);
      }
      .pill.ok { border-color: rgba(99,230,190,0.3); color: var(--ok); }
      .pill.error { border-color: rgba(255,107,107,0.4); color: var(--danger); }
      .pill .dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--muted);
      }
      .pill.ok .dot { background: var(--ok); }
      .pill.error .dot { background: var(--danger); }

      /* ── Tabs ────────────────────────────────────────────────────────── */
      .tabs {
        display: flex;
        gap: 2px;
        padding: 0 20px;
        background: rgba(11,16,32,0.6);
        border-bottom: 1px solid rgba(255,255,255,0.06);
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

      /* ── Main content ───────────────────────────────────────────────── */
      main {
        padding: 18px 20px;
        max-width: 1200px;
        margin: 0 auto;
      }
      .tab-content { display: none; }
      .tab-content.active { display: block; }

      /* ── Auth card ──────────────────────────────────────────────────── */
      .auth-card {
        background: rgba(17,24,51,0.78);
        border: 1px solid rgba(255,255,255,0.10);
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
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.22);
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

      /* ── Card ────────────────────────────────────────────────────────── */
      .card {
        background: rgba(17,24,51,0.78);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 20px 40px rgba(0,0,0,0.22);
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

      /* ── Buttons ─────────────────────────────────────────────────────── */
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

      /* ── Stats grid ─────────────────────────────────────────────────── */
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 12px;
      }
      .stat-card {
        background: rgba(0,0,0,0.14);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        padding: 12px;
      }
      .stat-label {
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 4px;
      }
      .stat-value {
        font-size: 20px;
        font-weight: 700;
        color: var(--text);
      }
      .stat-sub {
        font-size: 11px;
        color: var(--muted);
        margin-top: 2px;
      }

      /* ── Chat ────────────────────────────────────────────────────────── */
      .chat-messages {
        max-height: 500px;
        overflow-y: auto;
        padding: 8px 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .chat-msg {
        max-width: 80%;
        padding: 10px 14px;
        border-radius: 12px;
        font-size: 13px;
        line-height: 1.5;
        word-break: break-word;
        white-space: pre-wrap;
      }
      .chat-msg.user {
        align-self: flex-end;
        background: rgba(83,214,199,0.15);
        border: 1px solid rgba(83,214,199,0.25);
      }
      .chat-msg.agent {
        align-self: flex-start;
        background: rgba(17,24,51,0.9);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .chat-msg.system {
        align-self: center;
        font-size: 11px;
        color: var(--muted);
        background: transparent;
        border: none;
        padding: 4px;
      }
      .chat-input-row {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      .chat-input-row textarea {
        flex: 1;
        min-height: 42px;
        max-height: 120px;
        resize: vertical;
      }

      /* ── HITL ────────────────────────────────────────────────────────── */
      .hitl-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      @media (max-width: 800px) { .hitl-row { grid-template-columns: 1fr; } }
      .item {
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 10px;
        padding: 12px;
        margin: 10px 0;
        background: rgba(0,0,0,0.14);
      }
      .item .title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }
      .item .id {
        font-family: var(--font-mono);
        font-size: 11px;
        color: rgba(232,236,255,0.70);
      }
      .item .desc {
        margin: 8px 0 10px;
        color: rgba(232,236,255,0.92);
        white-space: pre-wrap;
        font-size: 12px;
      }
      .btns { display: flex; gap: 8px; flex-wrap: wrap; }

      /* ── Graph ───────────────────────────────────────────────────────── */
      .graph-container {
        background: rgba(0,0,0,0.2);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        min-height: 300px;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        position: relative;
      }
      .graph-container svg { width: 100%; height: 100%; }
      .graph-empty {
        color: var(--muted);
        font-size: 13px;
        text-align: center;
        padding: 40px;
      }

      /* ── Events ──────────────────────────────────────────────────────── */
      .events-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }
      .events-header .count { font-size: 12px; color: var(--muted); }
      .event-list {
        max-height: 500px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .event-item {
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(0,0,0,0.14);
        border: 1px solid rgba(255,255,255,0.06);
        font-size: 12px;
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .event-badge {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 6px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .event-badge.tool_call { background: rgba(83,214,199,0.15); color: var(--accent); border: 1px solid rgba(83,214,199,0.3); }
      .event-badge.tool_result_ok { background: rgba(99,230,190,0.12); color: var(--ok); border: 1px solid rgba(99,230,190,0.25); }
      .event-badge.tool_result_err { background: rgba(255,107,107,0.12); color: var(--danger); border: 1px solid rgba(255,107,107,0.25); }
      .event-badge.guardrail { background: rgba(255,212,59,0.12); color: var(--warn); border: 1px solid rgba(255,212,59,0.25); }
      .event-badge.default { background: rgba(255,255,255,0.06); color: var(--muted); border: 1px solid rgba(255,255,255,0.1); }
      .event-time { font-family: var(--font-mono); font-size: 10px; color: var(--muted); white-space: nowrap; flex-shrink: 0; }
      .event-body { flex: 1; color: rgba(232,236,255,0.9); word-break: break-word; }

      /* ── Extensions ──────────────────────────────────────────────────── */
      .ext-filter {
        margin-bottom: 12px;
        width: 100%;
        max-width: 320px;
      }
      .ext-pack {
        background: rgba(0,0,0,0.1);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 8px;
      }
      .ext-pack-name { font-weight: 600; font-size: 13px; }
      .ext-pack-count { font-size: 11px; color: var(--muted); margin-left: 8px; }
      .tool-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 8px;
        margin-top: 12px;
      }
      .tool-item {
        background: rgba(0,0,0,0.14);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 8px;
        padding: 10px;
      }
      .tool-name { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--accent); }
      .tool-desc { font-size: 11px; color: rgba(232,236,255,0.8); margin-top: 4px; line-height: 1.4; }
      .tool-cat {
        display: inline-block;
        margin-top: 6px;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: rgba(83,214,199,0.1);
        color: var(--accent);
        border: 1px solid rgba(83,214,199,0.2);
      }

      /* ── Status text ─────────────────────────────────────────────────── */
      .status { font-size: 12px; color: var(--muted); }

      /* ── Scrollbar ───────────────────────────────────────────────────── */
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
    </style>
  </head>
  <body>
    <!-- ── Header ──────────────────────────────────────────────────────── -->
    <header>
      <div class="header-left">
        <h1>Wunderland</h1>
        <span class="pill" id="connPill">
          <span class="dot"></span>
          <span id="connStatus">disconnected</span>
        </span>
      </div>
    </header>

    <!-- ── Tab bar ─────────────────────────────────────────────────────── -->
    <nav class="tabs" id="tabBar">
      <div class="tab active" data-tab="overview">Overview</div>
      <div class="tab" data-tab="chat">Chat</div>
      <div class="tab" data-tab="hitl">HITL</div>
      <div class="tab" data-tab="graph">Graph</div>
      <div class="tab" data-tab="events">Events</div>
      <div class="tab" data-tab="extensions">Extensions</div>
    </nav>

    <!-- ── Main ────────────────────────────────────────────────────────── -->
    <main>
      <!-- Auth (shared across all tabs) -->
      <div class="auth-card" id="authCard">
        <label>Admin Secret</label>
        <input id="secretInput" type="password" placeholder="Paste admin secret from server logs" />
        <button class="ok" id="connectBtn">Connect</button>
        <span class="auth-hint" id="authHint"></span>
      </div>

      <!-- ── Overview tab ──────────────────────────────────────────────── -->
      <div class="tab-content active" id="tab-overview">
        <div class="card">
          <h2>Agent Status</h2>
          <div class="stats-grid" id="overviewGrid">
            <div class="stat-card">
              <div class="stat-label">Agent</div>
              <div class="stat-value" id="ov-name">--</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Uptime</div>
              <div class="stat-value" id="ov-uptime">--</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Memory (RSS)</div>
              <div class="stat-value" id="ov-mem">--</div>
              <div class="stat-sub" id="ov-heap"></div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Tools</div>
              <div class="stat-value" id="ov-tools">--</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Channels</div>
              <div class="stat-value" id="ov-channels">--</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Provider</div>
              <div class="stat-value" id="ov-provider">--</div>
              <div class="stat-sub" id="ov-model"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Chat tab ──────────────────────────────────────────────────── -->
      <div class="tab-content" id="tab-chat">
        <div class="card">
          <h2>Chat</h2>
          <div class="chat-messages" id="chatMessages">
            <div class="chat-msg system">Send a message to start chatting with your agent.</div>
          </div>
          <div class="chat-input-row">
            <textarea id="chatInput" placeholder="Type a message... (Ctrl+Enter to send)" rows="2"></textarea>
            <button class="accent" id="chatSend">Send</button>
          </div>
        </div>
      </div>

      <!-- ── HITL tab ──────────────────────────────────────────────────── -->
      <div class="tab-content" id="tab-hitl">
        <div class="hitl-row">
          <div class="card">
            <h2>Pending Approvals</h2>
            <div id="hitlApprovals"><div class="status">Connect to view pending approvals.</div></div>
          </div>
          <div class="card">
            <h2>Checkpoints</h2>
            <div id="hitlCheckpoints"><div class="status">Connect to view checkpoints.</div></div>
          </div>
        </div>
      </div>

      <!-- ── Graph tab ─────────────────────────────────────────────────── -->
      <div class="tab-content" id="tab-graph">
        <div class="card">
          <h2>Workflow Graph</h2>
          <div class="graph-container" id="graphContainer">
            <div class="graph-empty">No workflow running. Start a chat to see the execution graph.</div>
          </div>
        </div>
      </div>

      <!-- ── Events tab ────────────────────────────────────────────────── -->
      <div class="tab-content" id="tab-events">
        <div class="card">
          <div class="events-header">
            <h2 style="margin:0">Event Log</h2>
            <div>
              <span class="count" id="eventCount">0 events</span>
              <button id="eventsClear" style="margin-left:8px;padding:4px 10px">Clear</button>
            </div>
          </div>
          <div class="event-list" id="eventList">
            <div class="status" style="padding:20px;text-align:center">Connect to see real-time agent events.</div>
          </div>
        </div>
      </div>

      <!-- ── Extensions tab ────────────────────────────────────────────── -->
      <div class="tab-content" id="tab-extensions">
        <div class="card">
          <h2>Extensions &amp; Tools</h2>
          <input class="ext-filter" id="extFilter" placeholder="Filter tools..." />
          <div id="extPacks"></div>
          <div class="tool-list" id="extTools"></div>
        </div>
      </div>
    </main>

    <script>
      /* ────────────────────────────────────────────────────────────────────
       * Wunderland Dashboard — vanilla JS runtime
       * ────────────────────────────────────────────────────────────────── */
      const $ = (sel) => document.querySelector(sel);
      const $$ = (sel) => document.querySelectorAll(sel);
      const server = location.origin;

      /* ── State ───────────────────────────────────────────────────────── */
      let secret = localStorage.getItem('wunderland_hitl_secret') || '';
      let connected = false;
      let hitlEs = null;
      let eventEs = null;
      const events = [];
      const MAX_EVENTS = 200;

      /* ── Auth ────────────────────────────────────────────────────────── */
      const secretInput = $('#secretInput');
      const authHint = $('#authHint');
      const connPill = $('#connPill');
      const connStatus = $('#connStatus');
      if (secret) secretInput.value = secret;

      function setConnected(ok) {
        connected = ok;
        connStatus.textContent = ok ? 'connected' : 'disconnected';
        connPill.className = ok ? 'pill ok' : 'pill';
      }

      $('#connectBtn').onclick = doConnect;
      secretInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });

      function doConnect() {
        secret = secretInput.value.trim();
        if (!secret) {
          authHint.textContent = 'Find the secret in the terminal where your agent is running.';
          authHint.style.color = 'var(--warn)';
          return;
        }
        localStorage.setItem('wunderland_hitl_secret', secret);
        authHint.textContent = 'Connecting...';
        authHint.style.color = 'var(--muted)';
        connectHitlStream();
        connectEventStream();
        refreshOverview();
        refreshHitl();
        refreshExtensions();
      }

      /* ── API helper ──────────────────────────────────────────────────── */
      async function api(path, method, body) {
        const url = new URL(server + path);
        url.searchParams.set('secret', secret);
        const opts = {
          method: method || 'GET',
          headers: { 'Content-Type': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(url.toString(), opts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }

      function esc(s) {
        return String(s || '').replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
      }

      /* ── Tabs ────────────────────────────────────────────────────────── */
      $$('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          $$('.tab').forEach((t) => t.classList.remove('active'));
          $$('.tab-content').forEach((tc) => tc.classList.remove('active'));
          tab.classList.add('active');
          const target = tab.dataset.tab;
          const content = $('#tab-' + target);
          if (content) content.classList.add('active');
        });
      });

      /* ── Overview ────────────────────────────────────────────────────── */
      function formatUptime(seconds) {
        if (!seconds && seconds !== 0) return '--';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const parts = [];
        if (d > 0) parts.push(d + 'd');
        if (h > 0) parts.push(h + 'h');
        if (m > 0) parts.push(m + 'm');
        parts.push(s + 's');
        return parts.join(' ');
      }

      async function refreshOverview() {
        try {
          const data = await api('/health', 'GET');
          $('#ov-name').textContent = data.name || data.seedId || '--';
          $('#ov-uptime').textContent = formatUptime(data.uptime);
          $('#ov-mem').textContent = (data.memory?.rss || '--') + ' MB';
          $('#ov-heap').textContent = 'Heap: ' + (data.memory?.heap || '--') + ' MB';
          $('#ov-tools').textContent = data.tools ?? '--';
          $('#ov-channels').textContent = data.channels ?? '--';
          $('#ov-provider').textContent = '--';
          $('#ov-model').textContent = '';
          setConnected(true);
          authHint.textContent = 'Connected.';
          authHint.style.color = 'var(--ok)';
        } catch (e) {
          authHint.textContent = 'Failed to connect: ' + e.message;
          authHint.style.color = 'var(--danger)';
        }
      }

      /* Fetch health every 30s */
      let overviewInterval = null;
      function startOverviewPolling() {
        if (overviewInterval) clearInterval(overviewInterval);
        overviewInterval = setInterval(() => {
          if (connected) refreshOverview();
        }, 30000);
      }

      /* ── Chat ────────────────────────────────────────────────────────── */
      const chatMessages = $('#chatMessages');
      const chatInput = $('#chatInput');
      const chatSend = $('#chatSend');

      function addChatMsg(role, text) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + role;
        div.textContent = text;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      async function sendChat() {
        const msg = chatInput.value.trim();
        if (!msg) return;
        chatInput.value = '';
        addChatMsg('user', msg);

        chatSend.disabled = true;
        chatSend.textContent = '...';
        try {
          const data = await api('/chat', 'POST', { message: msg });
          addChatMsg('agent', data.reply || '(no reply)');
        } catch (e) {
          addChatMsg('system', 'Error: ' + e.message);
        } finally {
          chatSend.disabled = false;
          chatSend.textContent = 'Send';
        }
      }

      chatSend.onclick = sendChat;
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          sendChat();
        }
      });

      /* ── HITL ────────────────────────────────────────────────────────── */
      async function refreshHitl() {
        try {
          const pending = await api('/hitl/pending', 'GET');
          renderApprovals(pending.approvals || []);
          renderCheckpoints(pending.checkpoints || []);
        } catch {
          $('#hitlApprovals').innerHTML = '<div class="status">Connect with a valid secret to view approvals.</div>';
          $('#hitlCheckpoints').innerHTML = '';
        }
      }

      function renderApprovals(list) {
        const el = $('#hitlApprovals');
        if (!list.length) {
          el.innerHTML = '<div class="status">No pending approvals.</div>';
          return;
        }
        el.innerHTML = '';
        for (const a of list) {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML =
            '<div class="title">' +
              '<div><strong>' + esc(a.severity || 'medium') + '</strong></div>' +
              '<div class="id">' + esc(a.actionId || '') + '</div>' +
            '</div>' +
            '<div class="desc">' + esc(a.description || '') + '</div>' +
            '<div class="btns">' +
              '<button class="ok">Approve</button>' +
              '<button class="bad">Reject</button>' +
            '</div>';
          const [approveBtn, rejectBtn] = div.querySelectorAll('button');
          approveBtn.onclick = async () => {
            approveBtn.disabled = true;
            await api('/hitl/approvals/' + encodeURIComponent(a.actionId) + '/approve', 'POST');
            await refreshHitl();
          };
          rejectBtn.onclick = async () => {
            const reason = prompt('Rejection reason?') || '';
            rejectBtn.disabled = true;
            await api('/hitl/approvals/' + encodeURIComponent(a.actionId) + '/reject', 'POST', { reason });
            await refreshHitl();
          };
          el.appendChild(div);
        }
      }

      function renderCheckpoints(list) {
        const el = $('#hitlCheckpoints');
        if (!list.length) {
          el.innerHTML = '<div class="status">No pending checkpoints.</div>';
          return;
        }
        el.innerHTML = '';
        for (const c of list) {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML =
            '<div class="title">' +
              '<div><strong>' + esc(c.currentPhase || 'checkpoint') + '</strong></div>' +
              '<div class="id">' + esc(c.checkpointId || '') + '</div>' +
            '</div>' +
            '<div class="desc">' + esc((c.completedWork || []).join('\\n')) + '</div>' +
            '<div class="btns">' +
              '<button class="ok">Continue</button>' +
              '<button class="bad">Abort</button>' +
            '</div>';
          const [continueBtn, abortBtn] = div.querySelectorAll('button');
          continueBtn.onclick = async () => {
            continueBtn.disabled = true;
            await api('/hitl/checkpoints/' + encodeURIComponent(c.checkpointId) + '/continue', 'POST');
            await refreshHitl();
          };
          abortBtn.onclick = async () => {
            const instructions = prompt('Abort instructions?') || '';
            abortBtn.disabled = true;
            await api('/hitl/checkpoints/' + encodeURIComponent(c.checkpointId) + '/abort', 'POST', { instructions });
            await refreshHitl();
          };
          el.appendChild(div);
        }
      }

      function connectHitlStream() {
        if (hitlEs) hitlEs.close();
        const u = new URL(server + '/hitl/stream');
        u.searchParams.set('secret', secret);
        hitlEs = new EventSource(u.toString());
        hitlEs.onopen = () => {
          setConnected(true);
          refreshHitl();
        };
        hitlEs.onerror = () => {
          /* Stream will auto-reconnect; UI already shows status via connPill. */
        };
        hitlEs.addEventListener('hitl', () => refreshHitl());
      }

      /* ── Graph ───────────────────────────────────────────────────────── */
      async function refreshGraph() {
        try {
          const data = await api('/api/graph', 'GET');
          renderGraph(data);
        } catch {
          $('#graphContainer').innerHTML = '<div class="graph-empty">Could not load graph data.</div>';
        }
      }

      function renderGraph(data) {
        const container = $('#graphContainer');
        if (!data || !data.nodes || data.nodes.length === 0) {
          container.innerHTML = '<div class="graph-empty">No workflow running. Start a chat to see the execution graph.</div>';
          return;
        }

        /* Simple force-directed layout in vanilla JS */
        const nodes = data.nodes.map((n, i) => ({
          ...n,
          x: 200 + Math.cos(i * 2.4) * 150,
          y: 180 + Math.sin(i * 2.4) * 120,
          vx: 0, vy: 0,
        }));
        const edges = data.edges || [];
        const nodeMap = {};
        nodes.forEach((n) => { nodeMap[n.id] = n; });

        /* Run 80 iterations of force simulation */
        for (let iter = 0; iter < 80; iter++) {
          /* Repulsion between nodes */
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              const dx = nodes[j].x - nodes[i].x;
              const dy = nodes[j].y - nodes[i].y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const force = 3000 / (dist * dist);
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              nodes[i].vx -= fx;
              nodes[i].vy -= fy;
              nodes[j].vx += fx;
              nodes[j].vy += fy;
            }
          }
          /* Attraction along edges */
          for (const e of edges) {
            const s = nodeMap[e.source];
            const t = nodeMap[e.target];
            if (!s || !t) continue;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = (dist - 100) * 0.05;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            s.vx += fx;
            s.vy += fy;
            t.vx -= fx;
            t.vy -= fy;
          }
          /* Apply velocity with damping */
          for (const n of nodes) {
            n.vx *= 0.6;
            n.vy *= 0.6;
            n.x += n.vx;
            n.y += n.vy;
          }
        }

        /* Normalize positions to fit in viewport */
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of nodes) {
          minX = Math.min(minX, n.x);
          maxX = Math.max(maxX, n.x);
          minY = Math.min(minY, n.y);
          maxY = Math.max(maxY, n.y);
        }
        const pad = 60;
        const w = Math.max(maxX - minX + pad * 2, 400);
        const h = Math.max(maxY - minY + pad * 2, 300);
        for (const n of nodes) {
          n.x = n.x - minX + pad;
          n.y = n.y - minY + pad;
        }

        /* Color map for node types */
        const typeColors = {
          tool: '#53d6c7',
          llm: '#7c8aff',
          input: '#63e6be',
          output: '#ffd43b',
          decision: '#ff6b6b',
          default: '#9aa6d8',
        };

        /* Build SVG */
        let svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';

        /* Edges */
        for (const e of edges) {
          const s = nodeMap[e.source];
          const t = nodeMap[e.target];
          if (!s || !t) continue;
          svg += '<line x1="' + s.x + '" y1="' + s.y + '" x2="' + t.x + '" y2="' + t.y + '" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>';
        }

        /* Nodes */
        for (const n of nodes) {
          const color = typeColors[n.type] || typeColors.default;
          const rw = 70, rh = 32;
          svg += '<rect x="' + (n.x - rw / 2) + '" y="' + (n.y - rh / 2) + '" width="' + rw + '" height="' + rh + '" rx="6" fill="' + color + '22" stroke="' + color + '" stroke-width="1.5"/>';
          svg += '<text x="' + n.x + '" y="' + (n.y + 4) + '" text-anchor="middle" fill="' + color + '" font-size="10" font-family="' + getComputedStyle(document.body).fontFamily + '">' + esc(n.label || n.id) + '</text>';
        }

        svg += '</svg>';
        container.innerHTML = svg;
      }

      /* ── Events ──────────────────────────────────────────────────────── */
      function connectEventStream() {
        if (eventEs) eventEs.close();
        const u = new URL(server + '/api/events/stream');
        u.searchParams.set('secret', secret);
        eventEs = new EventSource(u.toString());
        eventEs.addEventListener('agent_event', (e) => {
          try {
            const payload = JSON.parse(e.data);
            addEvent(payload);
          } catch { /* ignore malformed events */ }
        });
      }

      function addEvent(payload) {
        events.unshift({ ...payload, _ts: Date.now() });
        if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
        renderEvents();
      }

      function eventBadgeClass(type) {
        if (type === 'tool_call') return 'tool_call';
        if (type === 'tool_result') return 'tool_result_ok';
        if (type === 'tool_error') return 'tool_result_err';
        if (type === 'guardrail') return 'guardrail';
        return 'default';
      }

      function renderEvents() {
        const el = $('#eventList');
        $('#eventCount').textContent = events.length + ' event' + (events.length !== 1 ? 's' : '');
        if (!events.length) {
          el.innerHTML = '<div class="status" style="padding:20px;text-align:center">No events yet. Events appear as the agent processes requests.</div>';
          return;
        }
        let html = '';
        for (const ev of events) {
          const type = ev.type || 'event';
          const badge = eventBadgeClass(type);
          const time = new Date(ev._ts).toLocaleTimeString();
          let body = '';
          if (ev.toolName) body += '<strong>' + esc(ev.toolName) + '</strong> ';
          if (ev.message) body += esc(ev.message);
          else if (ev.error) body += '<span style="color:var(--danger)">' + esc(ev.error) + '</span>';
          else body += esc(type);
          html += '<div class="event-item">' +
            '<span class="event-time">' + time + '</span>' +
            '<span class="event-badge ' + badge + '">' + esc(type) + '</span>' +
            '<span class="event-body">' + body + '</span>' +
          '</div>';
        }
        el.innerHTML = html;
      }

      $('#eventsClear').onclick = () => {
        events.length = 0;
        renderEvents();
      };

      /* ── Extensions ──────────────────────────────────────────────────── */
      let allTools = [];
      let allPacks = [];

      async function refreshExtensions() {
        try {
          const data = await api('/api/extensions', 'GET');
          allPacks = data.packs || [];
          allTools = data.tools || [];
          renderExtensions();
        } catch {
          $('#extPacks').innerHTML = '';
          $('#extTools').innerHTML = '<div class="status">Connect to view loaded extensions.</div>';
        }
      }

      function renderExtensions() {
        const filter = ($('#extFilter').value || '').toLowerCase();
        const packsEl = $('#extPacks');
        const toolsEl = $('#extTools');

        /* Packs */
        if (allPacks.length > 0) {
          packsEl.innerHTML = allPacks.map((p) =>
            '<div class="ext-pack">' +
              '<span class="ext-pack-name">' + esc(p.name) + '</span>' +
              '<span class="ext-pack-count">' + (p.descriptorCount || 0) + ' descriptors</span>' +
            '</div>'
          ).join('');
        } else {
          packsEl.innerHTML = '';
        }

        /* Tools */
        const filtered = filter
          ? allTools.filter((t) => (t.name + ' ' + t.description + ' ' + (t.category || '')).toLowerCase().includes(filter))
          : allTools;

        if (filtered.length === 0) {
          toolsEl.innerHTML = '<div class="status">' + (filter ? 'No tools match the filter.' : 'No tools loaded.') + '</div>';
          return;
        }

        toolsEl.innerHTML = filtered.map((t) =>
          '<div class="tool-item">' +
            '<div class="tool-name">' + esc(t.name) + '</div>' +
            '<div class="tool-desc">' + esc(t.description || '') + '</div>' +
            (t.category ? '<span class="tool-cat">' + esc(t.category) + '</span>' : '') +
          '</div>'
        ).join('');
      }

      $('#extFilter').addEventListener('input', renderExtensions);

      /* ── Auto-connect ────────────────────────────────────────────────── */
      if (secret) {
        doConnect();
      }
      startOverviewPolling();

      /* Also refresh graph when its tab is clicked */
      $$('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          if (tab.dataset.tab === 'graph' && connected) refreshGraph();
        });
      });
    </script>
  </body>
</html>`;
