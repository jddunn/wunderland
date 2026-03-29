/**
 * @fileoverview Inline HTML page templates for the CLI HTTP server.
 * @module wunderland/cli/commands/start/routes/html-pages
 *
 * Contains the self-contained SPA pages served at /pairing and /hitl.
 * Extracted from http-server.ts to keep route handler files focused.
 */

/** Full HTML page for the /pairing management UI. */
// eslint-disable-next-line no-irregular-whitespace
export const PAIRING_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wunderland Pairing</title>
    <style>
      :root { --bg: #0b1020; --panel: #111833; --text: #e8ecff; --muted: #9aa6d8; --accent: #53d6c7; --danger: #ff6b6b; --ok: #63e6be; --warn: #ffd43b; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(1200px 800px at 20% 20%, #18244a, var(--bg)); color: var(--text); }
      header { padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(6px); position: sticky; top: 0; background: rgba(11,16,32,0.7); z-index: 10; }
      h1 { margin: 0; font-size: 16px; letter-spacing: 0.2px; }
      main { padding: 18px 20px; display: grid; gap: 16px; max-width: 1100px; margin: 0 auto; }
      .row { display: grid; grid-template-columns: 1fr; gap: 16px; }
      @media (min-width: 900px) { .row { grid-template-columns: 1fr 1fr; } }
      .card { background: rgba(17,24,51,0.78); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 14px; box-shadow: 0 20px 40px rgba(0,0,0,0.22); }
      .card h2 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
      .item { border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; padding: 12px; margin: 10px 0; background: rgba(0,0,0,0.14); }
      .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; color: rgba(232,236,255,0.70); }
      .desc { margin: 8px 0 10px; color: rgba(232,236,255,0.92); white-space: pre-wrap; }
      .btns { display: flex; gap: 8px; flex-wrap: wrap; }
      button { appearance: none; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: var(--text); padding: 8px 10px; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 12px; }
      button:hover { border-color: rgba(83,214,199,0.55); }
      button.ok { background: rgba(99,230,190,0.12); border-color: rgba(99,230,190,0.28); }
      button.bad { background: rgba(255,107,107,0.10); border-color: rgba(255,107,107,0.30); }
      .meta { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
      input { width: 320px; max-width: 100%; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.22); color: var(--text); padding: 8px 10px; }
      .status { font-size: 12px; color: var(--muted); }
      .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); }
      .pill.error { border-color: rgba(255,107,107,0.4); color: var(--danger); }
      .pill.ok { border-color: rgba(99,230,190,0.3); color: var(--ok); }
      .note { font-size: 12px; color: rgba(232,236,255,0.86); line-height: 1.5; }
      ul { margin: 8px 0 0; padding-left: 18px; }
      li { margin: 6px 0; }
      ol { margin: 8px 0 0; padding-left: 18px; }
      ol li { margin: 6px 0; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; color: rgba(232,236,255,0.92); background: rgba(0,0,0,0.2); padding: 1px 4px; border-radius: 4px; }
      .collapsible { cursor: pointer; user-select: none; }
      .collapsible::before { content: '+ '; font-weight: bold; color: var(--accent); }
      .collapsible.open::before { content: '- '; }
      .collapsible-content { display: none; margin-top: 8px; }
      .collapsible-content.open { display: block; }
      .banner { padding: 10px 14px; border-radius: 8px; font-size: 12px; line-height: 1.5; margin-bottom: 6px; }
      .banner.error { background: rgba(255,107,107,0.08); border: 1px solid rgba(255,107,107,0.25); color: #ffa8a8; }
      .banner.info { background: rgba(83,214,199,0.06); border: 1px solid rgba(83,214,199,0.18); color: rgba(232,236,255,0.9); }
      .sender-info { display: flex; gap: 8px; align-items: center; font-size: 12px; }
      .sender-info .label { color: var(--muted); }
      .sender-info .value { color: var(--text); font-weight: 500; }
      .channel-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
      .channel-badge.telegram { background: rgba(0,136,204,0.15); color: #29b6f6; border: 1px solid rgba(0,136,204,0.3); }
      .channel-badge.discord { background: rgba(88,101,242,0.15); color: #7289da; border: 1px solid rgba(88,101,242,0.3); }
      .channel-badge.default { background: rgba(255,255,255,0.06); color: var(--muted); border: 1px solid rgba(255,255,255,0.12); }
    </style>
  </head>
  <body>
    <header>
      <h1>Wunderland Pairing</h1>
      <div class="meta">
        <span class="pill" id="serverPill">Server: <span id="server"></span></span>
        <span class="pill" id="streamPill">Stream: <span id="streamStatus">disconnected</span></span>
        <span class="pill">Pairing: <span id="pairingStatus">enabled</span></span>
      </div>
    </header>
    <main>
      <!-- Stream error banner (hidden by default) -->
      <div id="streamError" class="banner error" style="display:none"></div>

      <div class="card">
        <h2>Connect to Your Agent</h2>
        <div class="note" style="margin-bottom:10px">
          Enter the admin secret to manage pairing requests. You'll find it in the terminal where your agent is running, printed at startup.
        </div>
        <div class="meta">
          <input id="secret" placeholder="Paste admin secret from server logs" />
          <button id="connect" class="ok">Connect</button>
          <span class="status" id="hint"></span>
        </div>
      </div>

      <div class="card">
        <h2>What is Pairing?</h2>
        <div class="note">
          <p style="margin:0 0 8px">
            <strong>Pairing controls who can talk to your agent</strong> on messaging platforms like Telegram and Discord.
            When someone sends a message to your bot for the first time, they are <em>not</em> automatically allowed to chat.
            Instead, they receive a one-time <strong>pairing code</strong>, and you approve or reject them here.
          </p>
          <p style="margin:0 0 8px"><strong>How it works:</strong></p>
          <ol>
            <li>A new user messages your Telegram/Discord bot.</li>
            <li>The bot replies with a pairing code (e.g. <code>A7X3</code>) and asks them to wait.</li>
            <li>The request appears in "Pending Requests" below.</li>
            <li>You click <strong>Approve</strong> &mdash; the user is added to the allowlist and can now chat freely.</li>
          </ol>
          <p style="margin:8px 0 0">
            In group chats, users type <code>!pair</code> to request a code (DMs get it automatically).
          </p>
        </div>
      </div>

      <div class="row">
        <div class="card">
          <h2>Pending Requests</h2>
          <div id="requests" class="status">Enter admin secret and click Connect to load requests.</div>
        </div>
        <div class="card">
          <h2>Approved Users (Allowlist)</h2>
          <div id="allowlist" class="status">Enter admin secret and click Connect to load the allowlist.</div>
        </div>
      </div>

      <div class="card">
        <h2>Setup Guide</h2>
        <div class="note">
          <div class="collapsible" data-target="guide-telegram">Telegram Setup</div>
          <div class="collapsible-content" id="guide-telegram">
            <ol>
              <li>Create a bot via <strong>@BotFather</strong> on Telegram and copy the token.</li>
              <li>Add to your <code>agent.config.json</code>:
                <pre style="background:rgba(0,0,0,0.2);padding:8px;border-radius:6px;margin:6px 0;overflow-x:auto"><code>{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN"
    }
  }
}</code></pre>
                Or set the env var: <code>TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN</code>
              </li>
              <li>Restart your agent: <code>wunderland start</code></li>
              <li>Message your bot on Telegram &mdash; a pairing request will appear here.</li>
            </ol>
          </div>

          <div class="collapsible" data-target="guide-discord" style="margin-top:10px">Discord Setup</div>
          <div class="collapsible-content" id="guide-discord">
            <ol>
              <li>Create a Discord app at <strong>discord.com/developers</strong>, add a Bot, and copy the token.</li>
              <li>Invite the bot to your server with the OAuth2 URL (needs <em>Send Messages</em> + <em>Read Message History</em> permissions).</li>
              <li>Add to your <code>agent.config.json</code>:
                <pre style="background:rgba(0,0,0,0.2);padding:8px;border-radius:6px;margin:6px 0;overflow-x:auto"><code>{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN",
      "applicationId": "YOUR_APP_ID"
    }
  }
}</code></pre>
                Or set env vars: <code>DISCORD_BOT_TOKEN</code>, <code>DISCORD_APPLICATION_ID</code>
              </li>
              <li>Restart your agent, then DM the bot or type <code>!pair</code> in a channel.</li>
            </ol>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>FAQ &amp; Troubleshooting</h2>
        <div class="note">
          <div class="collapsible" data-target="faq-stream-error">I see "Stream: error" after clicking Connect</div>
          <div class="collapsible-content" id="faq-stream-error">
            <ul>
              <li><strong>Wrong secret</strong> &mdash; Double-check the admin secret from your server logs. It's printed at startup as <code>HITL secret: ...</code></li>
              <li><strong>Server not reachable</strong> &mdash; If your agent runs on a remote server, you need to either expose the port or use SSH tunneling:<br/><code>ssh -L 3777:localhost:3777 you@your-server</code><br/>Then open <code>http://localhost:3777/pairing</code> locally.</li>
              <li><strong>Firewall blocking</strong> &mdash; Ensure port 3777 (or your custom port) is open, or use the SSH tunnel above.</li>
              <li><strong>Agent not running</strong> &mdash; The agent HTTP server must be active. Run <code>wunderland start</code> first.</li>
            </ul>
          </div>

          <div class="collapsible" data-target="faq-no-requests" style="margin-top:10px">No pairing requests appear</div>
          <div class="collapsible-content" id="faq-no-requests">
            <ul>
              <li>Make sure the bot is actually running and connected to the platform (check the terminal logs for "Telegram connected" or "Discord ready").</li>
              <li>For <strong>DMs</strong>: just message the bot directly &mdash; it auto-sends a pairing code.</li>
              <li>For <strong>group chats</strong>: type <code>!pair</code> in the chat (the bot must be a member).</li>
              <li>Check that the <code>channels</code> section in <code>agent.config.json</code> has the platform enabled with a valid token.</li>
            </ul>
          </div>

          <div class="collapsible" data-target="faq-remote" style="margin-top:10px">Connecting to a remote agent</div>
          <div class="collapsible-content" id="faq-remote">
            <p style="margin:0 0 6px">This UI connects to the agent's built-in HTTP server. If the agent runs on a remote machine:</p>
            <ul>
              <li><strong>Recommended:</strong> Use SSH port forwarding &mdash; <code>ssh -L 3777:localhost:3777 you@server</code> &mdash; then open <code>http://localhost:3777/pairing</code></li>
              <li><strong>Alternative:</strong> Open the port in your firewall and access <code>http://server-ip:3777/pairing</code> directly (less secure)</li>
              <li>The admin secret is required either way &mdash; without it, all API calls are rejected.</li>
            </ul>
          </div>

          <div class="collapsible" data-target="faq-secret" style="margin-top:10px">Where do I find the admin secret?</div>
          <div class="collapsible-content" id="faq-secret">
            <p style="margin:0">When you run <code>wunderland start</code>, the secret is printed in the terminal output. Look for a line like:<br/>
            <code>HITL secret: abc123...</code><br/>
            You can also set a permanent secret in <code>agent.config.json</code> under <code>hitl.secret</code>, or via the env var <code>WUNDERLAND_HITL_SECRET</code>.</p>
          </div>

          <div class="collapsible" data-target="faq-security" style="margin-top:10px">Security best practices</div>
          <div class="collapsible-content" id="faq-security">
            <ul>
              <li><strong>Treat the secret like a password.</strong> Anyone with it can approve/reject users and see conversations.</li>
              <li>Avoid sharing URLs with <code>?secret=...</code> in them (they persist in browser history).</li>
              <li>This UI stores the secret in your browser's localStorage. Clear site data to forget it.</li>
              <li>For remote access, always prefer SSH tunneling over exposing the port.</li>
              <li>Only approve people you trust &mdash; approved users can freely chat with your agent.</li>
            </ul>
          </div>
        </div>
      </div>
    </main>
    <script>
      const server = window.location.origin;
      const serverEl = document.getElementById('server');
      const streamStatus = document.getElementById('streamStatus');
      const streamPill = document.getElementById('streamPill');
      const streamError = document.getElementById('streamError');
      const pairingStatus = document.getElementById('pairingStatus');
      const secretInput = document.getElementById('secret');
      const hint = document.getElementById('hint');
      const requestsEl = document.getElementById('requests');
      const allowEl = document.getElementById('allowlist');
      serverEl.textContent = server;

      const stored = localStorage.getItem('wunderland_hitl_secret');
      if (stored) secretInput.value = stored;

      // Collapsible sections
      document.querySelectorAll('.collapsible').forEach(el => {
        el.addEventListener('click', () => {
          const target = document.getElementById(el.dataset.target);
          if (target) {
            el.classList.toggle('open');
            target.classList.toggle('open');
          }
        });
      });

      async function api(path, method, body) {
        const secret = secretInput.value.trim();
        const url = new URL(server + path);
        url.searchParams.set('secret', secret);
        const res = await fetch(url.toString(), {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }

      function esc(s) {
        return String(s || '').replace(/[&<>\\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\\"':'&quot;',"'\":'&#39;"}[c]));
      }

      function channelBadge(ch) {
        const name = String(ch).toLowerCase();
        let cls = 'default';
        if (name.includes('telegram')) cls = 'telegram';
        else if (name.includes('discord')) cls = 'discord';
        return '<span class="channel-badge ' + cls + '">' + esc(ch) + '</span>';
      }

      function formatMeta(meta) {
        if (!meta || Object.keys(meta).length === 0) return '';
        const parts = [];
        if (meta.username) parts.push('<span class="label">Username:</span> <span class="value">' + esc(meta.username) + '</span>');
        if (meta.displayName || meta.display_name) parts.push('<span class="label">Name:</span> <span class="value">' + esc(meta.displayName || meta.display_name) + '</span>');
        if (meta.chatId || meta.chat_id) parts.push('<span class="label">Chat:</span> <span class="value">' + esc(meta.chatId || meta.chat_id) + '</span>');
        if (meta.platform) parts.push('<span class="label">Platform:</span> <span class="value">' + esc(meta.platform) + '</span>');
        // Show any remaining fields not already displayed
        const shown = new Set(['username', 'displayName', 'display_name', 'chatId', 'chat_id', 'platform']);
        for (const [k, v] of Object.entries(meta)) {
          if (!shown.has(k) && v != null && v !== '') parts.push('<span class="label">' + esc(k) + ':</span> <span class="value">' + esc(String(v)) + '</span>');
        }
        return parts.length > 0 ? '<div class="sender-info" style="flex-wrap:wrap;gap:12px">' + parts.join('') + '</div>' : '';
      }

      function renderRequests(payload) {
        const by = (payload && payload.requestsByChannel) || {};
        const channels = Object.keys(by).sort();
        if (channels.length === 0) {
          requestsEl.innerHTML = '<div class="status">No pending requests. When someone messages your bot for the first time, their request will appear here.</div>';
          return;
        }
        requestsEl.innerHTML = '';
        for (const ch of channels) {
          const list = by[ch] || [];
          if (!list.length) continue;
          const header = document.createElement('div');
          header.style.marginTop = '8px';
          header.innerHTML = channelBadge(ch);
          requestsEl.appendChild(header);
          for (const r of list) {
            const div = document.createElement('div');
            div.className = 'item';
            const metaHtml = formatMeta(r.meta);
            div.innerHTML =
              '<div class="title">' +
                '<div><strong>Code: ' + esc(r.code || '') + '</strong></div>' +
                '<div class="id">ID: ' + esc(r.id || '') + '</div>' +
              '</div>' +
              (metaHtml ? '<div style="margin:6px 0">' + metaHtml + '</div>' : '') +
              '<div class="btns">' +
                '<button class="ok">Approve</button>' +
                '<button class="bad">Reject</button>' +
              '</div>';
            const [approveBtn, rejectBtn] = div.querySelectorAll('button');
            approveBtn.onclick = async () => { approveBtn.disabled = true; approveBtn.textContent = 'Approving...'; await api('/pairing/approve', 'POST', { channel: ch, code: r.code }); await refresh(); };
            rejectBtn.onclick = async () => { rejectBtn.disabled = true; rejectBtn.textContent = 'Rejecting...'; await api('/pairing/reject', 'POST', { channel: ch, code: r.code }); await refresh(); };
            requestsEl.appendChild(div);
          }
        }
      }

      function renderAllowlist(payload) {
        const by = (payload && payload.allowlistByChannel) || {};
        const channels = Object.keys(by).sort();
        if (channels.length === 0) {
          allowEl.innerHTML = '<div class="status">No approved users yet. Approve a pairing request to add someone.</div>';
          return;
        }
        allowEl.innerHTML = '';
        for (const ch of channels) {
          const list = by[ch] || [];
          const header = document.createElement('div');
          header.style.marginTop = '8px';
          header.innerHTML = channelBadge(ch);
          allowEl.appendChild(header);
          const div = document.createElement('div');
          div.className = 'item';
          if (list.length === 0) {
            div.innerHTML = '<div class="status">No approved users on this channel.</div>';
          } else {
            div.innerHTML = '<div class="desc">' + list.map(id => esc(id)).join('<br/>') + '</div>';
          }
          allowEl.appendChild(div);
        }
      }

      async function refresh() {
        try {
          const reqs = await api('/pairing/requests', 'GET');
          const allow = await api('/pairing/allowlist', 'GET');
          pairingStatus.textContent = (reqs && reqs.pairingEnabled) ? 'enabled' : 'disabled';
          renderRequests(reqs);
          renderAllowlist(allow);
          streamError.style.display = 'none';
        } catch (e) {
          const msg = e.message || '';
          if (msg.includes('401')) {
            requestsEl.innerHTML = '<div class="status">Authentication failed. Check that your admin secret is correct.</div>';
          } else {
            requestsEl.innerHTML = '<div class="status">Could not load requests. Click Connect with a valid admin secret.</div>';
          }
          allowEl.innerHTML = '';
        }
      }

      let es;
      let reconnectAttempts = 0;
      function connect() {
        const secret = secretInput.value.trim();
        if (!secret) {
          hint.textContent = 'Find the secret in the terminal where your agent is running.';
          hint.style.color = 'var(--warn)';
          return;
        }
        localStorage.setItem('wunderland_hitl_secret', secret);
        hint.textContent = 'Connecting...';
        hint.style.color = 'var(--muted)';
        if (es) es.close();
        reconnectAttempts = 0;
        const u = new URL(server + '/hitl/stream');
        u.searchParams.set('secret', secret);
        es = new EventSource(u.toString());
        es.onopen = () => {
          streamStatus.textContent = 'connected';
          streamPill.className = 'pill ok';
          streamError.style.display = 'none';
          hint.textContent = 'Connected.';
          hint.style.color = 'var(--ok)';
          reconnectAttempts = 0;
          refresh();
        };
        es.onerror = () => {
          reconnectAttempts++;
          streamStatus.textContent = 'error';
          streamPill.className = 'pill error';
          if (reconnectAttempts <= 2) {
            streamError.innerHTML = '<strong>Connection failed.</strong> Possible causes:<ul style="margin:4px 0 0;padding-left:16px">' +
              '<li><strong>Wrong secret</strong> &mdash; check the <code>HITL secret: ...</code> line in your agent\\'s terminal output.</li>' +
              '<li><strong>Agent not running</strong> &mdash; make sure <code>wunderland start</code> is active.</li>' +
              '<li><strong>Network/firewall</strong> &mdash; if remote, use SSH tunnel: <code>ssh -L 3777:localhost:3777 you@server</code></li>' +
            '</ul>';
          } else {
            streamError.innerHTML = '<strong>Still unable to connect</strong> (attempt ' + reconnectAttempts + '). The stream will keep retrying automatically. If this persists, check your agent logs for errors.';
          }
          streamError.style.display = 'block';
          hint.textContent = 'Connection error. See details above.';
          hint.style.color = 'var(--danger)';
        };
        es.addEventListener('hitl', () => refresh());
      }

      document.getElementById('connect').onclick = connect;
      secretInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
      // Auto-connect if secret is already stored
      if (stored) { connect(); }
    </script>
  </body>
</html>`;

/** Full HTML page for the /hitl approval UI. */
// eslint-disable-next-line no-irregular-whitespace
export const HITL_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wunderland HITL</title>
    <style>
      :root { --bg: #0b1020; --panel: #111833; --text: #e8ecff; --muted: #9aa6d8; --accent: #53d6c7; --danger: #ff6b6b; --ok: #63e6be; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(1200px 800px at 20% 20%, #18244a, var(--bg)); color: var(--text); }
      header { padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(6px); position: sticky; top: 0; background: rgba(11,16,32,0.7); }
      h1 { margin: 0; font-size: 16px; letter-spacing: 0.2px; }
      main { padding: 18px 20px; display: grid; gap: 16px; max-width: 1100px; margin: 0 auto; }
      .row { display: grid; grid-template-columns: 1fr; gap: 16px; }
      @media (min-width: 900px) { .row { grid-template-columns: 1fr 1fr; } }
	      .card { background: rgba(17,24,51,0.78); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 14px; box-shadow: 0 20px 40px rgba(0,0,0,0.22); }
	      .card h2 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
	      .item { border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; padding: 12px; margin: 10px 0; background: rgba(0,0,0,0.14); }
	      .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
	      .id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; color: rgba(232,236,255,0.70); }
	      .desc { margin: 8px 0 10px; color: rgba(232,236,255,0.92); white-space: pre-wrap; }
	      .btns { display: flex; gap: 8px; flex-wrap: wrap; }
	      button { appearance: none; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: var(--text); padding: 8px 10px; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 12px; }
	      button:hover { border-color: rgba(83,214,199,0.55); }
      button.ok { background: rgba(99,230,190,0.12); border-color: rgba(99,230,190,0.28); }
      button.bad { background: rgba(255,107,107,0.10); border-color: rgba(255,107,107,0.30); }
      .meta { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; }
      input { width: 320px; max-width: 100%; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.22); color: var(--text); padding: 8px 10px; }
      .status { font-size: 12px; color: var(--muted); }
      .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); }
      .note { font-size: 12px; color: rgba(232,236,255,0.86); line-height: 1.5; }
      ul { margin: 8px 0 0; padding-left: 18px; }
      li { margin: 6px 0; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; color: rgba(232,236,255,0.92); }
    </style>
  </head>
  <body>
    <header>
      <h1>Wunderland HITL</h1>
      <div class="meta">
        <span class="pill">Server: <span id="server"></span></span>
        <span class="pill">Stream: <span id="streamStatus">disconnected</span></span>
      </div>
    </header>
    <main>
      <div class="card">
        <h2>Auth</h2>
        <div class="meta">
          <label>Secret</label>
          <input id="secret" placeholder="paste hitl secret" />
          <button id="connect" class="ok">Connect</button>
          <span class="status" id="hint"></span>
        </div>
      </div>
      <div class="card">
        <h2>Security</h2>
        <div class="note">
          <div><strong>Approvals can trigger real side effects.</strong> Only approve actions you understand.</div>
          <ul>
            <li>This UI uses <code>?secret=...</code> for API calls/streaming; don't share or screenshot URLs with the secret.</li>
            <li>This UI stores the secret in localStorage (<code>wunderland_hitl_secret</code>). Clear site data to forget it.</li>
            <li>For scripts, prefer the header <code>x-wunderland-hitl-secret</code>.</li>
            <li>Set/rotate via <code>agent.config.json</code> → <code>hitl.secret</code> or <code>WUNDERLAND_HITL_SECRET</code> (restart to rotate).</li>
            <li>Protect chat with <code>chat.secret</code> / <code>WUNDERLAND_CHAT_SECRET</code> if exposing <code>/chat</code>.</li>
            <li>Remote ops: <code>ssh -L 3777:localhost:3777 you@host</code> instead of opening the port publicly.</li>
          </ul>
        </div>
      </div>
      <div class="row">
        <div class="card">
          <h2>Approvals</h2>
          <div id="approvals"></div>
        </div>
        <div class="card">
          <h2>Checkpoints</h2>
          <div id="checkpoints"></div>
        </div>
      </div>
    </main>
    <script>
      const server = location.origin;
      document.getElementById('server').textContent = server;
      const secretInput = document.getElementById('secret');
      const hint = document.getElementById('hint');
      const streamStatus = document.getElementById('streamStatus');
	      const approvalsEl = document.getElementById('approvals');
	      const checkpointsEl = document.getElementById('checkpoints');
	      secretInput.value = localStorage.getItem('wunderland_hitl_secret') || '';

	      function esc(s) {
	        return String(s).replace(/[&<>"']/g, (c) => ({
	          '&': '&amp;',
	          '<': '&lt;',
	          '>': '&gt;',
	          '"': '&quot;',
	          "'": '&#39;',
	        }[c]));
	      }

      async function api(path, method, body) {
        const secret = secretInput.value.trim();
        const url = new URL(server + path);
        url.searchParams.set('secret', secret);
        const res = await fetch(url.toString(), { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
      }

      function renderApprovals(list) {
        approvalsEl.innerHTML = '';
        if (!list || list.length === 0) {
          approvalsEl.innerHTML = '<div class="status">No pending approvals.</div>';
          return;
        }
        for (const a of list) {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML = \`
            <div class="title">
              <div><strong>\${esc(a.severity || 'medium')}</strong></div>
              <div class="id">\${esc(a.actionId || '')}</div>
            </div>
            <div class="desc">\${esc(a.description || '')}</div>
            <div class="btns">
              <button class="ok">Approve</button>
              <button class="bad">Reject</button>
            </div>\`;
          const [approveBtn, rejectBtn] = div.querySelectorAll('button');
          approveBtn.onclick = async () => { await api('/hitl/approvals/' + encodeURIComponent(a.actionId) + '/approve', 'POST'); await refresh(); };
          rejectBtn.onclick = async () => { const reason = prompt('Rejection reason?') || ''; await api('/hitl/approvals/' + encodeURIComponent(a.actionId) + '/reject', 'POST', { reason }); await refresh(); };
          approvalsEl.appendChild(div);
        }
      }

      function renderCheckpoints(list) {
        checkpointsEl.innerHTML = '';
        if (!list || list.length === 0) {
          checkpointsEl.innerHTML = '<div class="status">No pending checkpoints.</div>';
          return;
        }
        for (const c of list) {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML = \`
            <div class="title">
              <div><strong>\${esc(c.currentPhase || 'checkpoint')}</strong></div>
              <div class="id">\${esc(c.checkpointId || '')}</div>
            </div>
            <div class="desc">\${esc((c.completedWork || []).join('\\n'))}</div>
            <div class="btns">
              <button class="ok">Continue</button>
              <button class="bad">Abort</button>
            </div>\`;
          const [continueBtn, abortBtn] = div.querySelectorAll('button');
          continueBtn.onclick = async () => { await api('/hitl/checkpoints/' + encodeURIComponent(c.checkpointId) + '/continue', 'POST'); await refresh(); };
          abortBtn.onclick = async () => { const instructions = prompt('Abort instructions?') || ''; await api('/hitl/checkpoints/' + encodeURIComponent(c.checkpointId) + '/abort', 'POST', { instructions }); await refresh(); };
          checkpointsEl.appendChild(div);
        }
      }

      async function refresh() {
        try {
          const pending = await api('/hitl/pending', 'GET');
          renderApprovals(pending.approvals || []);
          renderCheckpoints(pending.checkpoints || []);
        } catch (e) {
          approvalsEl.innerHTML = '<div class="status">Paste the HITL secret to view pending requests.</div>';
          checkpointsEl.innerHTML = '';
        }
      }

      let es;
      function connect() {
        const secret = secretInput.value.trim();
        if (!secret) { hint.textContent = 'Paste secret from server logs.'; return; }
        localStorage.setItem('wunderland_hitl_secret', secret);
        if (es) es.close();
        const u = new URL(server + '/hitl/stream');
        u.searchParams.set('secret', secret);
        es = new EventSource(u.toString());
        es.onopen = () => { streamStatus.textContent = 'connected'; hint.textContent = ''; refresh(); };
        es.onerror = () => { streamStatus.textContent = 'error'; };
        es.addEventListener('hitl', () => refresh());
      }

      document.getElementById('connect').onclick = connect;
      refresh();
    </script>
  </body>
</html>`;
