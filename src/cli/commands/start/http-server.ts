/**
 * @fileoverview Extracted HTTP server from `wunderland start`.
 * Creates the HTTP server with all route handlers (pairing, HITL, health, chat, feed, extensions).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { VERSION } from '../../constants.js';
import {
  buildToolDefs,
  runToolCallingTurn,
  safeJsonStringify,
  type ToolInstance,
} from '../../openai/tool-calling.js';
import { maybeProxyAgentosRagRequest } from '../../../rag/http-proxy.js';
import {
  classifyResearchDepth,
  buildResearchPrefix,
  shouldInjectResearch,
  type ResearchDepth,
} from '../../../runtime/research-classifier.js';
import {
  buildPersonaSessionKey,
  createRequestScopedToolMap,
  extractRequestedPersonaId,
  resolveRequestScopedPersonaRuntime,
} from '../../../runtime/request-persona.js';
import { buildOllamaRuntimeOptions } from '../../../runtime/ollama-options.js';

// ── HTTP helpers ────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function getHeaderString(req: IncomingMessage, header: string): string {
  const v = req.headers[header.toLowerCase()];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return (v[0] || '').trim();
  return '';
}

function extractHitlSecret(req: IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-hitl-secret');
  if (fromHeader) return fromHeader;
  const fromQuery = (url.searchParams.get('secret') || '').trim();
  return fromQuery;
}

function isHitlAuthorized(req: IncomingMessage, url: URL, hitlSecret: string): boolean {
  if (!hitlSecret) return true;
  return extractHitlSecret(req, url) === hitlSecret;
}

function extractChatSecret(req: IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-chat-secret');
  if (fromHeader) return fromHeader;
  const fromQuery = (url.searchParams.get('chat_secret') || url.searchParams.get('secret') || '').trim();
  return fromQuery;
}

function isChatAuthorized(req: IncomingMessage, url: URL, chatSecret: string): boolean {
  if (!chatSecret) return true;
  return extractChatSecret(req, url) === chatSecret;
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function extractFeedSecret(req: IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-feed-secret');
  if (fromHeader) return fromHeader;
  const fromQuery = (url.searchParams.get('feed_secret') || '').trim();
  return fromQuery;
}

function isFeedAuthorized(req: IncomingMessage, url: URL, feedSecret: string): boolean {
  if (!feedSecret) return true;
  return extractFeedSecret(req, url) === feedSecret;
}

type AgentosApprovalCategory = 'data_modification' | 'external_api' | 'financial' | 'communication' | 'system' | 'other';

function toAgentosApprovalCategory(tool: ToolInstance): AgentosApprovalCategory {
  const name = String(tool?.name || '').toLowerCase();
  if (name.startsWith('file_') || name.includes('shell_') || name.includes('run_command') || name.includes('exec')) return 'system';
  if (name.startsWith('browser_') || name.includes('web_')) return 'external_api';
  const cat = String(tool?.category || '').toLowerCase();
  if (cat.includes('financial')) return 'financial';
  if (cat.includes('communication')) return 'communication';
  if (cat.includes('external') || cat.includes('api') || cat === 'research' || cat === 'search') return 'external_api';
  if (cat.includes('data')) return 'data_modification';
  if (cat.includes('system') || cat.includes('filesystem')) return 'system';
  return 'other';
}

// ── Server factory ──────────────────────────────────────────────────────────

export function createAgentHttpServer(ctx: any): import('node:http').Server {
  const {
    hitlSecret,
    chatSecret,
    feedSecret,
    hitlManager,
    pairing,
    pairingEnabled,
    sessions,
    systemPrompt,
    toolMap,
    canUseLLM,
    seed,
    seedId,
    displayName,
    providerId,
    model,
    llmApiKey,
    llmBaseUrl,
    policy,
    adaptiveRuntime,
    discoveryManager,
    autoApproveToolCalls,
    dangerouslySkipPermissions,
    strictToolNames,
    openrouterFallback,
    oauthGetApiKey,
    workspaceAgentId,
    workspaceBaseDir,
    sseClients,
    broadcastHitlUpdate,
    adapterByPlatform,
    loadedHttpHandlers,
    turnApprovalMode,
    defaultTenantId,
    port,
    startTime,
    cfg,
    rawAgentConfig,
    globalConfig,
    configDir,
    lazyTools,
    skillsPrompt,
    selectedPersona,
    availablePersonas,
  } = ctx;
  const activePersonaId =
    typeof cfg?.selectedPersonaId === 'string' && cfg.selectedPersonaId.trim()
      ? cfg.selectedPersonaId.trim()
      : seed.seedId;

  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-API-Key, X-Auto-Approve, X-Wunderland-HITL-Secret, X-Wunderland-Chat-Secret, X-Wunderland-Feed-Secret',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (await maybeProxyAgentosRagRequest({ req, res, url, agentConfig: cfg })) {
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/agentos/personas') {
        sendJson(res, 200, {
          selectedPersonaId: activePersonaId !== seed.seedId ? activePersonaId : undefined,
          selectedPersona: selectedPersona ?? undefined,
          personas: availablePersonas ?? [],
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/agentos/personas/')) {
        const personaId = decodeURIComponent(url.pathname.slice('/api/agentos/personas/'.length));
        const persona = Array.isArray(availablePersonas)
          ? availablePersonas.find((entry: any) => entry?.id === personaId)
          : undefined;
        if (!persona) {
          sendJson(res, 404, { error: `Persona '${personaId}' not found.` });
          return;
        }
        sendJson(res, 200, { persona });
        return;
      }

      if (url.pathname.startsWith('/pairing')) {
        if (req.method === 'GET' && url.pathname === '/pairing') {
          const html = `<!doctype html>
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (!isHitlAuthorized(req, url, hitlSecret)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }

        const channels: string[] = Array.from(adapterByPlatform.keys()) as string[];

        if (req.method === 'GET' && url.pathname === '/pairing/requests') {
          const requestsByChannel: Record<string, unknown> = {};
          for (const channel of channels) {
            try {
              requestsByChannel[channel] = await pairing.listRequests(channel);
            } catch {
              requestsByChannel[channel] = [];
            }
          }
          sendJson(res, 200, { pairingEnabled, channels, requestsByChannel });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/pairing/allowlist') {
          const allowlistByChannel: Record<string, unknown> = {};
          for (const channel of channels) {
            try {
              allowlistByChannel[channel] = await pairing.readAllowlist(channel);
            } catch {
              allowlistByChannel[channel] = [];
            }
          }
          sendJson(res, 200, { channels, allowlistByChannel });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/pairing/approve') {
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : {};
          const channel = typeof parsed?.channel === 'string' ? parsed.channel.trim() : '';
          const code = typeof parsed?.code === 'string' ? parsed.code.trim() : '';
          if (!channel || !code) {
            sendJson(res, 400, { error: 'Missing channel/code' });
            return;
          }
          const result = await pairing.approveCode(channel, code);
          void broadcastHitlUpdate({ type: 'pairing_approved', channel, code });
          sendJson(res, 200, { ok: true, result });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/pairing/reject') {
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : {};
          const channel = typeof parsed?.channel === 'string' ? parsed.channel.trim() : '';
          const code = typeof parsed?.code === 'string' ? parsed.code.trim() : '';
          if (!channel || !code) {
            sendJson(res, 400, { error: 'Missing channel/code' });
            return;
          }
          const ok = await pairing.rejectCode(channel, code);
          void broadcastHitlUpdate({ type: 'pairing_rejected', channel, code });
          sendJson(res, 200, { ok });
          return;
        }

        sendJson(res, 404, { error: 'Not Found' });
        return;
      }

      if (url.pathname.startsWith('/hitl')) {
        if (req.method === 'GET' && url.pathname === '/hitl') {
          const html = `<!doctype html>
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (!isHitlAuthorized(req, url, hitlSecret)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/hitl/pending') {
          const pending = await hitlManager.getPendingRequests();
          sendJson(res, 200, pending);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/hitl/stats') {
          sendJson(res, 200, hitlManager.getStatistics());
          return;
        }

        if (req.method === 'GET' && url.pathname === '/hitl/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wunderland-HITL-Secret',
          });
          res.write('event: ready\ndata: {}\n\n');
          sseClients.add(res);

          // Push an initial snapshot.
          try {
            const pending = await hitlManager.getPendingRequests();
            res.write(`event: hitl\ndata: ${JSON.stringify({ type: 'snapshot', pending })}\n\n`);
          } catch {
            // ignore
          }

          const ping = setInterval(() => {
            try {
              res.write(`event: ping\ndata: ${Date.now()}\n\n`);
            } catch {
              // ignore
            }
          }, 15_000);

          req.on('close', () => {
            clearInterval(ping);
            sseClients.delete(res);
          });
          return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/hitl/approvals/')) {
          const parts = url.pathname.split('/').filter(Boolean);
          const actionId = parts[2] || '';
          const action = parts[3] || '';
          if (!actionId || (action !== 'approve' && action !== 'reject')) {
            sendJson(res, 404, { error: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : {};
          const decidedBy = typeof parsed?.decidedBy === 'string' && parsed.decidedBy.trim() ? parsed.decidedBy.trim() : 'operator';
          const rejectionReason = typeof parsed?.reason === 'string' ? parsed.reason : undefined;

          await hitlManager.submitApprovalDecision({
            actionId,
            approved: action === 'approve',
            decidedBy,
            decidedAt: new Date(),
            ...(action === 'reject' && rejectionReason ? { rejectionReason } : null),
          } as any);

          void broadcastHitlUpdate({ type: 'approval_decision', actionId, approved: action === 'approve', decidedBy });
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/hitl/checkpoints/')) {
          const parts = url.pathname.split('/').filter(Boolean);
          const checkpointId = parts[2] || '';
          const action = parts[3] || '';
          if (!checkpointId || (action !== 'continue' && action !== 'pause' && action !== 'abort')) {
            sendJson(res, 404, { error: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : {};
          const decidedBy = typeof parsed?.decidedBy === 'string' && parsed.decidedBy.trim() ? parsed.decidedBy.trim() : 'operator';
          const instructions = typeof parsed?.instructions === 'string' ? parsed.instructions : undefined;

          await hitlManager.submitCheckpointDecision({
            checkpointId,
            decision: action,
            decidedBy,
            decidedAt: new Date(),
            ...(instructions ? { instructions } : null),
          } as any);

          void broadcastHitlUpdate({ type: 'checkpoint_decision', checkpointId, decision: action, decidedBy });
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 404, { error: 'Not Found' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        const mem = process.memoryUsage();
        sendJson(res, 200, {
          ok: true,
          seedId,
          name: displayName,
          uptime: Math.floor((Date.now() - startTime) / 1000),
          version: VERSION,
          port,
          persona: selectedPersona ?? (activePersonaId !== seed.seedId ? { id: activePersonaId } : undefined),
          personasAvailable: Array.isArray(availablePersonas) ? availablePersonas.length : 0,
          memory: {
            rss: Math.round(mem.rss / 1024 / 1024),
            heap: Math.round(mem.heapUsed / 1024 / 1024),
          },
          tools: toolMap.size,
          channels: adapterByPlatform.size,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/chat') {
        sendJson(res, 200, {
          endpoint: 'POST /chat',
          usage: 'Send a JSON body with { "message": "your prompt" }. Optional fields: sessionId, personaId, reset, tenantId, toolFailureMode.',
          example: 'curl -X POST http://localhost:' + port + '/chat -H "Content-Type: application/json" -d \'{"message":"hello","personaId":"voice_assistant_persona"}\'',
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/chat') {
        if (!isChatAuthorized(req, url, chatSecret)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }

        const body = await readBody(req);
        const parsed = JSON.parse(body || '{}');
        let message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        if (!message) {
          sendJson(res, 400, { error: 'Missing "message" in JSON body.' });
          return;
        }

        // Research depth escalation: explicit prefix/body field, or LLM-as-judge auto-classify
        const researchMatch = message.match(/^\/(research|deep)\s+(.+)/is);
        let researchDepth: string | null = parsed.research === true ? 'moderate'
          : parsed.research === 'deep' ? 'deep'
          : parsed.research === 'quick' ? 'quick'
          : researchMatch ? (researchMatch[1].toLowerCase() === 'deep' ? 'deep' : 'moderate')
          : null;
        if (researchMatch) message = researchMatch[2].trim();

        // Auto-classify with LLM-as-judge when no explicit depth
        const autoClassifyEnabled = cfg?.research?.autoClassify !== false && parsed.autoClassify !== false;
        if (!researchDepth && autoClassifyEnabled) {
          try {
            const classifierResult = await classifyResearchDepth(message, {
              enabled: true,
              llmCall: async (system: string, user: string) => {
                const resp = await fetch(
                  `${llmBaseUrl || 'https://api.openai.com/v1'}/chat/completions`,
                  {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${llmApiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      model: providerId === 'ollama' ? 'qwen2.5:3b' : providerId === 'gemini' ? 'gemini-2.0-flash-lite' : 'gpt-4o-mini',
                      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                      temperature: 0,
                      max_tokens: 100,
                    }),
                  }
                );
                if (!resp.ok) return '{"depth":"none"}';
                const data = await resp.json() as any;
                return data?.choices?.[0]?.message?.content || '{"depth":"none"}';
              },
            });
            const minDepth = (cfg?.research?.minDepthToInject as ResearchDepth) || 'quick';
            if (shouldInjectResearch(classifierResult.depth, minDepth)) {
              researchDepth = classifierResult.depth;
            }
          } catch {
            // Classification failure — proceed without research injection
          }
        }

        if (researchDepth) {
          const prefix = buildResearchPrefix(researchDepth as ResearchDepth);
          if (prefix) message = `${prefix}\n\n${message}`;
        }

        const streamMode = parsed.stream === true;

        // When streaming, switch to SSE so progress events can be pushed to the client.
        if (streamMode) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
        }

        let reply = '';
        let turnFailed = false;
        let fallbackTriggered = false;
        let toolCallCount = 0;
        const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
          ? parsed.sessionId.trim().slice(0, 128)
          : 'default';
        const requestedPersonaId = extractRequestedPersonaId(parsed);
        let requestActivePersonaId = activePersonaId;
        let requestSystemPrompt = systemPrompt;
        let requestToolMap = toolMap;

        if (requestedPersonaId && requestedPersonaId !== activePersonaId) {
          const personaRuntime = await resolveRequestScopedPersonaRuntime({
            rawAgentConfig: rawAgentConfig ?? cfg,
            requestedPersonaId,
            workingDirectory: configDir ?? process.cwd(),
            policy,
            mode: 'server',
            lazyTools: lazyTools === true,
            autoApproveToolCalls,
            turnApprovalMode,
            skillsPrompt: skillsPrompt || undefined,
            globalAgentName: globalConfig?.agentName,
          });

          if (!personaRuntime) {
            sendJson(res, 400, {
              error: `Persona '${requestedPersonaId}' not found.`,
              availablePersonaIds: Array.isArray(availablePersonas) ? availablePersonas.map((persona: any) => persona.id) : [],
            });
            return;
          }

          requestActivePersonaId = personaRuntime.activePersonaId;
          requestSystemPrompt = personaRuntime.systemPrompt;
          requestToolMap = createRequestScopedToolMap(toolMap, personaRuntime.agentConfig);
        }

        const internalSessionId = buildPersonaSessionKey(sessionId, requestActivePersonaId);
        const requestedToolFailureMode =
          typeof parsed.toolFailureMode === 'string' ? parsed.toolFailureMode : undefined;
        const tenantId =
          (typeof parsed.tenantId === 'string' && parsed.tenantId.trim())
          || defaultTenantId;

        const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
          scope: {
            sessionId,
            userId: sessionId,
            personaId: requestActivePersonaId,
            tenantId: tenantId || undefined,
          },
          requestedToolFailureMode,
        });

        if (parsed.reset === true) {
          sessions.delete(internalSessionId);
        }

        let messages = sessions.get(internalSessionId);
        if (!messages) {
          messages = [{ role: 'system', content: requestSystemPrompt }];
          sessions.set(internalSessionId, messages);
        }

        // Keep a soft cap to avoid unbounded memory in long-running servers.
        if (messages.length > 200) {
          messages = [messages[0]!, ...messages.slice(-120)];
          sessions.set(internalSessionId, messages);
        }

        messages.push({ role: 'user', content: message });

        // Work on a shallow copy so a mid-flight tool-call failure
        // doesn't corrupt the persisted session history with orphaned
        // tool_calls entries (OpenAI rejects the entire conversation
        // if an assistant message with tool_calls isn't followed by
        // matching tool response messages).
        const workingMessages = [...messages];

        try {
          if (canUseLLM) {
            // Capability discovery — inject tiered context AND build filtered tool set
            let apiDiscoveredToolNames: Set<string> | null = null;
            try {
              const discoveryResult = await discoveryManager.discoverForTurn(message);
              if (discoveryResult) {
                for (let i = workingMessages.length - 1; i >= 1; i--) {
                  if (typeof workingMessages[i]?.content === 'string' && String(workingMessages[i]!.content).startsWith('[Capability Context]')) {
                    workingMessages.splice(i, 1);
                  }
                }
                const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
                if (discoveryResult.tier1.length > 0) {
                  ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r: any) => r.summaryText).join('\n'));
                }
                if (discoveryResult.tier2.length > 0) {
                  ctxParts.push(discoveryResult.tier2.map((r: any) => r.fullText).join('\n'));
                }
                workingMessages.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });

                // Extract discovered tool names for filtered tool defs
                const names = new Set<string>();
                for (const r of discoveryResult.tier1) {
                  if (r.capability?.kind === 'tool') {
                    const toolName = r.capability.id?.startsWith('tool:') ? r.capability.id.slice(5) : r.capability.name;
                    names.add(toolName);
                  }
                }
                for (const r of discoveryResult.tier2) {
                  if (r.capability?.kind === 'tool') {
                    const toolName = r.capability.id?.startsWith('tool:') ? r.capability.id.slice(5) : r.capability.name;
                    names.add(toolName);
                  }
                }
                for (const [name] of requestToolMap) {
                  if (name.startsWith('extensions_') || name === 'discover_capabilities') names.add(name);
                }
                if (names.size > 0) apiDiscoveredToolNames = names;
              }
            } catch {
              // Non-fatal
            }

            const toolContext = {
              gmiId: `wunderland-server-${internalSessionId}`,
              personaId: requestActivePersonaId,
              userContext: {
                userId: sessionId,
                ...(tenantId ? { organizationId: tenantId } : null),
              },
              agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
              permissionSet: policy.permissionSet,
              securityTier: policy.securityTier,
              executionMode: policy.executionMode,
              toolAccessProfile: policy.toolAccessProfile,
              interactiveSession: false,
              turnApprovalMode,
              toolFailureMode: adaptiveDecision.toolFailureMode,
              adaptiveExecution: {
                degraded: adaptiveDecision.degraded,
                reason: adaptiveDecision.reason,
                actions: adaptiveDecision.actions,
                kpi: adaptiveDecision.kpi ?? undefined,
              },
              ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
              wrapToolOutputs: policy.wrapToolOutputs,
              strictToolNames,
            };

            // Build filtered tool defs based on discovery.
            // In degraded mode, force full toolset exposure for recovery.
            const useFilteredToolDefs =
              apiDiscoveredToolNames && adaptiveDecision.actions?.forcedToolSelectionMode !== true;
            const apiFilteredGetToolDefs = useFilteredToolDefs
              ? () => {
                const filtered = new Map<string, ToolInstance>();
                for (const [name, tool] of requestToolMap) {
                  if (apiDiscoveredToolNames!.has(name)) {
                    filtered.set(name, tool);
                  }
                }
                return buildToolDefs(filtered, { strictToolNames });
              }
              : undefined;

            reply = await runToolCallingTurn({
              providerId,
              apiKey: llmApiKey,
              model,
              messages: workingMessages,
              toolMap: requestToolMap,
              ...(apiFilteredGetToolDefs && { getToolDefs: apiFilteredGetToolDefs }),
              toolContext,
              maxRounds: 8,
              dangerouslySkipPermissions,
              strictToolNames,
              toolFailureMode: adaptiveDecision.toolFailureMode,
              ollamaOptions: buildOllamaRuntimeOptions(cfg?.ollama),
              onToolCall: () => {
                toolCallCount += 1;
              },
              askPermission: async (tool: ToolInstance, args: Record<string, unknown>) => {
                if (autoApproveToolCalls) return true;

                // Auto-approve read-only tools via HTTP API — they have no side effects
                if (tool.hasSideEffects !== true) return true;

                // Explicit auto-approval for side-effect tools is only honored
                // for loopback requests or authenticated remote requests.
                const explicitAutoApprove =
                  getHeaderString(req, 'x-auto-approve').toLowerCase() === 'true';
                if (
                  explicitAutoApprove &&
                  (isLoopbackRequest(req) || (!!chatSecret && isChatAuthorized(req, url, chatSecret)))
                ) {
                  return true;
                }

                const preview = safeJsonStringify(args, 1800);
                const effectLabel = tool.hasSideEffects === true ? 'side effects' : 'read-only';
                const actionId = `tool-${seedId}-${randomUUID()}`;
                const decision = await hitlManager.requestApproval({
                  actionId,
                  description: `Allow ${tool.name} (${effectLabel})?\n\n${preview}`,
                  severity: tool.hasSideEffects === true ? 'high' : 'low',
                  category: toAgentosApprovalCategory(tool),
                  agentId: seed.seedId,
                  context: { toolName: tool.name, args, sessionId, personaId: requestActivePersonaId },
                  reversible: tool.hasSideEffects !== true,
                  requestedAt: new Date(),
                  timeoutMs: 5 * 60_000,
                } as any);
                return decision.approved === true;
              },
              askCheckpoint: turnApprovalMode === 'off' ? undefined : async ({ round, toolCalls }: any) => {
                if (autoApproveToolCalls) return true;

                const checkpointId = `checkpoint-${seedId}-${internalSessionId}-${round}-${randomUUID()}`;
                const completedWork = toolCalls.map((c: any) => {
                  const effect = c.hasSideEffects ? 'side effects' : 'read-only';
                  const preview = safeJsonStringify(c.args, 800);
                  return `${c.toolName} (${effect})\n${preview}`;
                });

                const timeoutMs = 5 * 60_000;
                const checkpointPromise = hitlManager.checkpoint({
                  checkpointId,
                  workflowId: `chat-${internalSessionId}`,
                  currentPhase: `tool-round-${round}`,
                  progress: Math.min(1, (round + 1) / 8),
                  completedWork,
                  upcomingWork: ['Continue to next LLM round'],
                  issues: [],
                  notes: 'Continue?',
                  checkpointAt: new Date(),
                } as any).catch(() => ({ decision: 'abort' as const }));

                const timeoutPromise = new Promise<{ decision: 'abort' }>((resolve) =>
                  setTimeout(() => resolve({ decision: 'abort' }), timeoutMs),
                );

                const decision = await Promise.race([checkpointPromise, timeoutPromise]);
                if ((decision as any)?.decision !== 'continue') {
                  try {
                    await hitlManager.cancelRequest(checkpointId, 'checkpoint_timeout_or_abort');
                  } catch {
                    // ignore
                  }
                }
                return (decision as any)?.decision === 'continue';
              },
              baseUrl: llmBaseUrl,
              fallback: providerId === 'openai' ? openrouterFallback : undefined,
              onFallback: (err: any, provider: any) => {
                fallbackTriggered = true;
                console.warn(`[fallback] Primary provider failed (${err.message}), routing to ${provider}`);
              },
              getApiKey: oauthGetApiKey,
              onToolProgress: streamMode
                ? (info) => {
                    try {
                      const chunk = JSON.stringify({
                        type: 'SYSTEM_PROGRESS',
                        toolName: info.toolName,
                        phase: info.phase,
                        message: info.message,
                        progress: info.progress ?? null,
                      });
                      res.write(`event: progress\ndata: ${chunk}\n\n`);
                    } catch {
                      // Connection may have been closed — ignore
                    }
                  }
                : undefined,
            });
          } else {
            reply =
              'No LLM credentials configured. I can run, but I cannot generate real replies yet.\n\n' +
              'Set an API key in .env (OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY) or use Ollama, then retry.\n\n' +
              `You said: ${message}`;
          }
          // Turn succeeded — commit working messages back to the session.
          // This replaces the stored array so any new entries (assistant
          // replies, tool calls/responses) are persisted for continuity,
          // but only after a clean round-trip with the LLM provider.
          sessions.set(internalSessionId, workingMessages);
        } catch (error) {
          turnFailed = true;
          if (streamMode) {
            try {
              const errChunk = JSON.stringify({
                type: 'ERROR',
                error: error instanceof Error ? error.message : String(error),
              });
              res.write(`event: error\ndata: ${errChunk}\n\n`);
            } catch { /* ignore */ }
          } else {
            throw error;
          }
        } finally {
          try {
            await adaptiveRuntime.recordTurnOutcome({
              scope: {
                sessionId,
                userId: sessionId,
                personaId: requestActivePersonaId,
                tenantId: tenantId || undefined,
              },
              degraded: adaptiveDecision.degraded || fallbackTriggered,
              replyText: reply,
              didFail: turnFailed,
              toolCallCount,
            });
          } catch (error) {
            console.warn('[wunderland/start][api] failed to record adaptive outcome', error);
          }
        }

        // Strip <think>...</think> blocks from models like qwen3.
        if (typeof reply === 'string') {
          reply = reply.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
          reply = reply.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();
        }

        if (streamMode) {
          if (!turnFailed) {
            try {
              const finalChunk = JSON.stringify({
                type: 'REPLY',
                reply,
                personaId: requestActivePersonaId,
              });
              res.write(`event: reply\ndata: ${finalChunk}\n\n`);
            } catch { /* ignore */ }
          }
          res.end();
        } else {
          sendJson(res, 200, { reply, personaId: requestActivePersonaId });
        }
        return;
      }

      // ── Feed Ingestion API ─────────────────────────────────────────────────
      // Accepts structured content (embeds, text) and posts to a Discord channel.
      // Used by external scrapers (e.g., Python news bots) that don't have their
      // own Discord gateway connection.
      if (req.method === 'POST' && url.pathname === '/api/feed') {
        if (!isFeedAuthorized(req, url, feedSecret)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }

        const body = await readBody(req);
        let parsed: any;
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body.' });
          return;
        }

        const channelId = typeof parsed.channelId === 'string' ? parsed.channelId.trim() : '';
        if (!channelId) {
          sendJson(res, 400, { error: 'Missing "channelId" in JSON body.' });
          return;
        }

        const embeds = Array.isArray(parsed.embeds) ? parsed.embeds : [];
        const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
        if (embeds.length === 0 && !content) {
          sendJson(res, 400, { error: 'Provide at least one of "embeds" or "content".' });
          return;
        }

        // Find the Discord channel adapter to post through.
        const discordAdapter = adapterByPlatform.get('discord');
        if (!discordAdapter) {
          sendJson(res, 503, { error: 'Discord channel adapter not loaded. Ensure "discord" is in agent.config.json channels.' });
          return;
        }

        try {
          // Access the underlying discord.js Client via the adapter's service.
          const client = (discordAdapter as any)?.service?.getClient?.();
          if (!client) {
            sendJson(res, 503, { error: 'Discord client not available.' });
            return;
          }

          const channel = await client.channels.fetch(channelId);
          if (!channel || !('send' in channel)) {
            sendJson(res, 404, { error: `Channel ${channelId} not found or not a text channel.` });
            return;
          }

          const sendOptions: any = {};
          if (content) sendOptions.content = content;
          if (embeds.length > 0) sendOptions.embeds = embeds;
          // Forward message flags (e.g. SUPPRESS_NOTIFICATIONS = 4096).
          if (typeof parsed.flags === 'number' && parsed.flags > 0) {
            sendOptions.flags = parsed.flags;
          }

          // If a username is provided, send via webhook so the message
          // appears with a custom identity (e.g. "Wunderland News").
          const webhookUsername = typeof parsed.username === 'string' ? parsed.username.trim() : '';
          const webhookAvatar = typeof parsed.avatar_url === 'string' ? parsed.avatar_url.trim() : '';
          let msg: any;
          if (webhookUsername) {
            // Find or create a webhook for this channel.
            const textChannel = channel as any;
            let webhook: any;
            try {
              const webhooks = await textChannel.fetchWebhooks();
              webhook = webhooks.find((w: any) => w.name === 'Wunderland Feed');
              if (!webhook) {
                webhook = await textChannel.createWebhook({ name: 'Wunderland Feed' });
              }
            } catch {
              // Fallback to regular send if webhook creation fails (missing perms).
              webhook = null;
            }
            if (webhook) {
              const whOpts: any = { ...sendOptions, username: webhookUsername };
              if (webhookAvatar) whOpts.avatarURL = webhookAvatar;
              msg = await webhook.send(whOpts);
            } else {
              msg = await textChannel.send(sendOptions);
            }
          } else {
            msg = await (channel as any).send(sendOptions);
          }

          const category = typeof parsed.category === 'string' ? parsed.category : '';
          if (category) {
            console.log(`[feed] Posted to #${(channel as any).name || channelId} (${category}): ${msg?.id || 'ok'}`);
          }

          sendJson(res, 200, { ok: true, messageId: msg?.id || null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[feed] Error posting to ${channelId}:`, msg);
          sendJson(res, 500, { error: `Failed to post: ${msg}` });
        }
        return;
      }

      // Let extension-provided HTTP handlers try to handle the request (webhooks, etc).
      for (const handler of loadedHttpHandlers) {
        try {
          const handled = await handler(req, res);
          if (handled) return;
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'HTTP handler error' });
          return;
        }
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Server error' });
    }
  });

  return server;
}
