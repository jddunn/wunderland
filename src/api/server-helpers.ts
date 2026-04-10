// @ts-nocheck
/**
 * @fileoverview HTTP helper utilities for the Wunderland server.
 * Extracted from server.ts for readability.
 */

import type { WunderlandAgentConfig } from './types.js';
import type { ToolInstance } from '../runtime/tool-calling.js';

export type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

export function consoleLogger(): Required<LoggerLike> {
  return {
    debug: (msg, meta) => console.debug(msg, meta ?? ''),
    info: (msg, meta) => console.log(msg, meta ?? ''),
    warn: (msg, meta) => console.warn(msg, meta ?? ''),
    error: (msg, meta) => console.error(msg, meta ?? ''),
  };
}

export function toToolInstance(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  category?: string;
  requiredCapabilities?: string[];
  execute: (...args: any[]) => any;
}): ToolInstance {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as any,
    hasSideEffects: tool.hasSideEffects === true,
    category: typeof tool.category === 'string' && tool.category.trim() ? tool.category : 'productivity',
    requiredCapabilities: tool.requiredCapabilities,
    execute: tool.execute as any,
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

export function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const maxBytes = 1_000_000;

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

export function getHeaderString(req: import('node:http').IncomingMessage, header: string): string {
  const v = req.headers[header.toLowerCase()];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return (v[0] || '').trim();
  return '';
}

export function extractHitlSecret(req: import('node:http').IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-hitl-secret');
  if (fromHeader) return fromHeader;
  const fromQuery = (url.searchParams.get('secret') || '').trim();
  return fromQuery;
}

export function isHitlAuthorized(req: import('node:http').IncomingMessage, url: URL, hitlSecret: string): boolean {
  if (!hitlSecret) return true;
  return extractHitlSecret(req, url) === hitlSecret;
}

export function inferTurnApprovalMode(cfg: WunderlandAgentConfig | undefined): 'off' | 'after-each-turn' | 'after-each-round' {
  const raw =
    cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl)
      ? (cfg.hitl as any).turnApprovalMode ?? (cfg.hitl as any).turnApproval
      : undefined;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'after-each-turn') return 'after-each-turn';
  if (v === 'after-each-round') return 'after-each-round';
  return 'off';
}

export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export const PAIRING_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wunderland Pairing</title>
    <style>
      :root { --bg: #0b1020; --panel: #111833; --text: #e8ecff; --muted: #9aa6d8; --accent: #53d6c7; --danger: #ff6b6b; --ok: #63e6be; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(1200px 800px at 20% 20%, #18244a, var(--bg)); color: var(--text); }
      header { padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); position: sticky; top: 0; background: rgba(11,16,32,0.75); backdrop-filter: blur(6px); }
      h1 { margin: 0; font-size: 16px; letter-spacing: 0.2px; }
      main { padding: 18px 20px; display: grid; gap: 16px; max-width: 1100px; margin: 0 auto; }
      .row { display: grid; grid-template-columns: 1fr; gap: 16px; }
      @media (min-width: 900px) { .row { grid-template-columns: 1fr 1fr; } }
      .card { background: rgba(17,24,51,0.78); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 14px; box-shadow: 0 20px 40px rgba(0,0,0,0.22); }
      .card h2 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
      .meta { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
      input { width: 360px; max-width: 100%; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.22); color: var(--text); padding: 8px 10px; }
      button { appearance: none; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: var(--text); padding: 8px 10px; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 12px; }
      button:hover { border-color: rgba(83,214,199,0.55); }
      button.ok { background: rgba(99,230,190,0.12); border-color: rgba(99,230,190,0.28); }
      button.bad { background: rgba(255,107,107,0.10); border-color: rgba(255,107,107,0.30); }
      .item { border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; padding: 12px; margin: 10px 0; background: rgba(0,0,0,0.14); }
      .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 12px; color: rgba(232,236,255,0.85); }
      .desc { margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 11px; color: rgba(232,236,255,0.78); line-height: 1.5; white-space: pre-wrap; }
      .btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .status { font-size: 12px; color: var(--muted); }
      .note { font-size: 12px; color: rgba(232,236,255,0.86); line-height: 1.5; }
      ul { margin: 8px 0 0; padding-left: 18px; }
      li { margin: 6px 0; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; color: rgba(232,236,255,0.92); }
    </style>
  </head>
  <body>
    <header>
      <h1>Wunderland Pairing</h1>
      <div class="meta">
        <span>Paste the admin secret to approve pairing codes.</span>
      </div>
    </header>
    <main>
      <div class="card">
        <h2>Admin Secret</h2>
        <div class="meta">
          <input id="secret" placeholder="x-wunderland-hitl-secret" />
          <button id="connect" class="ok">Connect</button>
          <button id="refresh">Refresh</button>
          <span class="status" id="hint"></span>
        </div>
        <div class="status" style="margin-top:10px">
          Unknown senders receive a pairing code automatically in DMs. In group chats, send the pairing trigger (default <code>!pair</code>) to request one.
        </div>
      </div>

      <div class="card">
        <h2>Security</h2>
        <div class="note">
          <div><strong>Treat the secret like a password.</strong> This server binds to <code>0.0.0.0</code> by default.</div>
          <ul>
            <li>Don’t share URLs containing <code>?secret=...</code> (they can end up in browser history/logs).</li>
            <li>This UI stores the secret in localStorage (<code>wunderland_hitl_secret</code>). Clear site data to forget it.</li>
            <li>Set a stable secret via <code>agent.config.json</code> → <code>hitl.secret</code> or <code>WUNDERLAND_HITL_SECRET</code> (restart to rotate).</li>
            <li>Remote ops: use SSH port-forwarding (example: <code>ssh -L 3777:localhost:3777 you@host</code>).</li>
            <li>Approve pairing only for people you trust (it grants the sender access to the agent).</li>
          </ul>
          <div style="margin-top:10px">Tip: run <code>wunderland help security</code> for the full model.</div>
        </div>
      </div>

      <div class="row">
        <div class="card">
          <h2>Pending Requests</h2>
          <div id="requests" class="status">Loading…</div>
        </div>
        <div class="card">
          <h2>Allowlist</h2>
          <div id="allowlist" class="status">Loading…</div>
        </div>
      </div>
    </main>
    <script>
      const server = window.location.origin;
      const secretInput = document.getElementById('secret');
      const hint = document.getElementById('hint');
      const requestsEl = document.getElementById('requests');
      const allowEl = document.getElementById('allowlist');

      const stored = localStorage.getItem('wunderland_hitl_secret');
      if (stored) secretInput.value = stored;

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
        return String(s || '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));
      }

      function renderRequests(payload) {
        const by = (payload && payload.requestsByChannel) || {};
        const channels = Object.keys(by).sort();
        if (channels.length === 0) { requestsEl.innerHTML = '<div class=\"status\">No pending requests.</div>'; return; }
        requestsEl.innerHTML = '';
        for (const ch of channels) {
          const list = by[ch] || [];
          if (!list.length) continue;
          const header = document.createElement('div');
          header.className = 'status';
          header.textContent = ch;
          header.style.marginTop = '8px';
          requestsEl.appendChild(header);
          for (const r of list) {
            const div = document.createElement('div');
            div.className = 'item';
            div.innerHTML =
              '<div class=\"title\"><div><strong>' + esc(r.code || '') + '</strong></div><div class=\"id\">' + esc(r.id || '') + '</div></div>' +
              '<div class=\"desc\">' + esc(JSON.stringify(r.meta || {}, null, 2)) + '</div>' +
              '<div class=\"btns\"><button class=\"ok\">Approve</button><button class=\"bad\">Reject</button></div>';
            const btns = div.querySelectorAll('button');
            btns[0].onclick = async () => { await api('/pairing/approve', 'POST', { channel: ch, code: r.code }); await refresh(); };
            btns[1].onclick = async () => { await api('/pairing/reject', 'POST', { channel: ch, code: r.code }); await refresh(); };
            requestsEl.appendChild(div);
          }
        }
      }

      function renderAllowlist(payload) {
        const by = (payload && payload.allowlistByChannel) || {};
        const channels = Object.keys(by).sort();
        if (channels.length === 0) { allowEl.innerHTML = '<div class=\"status\">No allowlist entries.</div>'; return; }
        allowEl.innerHTML = '';
        for (const ch of channels) {
          const list = by[ch] || [];
          const header = document.createElement('div');
          header.className = 'status';
          header.textContent = ch;
          header.style.marginTop = '8px';
          allowEl.appendChild(header);
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML = '<div class=\"desc\">' + esc(list.join('\\n')) + '</div>';
          allowEl.appendChild(div);
        }
      }

      async function refresh() {
        try {
          const pending = await api('/pairing/requests', 'GET');
          renderRequests(pending);
          const allow = await api('/pairing/allowlist', 'GET');
          renderAllowlist(allow);
          hint.textContent = '';
        } catch (e) {
          requestsEl.innerHTML = '<div class=\"status\">Paste the admin secret to view pairing requests.</div>';
          allowEl.innerHTML = '';
          hint.textContent = 'Unauthorized or server error.';
        }
      }

      function connect() {
        const secret = secretInput.value.trim();
        if (!secret) { hint.textContent = 'Paste secret from server logs.'; return; }
        localStorage.setItem('wunderland_hitl_secret', secret);
        refresh();
      }

      document.getElementById('connect').onclick = connect;
      document.getElementById('refresh').onclick = refresh;
      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>`;

export const HITL_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wunderland HITL</title>
    <style>
      :root { --bg: #0b1020; --panel: #111833; --text: #e8ecff; --muted: #9aa6d8; --accent: #53d6c7; --danger: #ff6b6b; --ok: #63e6be; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(1200px 800px at 20% 20%, #18244a, var(--bg)); color: var(--text); }
      header { padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); position: sticky; top: 0; background: rgba(11,16,32,0.75); backdrop-filter: blur(6px); }
      h1 { margin: 0; font-size: 16px; letter-spacing: 0.2px; }
      main { padding: 18px 20px; display: grid; gap: 16px; max-width: 1100px; margin: 0 auto; }
      .row { display: grid; grid-template-columns: 1fr; gap: 16px; }
      @media (min-width: 900px) { .row { grid-template-columns: 1fr 1fr; } }
      .card { background: rgba(17,24,51,0.78); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 14px; box-shadow: 0 20px 40px rgba(0,0,0,0.22); }
      .card h2 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
      .meta { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
      input { width: 360px; max-width: 100%; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.22); color: var(--text); padding: 8px 10px; }
      button { appearance: none; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: var(--text); padding: 8px 10px; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 12px; }
      button:hover { border-color: rgba(83,214,199,0.55); }
      button.ok { background: rgba(99,230,190,0.12); border-color: rgba(99,230,190,0.28); }
      button.bad { background: rgba(255,107,107,0.10); border-color: rgba(255,107,107,0.30); }
      .item { border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; padding: 12px; margin: 10px 0; background: rgba(0,0,0,0.14); }
      .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 12px; color: rgba(232,236,255,0.85); }
      .desc { margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 11px; color: rgba(232,236,255,0.78); line-height: 1.5; white-space: pre-wrap; }
      .btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .status { font-size: 12px; color: var(--muted); }
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
        <span>Approve tool calls and checkpoints.</span>
      </div>
    </header>
    <main>
      <div class="card">
        <h2>Admin Secret</h2>
        <div class="meta">
          <input id="secret" placeholder="x-wunderland-hitl-secret" />
          <button id="connect" class="ok">Connect</button>
          <button id="refresh">Refresh</button>
          <span class="status" id="hint"></span>
          <span class="status">Pending: <span id="pendingCount">0</span></span>
          <span class="status">Stream: <span id="streamStatus">disconnected</span></span>
        </div>
      </div>

      <div class="card">
        <h2>Security</h2>
        <div class="note">
          <div><strong>Approvals can trigger real side effects.</strong> Only approve actions you understand.</div>
          <ul>
            <li>This UI uses <code>?secret=...</code> for API calls/streaming; don’t share or screenshot URLs with the secret.</li>
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
          <div id="approvals" class="status">Loading…</div>
        </div>
        <div class="card">
          <h2>Checkpoints</h2>
          <div id="checkpoints" class="status">Loading…</div>
        </div>
      </div>
    </main>
    <script>
      const server = window.location.origin;
      const secretInput = document.getElementById('secret');
      const hint = document.getElementById('hint');
      const approvalsEl = document.getElementById('approvals');
      const checkpointsEl = document.getElementById('checkpoints');
      const pendingCount = document.getElementById('pendingCount');
      const streamStatus = document.getElementById('streamStatus');

      const stored = localStorage.getItem('wunderland_hitl_secret');
      if (stored) secretInput.value = stored;

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
        return String(s || '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));
      }

      function renderApprovals(approvals) {
        if (!approvals || approvals.length === 0) { approvalsEl.innerHTML = '<div class=\"status\">No pending approvals.</div>'; return; }
        approvalsEl.innerHTML = '';
        for (const a of approvals) {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML =
            '<div class=\"title\"><div><strong>' + esc(a.severity || 'low') + '</strong></div><div class=\"id\">' + esc(a.actionId || '') + '</div></div>' +
            '<div class=\"desc\">' + esc(a.description || '') + '</div>' +
            '<div class=\"btns\"><button class=\"ok\">Approve</button><button class=\"bad\">Reject</button></div>';
          const btns = div.querySelectorAll('button');
          btns[0].onclick = async () => { await api('/hitl/approvals/' + encodeURIComponent(a.actionId) + '/approve', 'POST', { decidedBy: 'operator' }); await refresh(); };
          btns[1].onclick = async () => { const reason = prompt('Rejection reason (optional):') || ''; await api('/hitl/approvals/' + encodeURIComponent(a.actionId) + '/reject', 'POST', { decidedBy: 'operator', reason }); await refresh(); };
          approvalsEl.appendChild(div);
        }
      }

      function renderCheckpoints(checkpoints) {
        if (!checkpoints || checkpoints.length === 0) { checkpointsEl.innerHTML = '<div class=\"status\">No pending checkpoints.</div>'; return; }
        checkpointsEl.innerHTML = '';
        for (const c of checkpoints) {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML =
            '<div class=\"title\"><div><strong>' + esc(c.workflowId || 'workflow') + '</strong></div><div class=\"id\">' + esc(c.checkpointId || '') + '</div></div>' +
            '<div class=\"desc\">' + esc(JSON.stringify({ phase: c.currentPhase, progress: c.progress, notes: c.notes, issues: c.issues, completedWork: c.completedWork }, null, 2)) + '</div>' +
            '<div class=\"btns\"><button class=\"ok\">Continue</button><button class=\"bad\">Abort</button></div>';
          const btns = div.querySelectorAll('button');
          btns[0].onclick = async () => { await api('/hitl/checkpoints/' + encodeURIComponent(c.checkpointId) + '/continue', 'POST', { decidedBy: 'operator' }); await refresh(); };
          btns[1].onclick = async () => { await api('/hitl/checkpoints/' + encodeURIComponent(c.checkpointId) + '/abort', 'POST', { decidedBy: 'operator' }); await refresh(); };
          checkpointsEl.appendChild(div);
        }
      }

      async function refresh() {
        try {
          const pending = await api('/hitl/pending', 'GET');
          const approvals = pending && pending.approvals ? pending.approvals : [];
          const checkpoints = pending && pending.checkpoints ? pending.checkpoints : [];
          pendingCount.textContent = String((approvals.length || 0) + (checkpoints.length || 0));
          renderApprovals(approvals);
          renderCheckpoints(checkpoints);
          hint.textContent = '';
        } catch (e) {
          approvalsEl.innerHTML = '<div class=\"status\">Paste the admin secret to view pending actions.</div>';
          checkpointsEl.innerHTML = '';
          hint.textContent = 'Unauthorized or server error.';
        }
      }

      let es;
      function connectStream() {
        const secret = secretInput.value.trim();
        if (!secret) return;
        if (es) es.close();
        const u = new URL(server + '/hitl/stream');
        u.searchParams.set('secret', secret);
        es = new EventSource(u.toString());
        es.onopen = () => { streamStatus.textContent = 'connected'; };
        es.onerror = () => { streamStatus.textContent = 'error'; };
        es.addEventListener('hitl', () => refresh());
      }

      function connect() {
        const secret = secretInput.value.trim();
        if (!secret) { hint.textContent = 'Paste secret from server logs.'; return; }
        localStorage.setItem('wunderland_hitl_secret', secret);
        refresh();
        connectStream();
      }

      document.getElementById('connect').onclick = connect;
      document.getElementById('refresh').onclick = refresh;
      refresh();
    </script>
  </body>
</html>`;

