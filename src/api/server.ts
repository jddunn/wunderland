/**
 * @fileoverview High-level HTTP server API for Wunderland.
 * @module wunderland/api/server
 *
 * Programmatic counterpart to `wunderland start`:
 * - Loads extension packs (tools + channels + webhook handlers)
 * - Starts an HTTP server with /health, /chat, /hitl, /pairing
 * - Enforces permission sets + tool access profiles
 * - Provides HITL approvals + pairing allowlist UI
 *
 * Note: This module starts real network listeners and should be used in trusted
 * environments only. Keep your permission set conservative by default.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';

import { HumanInteractionManager } from '@framers/agentos';

import { SkillRegistry, resolveDefaultSkillsDirs } from '../skills/index.js';
import { resolveExtensionsByNames } from '../core/PresetExtensionResolver.js';
import { PairingManager } from '../pairing/PairingManager.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../core/index.js';
import { loadDotEnvIntoProcessUpward } from '../cli/config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../runtime/workspace.js';
import {
  runToolCallingTurn,
  safeJsonStringify,
  type LLMProviderConfig,
  type ToolInstance,
} from '../runtime/tool-calling.js';
import { createSchemaOnDemandTools } from '../cli/openai/schema-on-demand.js';
import { startWunderlandOtel, shutdownWunderlandOtel } from '../observability/otel.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
  type NormalizedRuntimePolicy,
} from '../runtime/policy.js';
import { createEnvSecretResolver } from '../cli/security/env-secrets.js';

import type { WunderlandAgentConfig, WunderlandProviderId, WunderlandWorkspace } from './types.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

function consoleLogger(): Required<LoggerLike> {
  return {
    debug: (msg, meta) => console.debug(msg, meta ?? ''),
    info: (msg, meta) => console.log(msg, meta ?? ''),
    warn: (msg, meta) => console.warn(msg, meta ?? ''),
    error: (msg, meta) => console.error(msg, meta ?? ''),
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
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

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function getHeaderString(req: import('node:http').IncomingMessage, header: string): string {
  const v = req.headers[header.toLowerCase()];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return (v[0] || '').trim();
  return '';
}

function extractHitlSecret(req: import('node:http').IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-hitl-secret');
  if (fromHeader) return fromHeader;
  const fromQuery = (url.searchParams.get('secret') || '').trim();
  return fromQuery;
}

function isHitlAuthorized(req: import('node:http').IncomingMessage, url: URL, hitlSecret: string): boolean {
  if (!hitlSecret) return true;
  return extractHitlSecret(req, url) === hitlSecret;
}

function inferTurnApprovalMode(cfg: WunderlandAgentConfig | undefined): 'off' | 'after-each-turn' | 'after-each-round' {
  const raw =
    cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl)
      ? (cfg.hitl as any).turnApprovalMode ?? (cfg.hitl as any).turnApproval
      : undefined;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'after-each-turn') return 'after-each-turn';
  if (v === 'after-each-round') return 'after-each-round';
  return 'off';
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const PAIRING_PAGE_HTML = `<!doctype html>
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
      code { color: rgba(232,236,255,0.92); }
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

const HITL_PAGE_HTML = `<!doctype html>
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

export type WunderlandServerHandle = {
  server: Server;
  url: string;
  host: string;
  port: number;
  hitlSecret: string;
  seedId: string;
  displayName: string;
  providerId: WunderlandProviderId;
  model: string;
  canUseLLM: boolean;
  toolCount: number;
  channelCount: number;
  pairingEnabled: boolean;
  policy: NormalizedRuntimePolicy;
  autoApproveToolCalls: boolean;
  turnApprovalMode: 'off' | 'after-each-turn' | 'after-each-round';
  openaiFallbackEnabled: boolean;
  close: () => Promise<void>;
};

export async function createWunderlandServer(opts?: {
  /** Path to `agent.config.json`. Default: `${process.cwd()}/agent.config.json` */
  configPath?: string;
  /** Direct config object (skips reading configPath). */
  agentConfig?: WunderlandAgentConfig;
  /** Defaults to `process.cwd()` */
  workingDirectory?: string;
  /** Load .env files into process.env (upward + global). Default: true */
  loadEnv?: boolean;
  /** Override global config dir for ~/.wunderland/.env */
  configDirOverride?: string;
  /** Defaults to `0.0.0.0` (same as CLI). */
  host?: string;
  /** Defaults to `process.env.PORT || 3777`. Use 0 for ephemeral port. */
  port?: number;
  /** Workspace location for tool execution/pairing state. */
  workspace?: Partial<WunderlandWorkspace>;
  /** Enable filesystem skills prompts. Default: true */
  enableSkills?: boolean;
  /** Force lazy-tools mode (skips eager extension loading). */
  lazyTools?: boolean;
  /** Fully autonomous approval mode (still enforces permission sets + tool access profile). */
  autoApproveToolCalls?: boolean;
  /** Bypass interactive approvals and Tier-3 gating inside tool calling. */
  dangerouslySkipPermissions?: boolean;
  /** Bypass command safety checks (implies skip approvals in CLI). */
  dangerouslySkipCommandSafety?: boolean;
  /** Override provider/model (API keys still resolved from env unless providerApiKey is provided). */
  llm?: Partial<{
    providerId: WunderlandProviderId | string;
    model: string;
    apiKey: string;
    baseUrl?: string;
  }>;
  /** Override HITL secret (otherwise config/env/random). */
  hitlSecret?: string;
  /** Optional OpenAI-compatible fallback provider config. */
  openaiFallback?: LLMProviderConfig;
  logger?: LoggerLike;
}): Promise<WunderlandServerHandle> {
  const logger = opts?.logger ?? consoleLogger();
  const workingDirectory = opts?.workingDirectory ? path.resolve(opts.workingDirectory) : process.cwd();

  if (opts?.loadEnv !== false) {
    await loadDotEnvIntoProcessUpward({ startDir: workingDirectory, configDirOverride: opts?.configDirOverride });
  }

  const configPath = opts?.configPath
    ? path.resolve(workingDirectory, opts.configPath)
    : path.resolve(workingDirectory, 'agent.config.json');

  let cfg: WunderlandAgentConfig;
  if (opts?.agentConfig) {
    cfg = opts.agentConfig;
  } else {
    if (!existsSync(configPath)) {
      throw new Error(`createWunderlandServer: missing config file: ${configPath}`);
    }
    cfg = JSON.parse(await readFile(configPath, 'utf8'));
  }

  const seedId = String(cfg.seedId || 'seed_local_agent');
  const displayName = String(cfg.displayName || 'My Agent');
  const description = String(cfg.bio || 'Autonomous Wunderbot');
  const p = cfg.personality || {};

  const policy = normalizeRuntimePolicy(cfg as any);
  const permissions = getPermissionsForSet(policy.permissionSet);
  const turnApprovalMode = inferTurnApprovalMode(cfg);

  // Observability (OTEL) is opt-in, and config can override env.
  const cfgOtelEnabled = (cfg as any)?.observability?.otel?.enabled;
  if (typeof cfgOtelEnabled === 'boolean') {
    process.env['WUNDERLAND_OTEL_ENABLED'] = cfgOtelEnabled ? 'true' : 'false';
  }
  const cfgOtelLogsEnabled = (cfg as any)?.observability?.otel?.exportLogs;
  if (typeof cfgOtelLogsEnabled === 'boolean') {
    process.env['WUNDERLAND_OTEL_LOGS_ENABLED'] = cfgOtelLogsEnabled ? 'true' : 'false';
  }

  await startWunderlandOtel({ serviceName: `wunderbot-${seedId}` });

  const security = {
    ...DEFAULT_SECURITY_PROFILE,
    enablePreLLMClassifier: (cfg as any)?.security?.preLLMClassifier ?? (cfg as any)?.security?.preLlmClassifier ?? DEFAULT_SECURITY_PROFILE.enablePreLLMClassifier,
    enableDualLLMAuditor: (cfg as any)?.security?.dualLLMAudit ?? (cfg as any)?.security?.dualLlmAuditor ?? DEFAULT_SECURITY_PROFILE.enableDualLLMAuditor,
    enableOutputSigning: (cfg as any)?.security?.outputSigning ?? DEFAULT_SECURITY_PROFILE.enableOutputSigning,
  };

  const seed = createWunderlandSeed({
    seedId,
    name: displayName,
    description,
    hexacoTraits: {
      honesty_humility: finiteNumber(p.honesty, 0.8),
      emotionality: finiteNumber(p.emotionality, 0.5),
      extraversion: finiteNumber(p.extraversion, 0.6),
      agreeableness: finiteNumber(p.agreeableness, 0.7),
      conscientiousness: finiteNumber(p.conscientiousness, 0.8),
      openness: finiteNumber(p.openness, 0.7),
    },
    baseSystemPrompt: typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : undefined,
    securityProfile: security,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });

  const providerFromConfig = typeof (cfg as any).llmProvider === 'string' ? String((cfg as any).llmProvider).trim() : '';
  const providerIdRaw = String(opts?.llm?.providerId ?? providerFromConfig ?? 'openai').trim().toLowerCase();
  const providerId = providerIdRaw as WunderlandProviderId | string;
  if (!new Set<string>(['openai', 'openrouter', 'ollama', 'anthropic']).has(providerId)) {
    throw new Error(
      `createWunderlandServer: unsupported LLM provider "${providerIdRaw}". Supported: openai, openrouter, ollama, anthropic`,
    );
  }

  const modelFromConfig = typeof (cfg as any).llmModel === 'string' ? String((cfg as any).llmModel).trim() : '';
  const model =
    typeof opts?.llm?.model === 'string' && opts.llm.model.trim()
      ? opts.llm.model.trim()
      : (modelFromConfig || (process.env['OPENAI_MODEL'] || 'gpt-4o-mini'));

  const port = Number.isFinite(opts?.port) ? Number(opts?.port) : (Number(process.env['PORT'] || '') || 3777);
  const host = typeof opts?.host === 'string' && opts.host.trim() ? opts.host.trim() : '0.0.0.0';

  const openrouterApiKey = process.env['OPENROUTER_API_KEY'] || '';
  const openrouterFallback =
    opts?.openaiFallback ??
    (openrouterApiKey
      ? ({
          apiKey: openrouterApiKey,
          model: 'auto',
          baseUrl: 'https://openrouter.ai/api/v1',
          extraHeaders: { 'HTTP-Referer': 'https://wunderland.sh', 'X-Title': 'Wunderbot' },
        } satisfies LLMProviderConfig)
      : undefined);

  const dangerouslySkipPermissions = opts?.dangerouslySkipPermissions === true;
  const dangerouslySkipCommandSafety = opts?.dangerouslySkipCommandSafety === true || dangerouslySkipPermissions;
  const autoApproveToolCalls =
    opts?.autoApproveToolCalls === true || dangerouslySkipPermissions || policy.executionMode === 'autonomous';
  const enableSkills = opts?.enableSkills !== false;
  const lazyTools = opts?.lazyTools === true || (cfg as any)?.lazyTools === true;

  const workspaceBaseDir = opts?.workspace?.baseDir ?? resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(opts?.workspace?.agentId ?? seedId);

  const llmBaseUrl =
    providerId === 'openrouter'
      ? (opts?.llm?.baseUrl ?? 'https://openrouter.ai/api/v1')
      : providerId === 'ollama'
        ? (opts?.llm?.baseUrl ?? 'http://localhost:11434/v1')
        : opts?.llm?.baseUrl;

  const llmApiKey =
    typeof opts?.llm?.apiKey === 'string'
      ? opts.llm.apiKey
      : providerId === 'openrouter'
        ? openrouterApiKey
        : providerId === 'ollama'
          ? 'ollama'
          : providerId === 'openai'
            ? (process.env['OPENAI_API_KEY'] || '')
            : providerId === 'anthropic'
              ? (process.env['ANTHROPIC_API_KEY'] || '')
              : (process.env['OPENAI_API_KEY'] || '');

  const canUseLLM =
    providerId === 'ollama'
      ? true
      : providerId === 'openrouter'
        ? !!openrouterApiKey
        : providerId === 'anthropic'
          ? !!process.env['ANTHROPIC_API_KEY']
          : !!llmApiKey || !!openrouterFallback;

  const openaiFallbackEnabled = providerId === 'openai' && !!openrouterFallback;

  const preloadedPackages: string[] = [];
  let activePacks: any[] = [];
  let allTools: ToolInstance[] = [];
  const loadedChannelAdapters: any[] = [];
  const loadedHttpHandlers: Array<
    (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean> | boolean
  > = [];

  const hitlSecret =
    typeof opts?.hitlSecret === 'string' && opts.hitlSecret.trim()
      ? opts.hitlSecret.trim()
      : (() => {
          const fromCfg =
            (cfg as any)?.hitl && typeof (cfg as any).hitl === 'object' && !Array.isArray((cfg as any).hitl)
              ? String((cfg as any).hitl.secret || '').trim()
              : '';
          const fromEnv = String(process.env['WUNDERLAND_HITL_SECRET'] || '').trim();
          return fromCfg || fromEnv || randomUUID();
        })();

  const sseClients = new Set<import('node:http').ServerResponse>();
  async function broadcastHitlUpdate(payload: Record<string, unknown>): Promise<void> {
    const data = JSON.stringify(payload);
    for (const client of Array.from(sseClients)) {
      try {
        client.write(`event: hitl\\ndata: ${data}\\n\\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  const hitlManager = new HumanInteractionManager({
    defaultTimeoutMs: 5 * 60_000,
    autoRejectOnTimeout: true,
    notificationHandler: async (notification) => {
      await broadcastHitlUpdate({ type: 'notification', notification });
    },
  });

  if (!lazyTools) {
    const extensionsFromConfig = (cfg as any).extensions;
    let toolExtensions: string[] = [];
    let voiceExtensions: string[] = [];
    let productivityExtensions: string[] = [];

    if (extensionsFromConfig) {
      toolExtensions = extensionsFromConfig.tools || [];
      voiceExtensions = extensionsFromConfig.voice || [];
      productivityExtensions = extensionsFromConfig.productivity || [];
    } else {
      toolExtensions = ['cli-executor', 'web-search', 'web-browser', 'giphy', 'image-search', 'news-search'];
      voiceExtensions = ['voice-synthesis'];
      productivityExtensions = [];
    }

    try {
      const configOverrides =
        (cfg as any)?.extensionOverrides && typeof (cfg as any).extensionOverrides === 'object' && !Array.isArray((cfg as any).extensionOverrides)
          ? (cfg as any).extensionOverrides
          : {};

      const runtimeOverrides: Record<string, any> = {
        'cli-executor': {
          options: {
            filesystem: { allowRead: permissions.filesystem.read, allowWrite: permissions.filesystem.write },
            agentWorkspace: {
              agentId: workspaceAgentId,
              baseDir: workspaceBaseDir,
              createIfMissing: true,
              subdirs: ['assets', 'exports', 'tmp'],
            },
            dangerouslySkipSecurityChecks: dangerouslySkipCommandSafety,
          },
        },
        'web-search': {
          options: {
            serperApiKey: process.env['SERPER_API_KEY'],
            serpApiKey: process.env['SERPAPI_API_KEY'],
            braveApiKey: process.env['BRAVE_API_KEY'],
          },
        },
        'web-browser': {
          options: {
            headless: true,
            executablePath:
              process.env['PUPPETEER_EXECUTABLE_PATH'] ||
              process.env['CHROME_EXECUTABLE_PATH'] ||
              process.env['CHROME_PATH'],
          },
        },
        giphy: { options: { giphyApiKey: process.env['GIPHY_API_KEY'] } },
        'image-search': {
          options: {
            pexelsApiKey: process.env['PEXELS_API_KEY'],
            unsplashApiKey: process.env['UNSPLASH_ACCESS_KEY'],
            pixabayApiKey: process.env['PIXABAY_API_KEY'],
          },
        },
        'voice-synthesis': { options: { elevenLabsApiKey: process.env['ELEVENLABS_API_KEY'] } },
        'news-search': { options: { newsApiKey: process.env['NEWSAPI_API_KEY'] } },
      };

      function mergeOverride(base: any, extra: any): any {
        const out = { ...(base || {}), ...(extra || {}) };
        if ((base && base.options) || (extra && extra.options)) {
          out.options = { ...(base?.options || {}), ...(extra?.options || {}) };
        }
        return out;
      }

      const mergedOverrides: Record<string, any> = { ...configOverrides };
      for (const [name, override] of Object.entries(runtimeOverrides)) {
        mergedOverrides[name] = mergeOverride(configOverrides[name], override);
      }

      const cfgSecrets =
        (cfg as any)?.secrets && typeof (cfg as any).secrets === 'object' && !Array.isArray((cfg as any).secrets)
          ? ((cfg as any).secrets as Record<string, string>)
          : undefined;
      const getSecret = createEnvSecretResolver({ configSecrets: cfgSecrets });

      const secrets = new Proxy<Record<string, string>>({} as any, {
        get: (_target, prop) => (typeof prop === 'string' ? getSecret(prop) : undefined),
      });

      const channelsFromConfig = Array.isArray((cfg as any)?.channels)
        ? ((cfg as any).channels as unknown[])
        : Array.isArray((cfg as any)?.suggestedChannels)
          ? ((cfg as any).suggestedChannels as unknown[])
          : [];
      const channelsToLoad = Array.from(
        new Set(channelsFromConfig.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0)),
      );

      const CLI_REQUIRED_CHANNELS = new Set<string>(['signal', 'zalouser']);
      const allowedChannels =
        permissions.network.externalApis === true
          ? channelsToLoad.filter((platform) => !CLI_REQUIRED_CHANNELS.has(platform) || permissions.system.cliExecution === true)
          : [];

      const resolved = await resolveExtensionsByNames(
        toolExtensions,
        voiceExtensions,
        productivityExtensions,
        mergedOverrides,
        { secrets: secrets as any, channels: allowedChannels.length > 0 ? allowedChannels : 'none' },
      );

      const packs: any[] = [];

      for (const packEntry of (resolved as any).manifest.packs as any[]) {
        try {
          if ((packEntry as any)?.enabled === false) continue;

          if (typeof (packEntry as any)?.factory === 'function') {
            const pack = await (packEntry as any).factory();
            if (pack) {
              packs.push(pack);
              if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
            }
            continue;
          }

          let packageName: string | undefined;
          if ('package' in (packEntry as any)) packageName = (packEntry as any).package as string;
          else if ('module' in (packEntry as any)) packageName = (packEntry as any).module as string;
          if (!packageName) continue;

          const extModule = await import(packageName);
          const factory = (extModule as any).createExtensionPack ?? (extModule as any).default?.createExtensionPack ?? (extModule as any).default;
          if (typeof factory !== 'function') continue;

          const options: any = (packEntry as any).options || {};
          const pack = await factory({ options, logger: console, getSecret });
          packs.push(pack);
          if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
        } catch (err) {
          logger.warn?.('[wunderland/api] Failed to load extension pack', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Optional skills extension (may not be installed)
      try {
        const skillsPkg = '@framers/agentos-ext-skills';
        const skillsExt = await import(/* webpackIgnore: true */ skillsPkg);
        if ((skillsExt as any)?.createExtensionPack) {
          packs.push((skillsExt as any).createExtensionPack({ options: {}, logger: console, getSecret }));
          preloadedPackages.push(skillsPkg);
        }
      } catch {
        // optional
      }

      // Activate all packs
      await Promise.all(
        packs
          .map((p2) => (typeof (p2 as any)?.onActivate === 'function' ? (p2 as any).onActivate({ logger: console, getSecret }) : null))
          .filter(Boolean),
      );

      activePacks = packs;

      const adapters = packs
        .flatMap((p2) => ((p2 as any)?.descriptors || []) as any[])
        .filter((d) => d?.kind === 'messaging-channel')
        .map((d) => d.payload)
        .filter(Boolean);
      loadedChannelAdapters.push(...adapters);

      const httpHandlers = packs
        .flatMap((p2) => ((p2 as any)?.descriptors || []) as any[])
        .filter((d) => d?.kind === 'http-handler')
        .map((d) => d.payload)
        .filter(Boolean);
      loadedHttpHandlers.push(...httpHandlers);

      allTools = packs
        .flatMap((p2) => ((p2 as any)?.descriptors || []) as any[])
        .filter((d) => d?.kind === 'tool')
        .map((d) => d.payload)
        .filter(Boolean);
    } catch (err) {
      logger.warn?.('[wunderland/api] Extension loading failed, using empty toolset', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const toolMap = new Map<string, ToolInstance>();
  for (const tool of allTools) {
    if (!tool?.name) continue;
    toolMap.set(tool.name, tool);
  }

  for (const meta of createSchemaOnDemandTools({
    toolMap,
    runtimeDefaults: {
      workingDirectory,
      headlessBrowser: true,
      dangerouslySkipCommandSafety,
      agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    },
    initialEnabledPackages: preloadedPackages,
    allowPackages: true,
    logger: console,
  })) {
    toolMap.set((meta as any).name, meta as any);
  }

  const filtered = filterToolMapByPolicy({
    toolMap,
    toolAccessProfile: policy.toolAccessProfile,
    permissions,
  });
  toolMap.clear();
  for (const [k, v] of filtered.toolMap.entries()) toolMap.set(k, v);

  let skillsPrompt = '';
  if (enableSkills) {
    const parts: string[] = [];
    const skillRegistry = new SkillRegistry();
    const dirs = resolveDefaultSkillsDirs({ cwd: workingDirectory });
    if (dirs.length > 0) {
      await skillRegistry.loadFromDirs(dirs);
      const snapshot = skillRegistry.buildSnapshot({ platform: process.platform, strict: true });
      if (snapshot.prompt) parts.push(snapshot.prompt);
    }

    if (Array.isArray((cfg as any).skills) && (cfg as any).skills.length > 0) {
      try {
        const { resolveSkillsByNames } = await import('../core/PresetSkillResolver.js');
        const presetSnapshot = await (resolveSkillsByNames as any)((cfg as any).skills);
        if (presetSnapshot?.prompt) parts.push(presetSnapshot.prompt);
      } catch {
        // optional
      }
    }

    skillsPrompt = parts.filter(Boolean).join('\n\n');
  }

  const systemPrompt = [
    typeof (seed as any).baseSystemPrompt === 'string' ? (seed as any).baseSystemPrompt : String((seed as any).baseSystemPrompt),
    'You are a local Wunderbot server.',
    'If you are replying to an inbound channel message, respond with plain text. The runtime will deliver your final answer back to the same conversation. Do not call channel send tools unless you explicitly need to message a different conversation/channel.',
    lazyTools
      ? 'Use extensions_list + extensions_enable to load tools on demand (schema-on-demand).'
      : 'Tools are preloaded, and you can also use extensions_enable to load additional packs on demand.',
    `Execution mode: ${policy.executionMode}. Permission set: ${policy.permissionSet}. Tool access profile: ${policy.toolAccessProfile}.`,
    autoApproveToolCalls
      ? 'All tool calls are auto-approved (fully autonomous mode).'
      : 'Tool calls that have side effects may require operator approval (HITL).',
    turnApprovalMode !== 'off' ? `Turn checkpoints: ${turnApprovalMode}.` : '',
    skillsPrompt || '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const sessions = new Map<string, Array<Record<string, unknown>>>();
  const channelSessions = new Map<string, Array<Record<string, unknown>>>();
  const channelQueues = new Map<string, Promise<void>>();
  const channelUnsubs: Array<() => void> = [];

  const pairingEnabled = (cfg as any)?.pairing?.enabled !== false;
  const pairingGroupTrigger = (() => {
    const raw = (cfg as any)?.pairing?.groupTrigger;
    if (typeof raw === 'string') return raw.trim();
    return '!pair';
  })();
  const pairingGroupTriggerEnabled =
    pairingEnabled && !!pairingGroupTrigger && pairingGroupTrigger.toLowerCase() !== 'off';

  const pairing = new PairingManager({
    storeDir: path.join(workspaceBaseDir, workspaceAgentId, 'pairing'),
    pendingTtlMs: Number.isFinite((cfg as any)?.pairing?.pendingTtlMs) ? (cfg as any).pairing.pendingTtlMs : undefined,
    maxPending: Number.isFinite((cfg as any)?.pairing?.maxPending) ? (cfg as any).pairing.maxPending : undefined,
    codeLength: Number.isFinite((cfg as any)?.pairing?.codeLength) ? (cfg as any).pairing.codeLength : undefined,
  });

  function toAgentosApprovalCategory(
    tool: ToolInstance,
  ): 'data_modification' | 'external_api' | 'financial' | 'communication' | 'system' | 'other' {
    const name = String(tool?.name || '').toLowerCase();
    if (
      name.startsWith('file_') ||
      name.includes('shell_') ||
      name.includes('run_command') ||
      name.includes('exec')
    ) {
      return 'system';
    }
    if (name.startsWith('browser_') || name.includes('web_')) return 'external_api';
    const cat = String((tool as any)?.category || '').toLowerCase();
    if (cat.includes('financial')) return 'financial';
    if (cat.includes('communication')) return 'communication';
    if (cat.includes('external') || cat.includes('api') || cat === 'research' || cat === 'search') return 'external_api';
    if (cat.includes('data')) return 'data_modification';
    if (cat.includes('system') || cat.includes('filesystem')) return 'system';
    return 'other';
  }

  // ── Channel Runtime (inbound/outbound) ────────────────────────────────────

  const LOCAL_ONLY_CHANNELS = new Set<string>(['webchat']);
  const CLI_REQUIRED_CHANNELS = new Set<string>(['signal', 'zalouser']);

  const adapterByPlatform = new Map<string, any>();
  for (const adapter of loadedChannelAdapters) {
    const platform = (adapter as any)?.platform;
    if (typeof platform !== 'string' || !platform.trim()) continue;
    if (!adapterByPlatform.has(platform)) adapterByPlatform.set(platform, adapter);
  }

  function enqueueChannelTurn(key: string, fn: () => Promise<void>): void {
    const prev = channelQueues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(fn)
      .catch((err) => {
        logger.warn?.('[wunderland/api][channels] turn failed', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (channelQueues.get(key) === next) channelQueues.delete(key);
      });
    channelQueues.set(key, next);
  }

  function chunkText(text: string, maxLen = 1800): string[] {
    const t = String(text ?? '');
    if (t.length <= maxLen) return [t];
    const chunks: string[] = [];
    let i = 0;
    while (i < t.length) {
      chunks.push(t.slice(i, i + maxLen));
      i += maxLen;
    }
    return chunks;
  }

  function getSenderLabel(m: any): string {
    const d = m?.sender && typeof m.sender === 'object' ? m.sender : {};
    const display = typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : '';
    const user = typeof d.username === 'string' && d.username.trim() ? d.username.trim() : '';
    return display || (user ? `@${user}` : '') || String(d.id || 'unknown');
  }

  function isChannelAllowedByPolicy(platform: string): boolean {
    if (LOCAL_ONLY_CHANNELS.has(platform)) return true;
    if (permissions.network.externalApis !== true) return false;
    if (CLI_REQUIRED_CHANNELS.has(platform) && permissions.system.cliExecution !== true) return false;
    return true;
  }

  async function sendChannelText(sendOpts: {
    platform: string;
    conversationId: string;
    text: string;
    replyToMessageId?: string;
  }): Promise<void> {
    if (!isChannelAllowedByPolicy(sendOpts.platform)) return;
    const adapter = adapterByPlatform.get(sendOpts.platform);
    if (!adapter) return;
    const parts = chunkText(sendOpts.text, 1800).filter((p2) => p2.trim().length > 0);
    for (const part of parts) {
      await (adapter as any).sendMessage(sendOpts.conversationId, {
        blocks: [{ type: 'text', text: part }],
        ...(sendOpts.replyToMessageId ? { replyToMessageId: sendOpts.replyToMessageId } : null),
      });
    }
  }

  async function handleInboundChannelMessage(message: any): Promise<void> {
    const platform = String(message?.platform || '').trim();
    const conversationId = String(message?.conversationId || '').trim();
    if (!platform || !conversationId) return;
    const text = String(message?.text || '').trim();
    if (!text) return;

    const senderId = String(message?.sender?.id || '').trim() || 'unknown';

    const isGroupPairingRequest = (() => {
      if (!pairingGroupTriggerEnabled) return false;
      if (message?.conversationType === 'direct') return false;
      const t = text.trim();
      if (!t) return false;
      const trig = pairingGroupTrigger;
      const lowerT = t.toLowerCase();
      const lowerTrig = trig.toLowerCase();
      if (lowerT === lowerTrig) return true;
      if (lowerT.startsWith(`${lowerTrig} `)) return true;
      return false;
    })();

    if (pairingEnabled) {
      const isAllowed = await pairing.isAllowed(platform as any, senderId);
      if (!isAllowed) {
        if (message?.conversationType !== 'direct' && !isGroupPairingRequest) {
          return;
        }

        const meta = { sender: getSenderLabel(message), platform, conversationId };
        const { code, created } = await pairing.upsertRequest(platform as any, senderId, meta);
        if (created) {
          void broadcastHitlUpdate({ type: 'pairing_request', platform, senderId, conversationId });
        }

        const prompt =
          code && code.trim()
            ? (isGroupPairingRequest
                ? `Pairing requested.\\n\\nCode: ${code}\\n\\nAsk the assistant owner to approve this code.`
                : `Pairing required.\\n\\nCode: ${code}\\n\\nAsk the assistant owner to approve this code, then retry.`)
            : 'Pairing queue is full. Ask the assistant owner to clear/approve pending requests, then retry.';

        await sendChannelText({ platform, conversationId, text: prompt, replyToMessageId: message?.messageId });
        return;
      }
    }

    const sessionKey = `${platform}:${conversationId}`;
    let messages = channelSessions.get(sessionKey);
    if (!messages) {
      messages = [{ role: 'system', content: systemPrompt }];
      channelSessions.set(sessionKey, messages);
    }

    if (messages.length > 200) {
      messages = [messages[0], ...messages.slice(-120)];
      channelSessions.set(sessionKey, messages);
    }

    const userPrefix = message?.conversationType === 'direct' ? '' : `[${getSenderLabel(message)}] `;
    messages.push({ role: 'user', content: `${userPrefix}${text}` });

    try {
      const adapter = adapterByPlatform.get(platform);
      if (adapter) await (adapter as any).sendTypingIndicator?.(conversationId, true);
    } catch {
      // ignore
    }

    let reply = '';
    try {
      if (canUseLLM) {
        const toolContext: Record<string, unknown> = {
          gmiId: `wunderland-channel-${sessionKey}`,
          personaId: seed.seedId,
          userContext: { userId: senderId, platform, conversationId },
          agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
          permissionSet: policy.permissionSet,
          securityTier: policy.securityTier,
          executionMode: policy.executionMode,
          toolAccessProfile: policy.toolAccessProfile,
          interactiveSession: false,
          turnApprovalMode,
          ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
          wrapToolOutputs: policy.wrapToolOutputs,
        };

        reply = await runToolCallingTurn({
          providerId,
          apiKey: llmApiKey,
          model,
          messages,
          toolMap,
          toolContext,
          maxRounds: 8,
          dangerouslySkipPermissions: autoApproveToolCalls,
          askPermission: async (tool, args) => {
            if (autoApproveToolCalls) return true;
            const preview = safeJsonStringify(args, 1800);
            const effectLabel = tool.hasSideEffects === true ? 'side effects' : 'read-only';
            const actionId = `tool-${seedId}-${randomUUID()}`;
            const decision = await hitlManager.requestApproval({
              actionId,
              description: `Allow ${tool.name} (${effectLabel})?\\n\\n${preview}`,
              severity: tool.hasSideEffects === true ? 'high' : 'low',
              category: toAgentosApprovalCategory(tool),
              agentId: seed.seedId,
              context: { toolName: tool.name, args, sessionId: sessionKey, platform, conversationId },
              reversible: tool.hasSideEffects !== true,
              requestedAt: new Date(),
              timeoutMs: 5 * 60_000,
            });
            return decision.approved === true;
          },
          askCheckpoint:
            turnApprovalMode === 'off'
              ? undefined
              : async ({ round, toolCalls }) => {
                  if (autoApproveToolCalls) return true;
                  const checkpointId = `checkpoint-${seedId}-${sessionKey}-${round}-${randomUUID()}`;
                  const completedWork = toolCalls.map((c) => {
                    const effect = c.hasSideEffects ? 'side effects' : 'read-only';
                    const preview = safeJsonStringify(c.args, 800);
                    return `${c.toolName} (${effect})\\n${preview}`;
                  });
                  const timeoutMs = 5 * 60_000;
                  const checkpointPromise = hitlManager
                    .checkpoint({
                      checkpointId,
                      workflowId: `channel-${sessionKey}`,
                      currentPhase: `tool-round-${round}`,
                      progress: Math.min(1, (round + 1) / 8),
                      completedWork,
                      upcomingWork: ['Continue to next LLM round'],
                      issues: [],
                      notes: 'Continue?',
                      checkpointAt: new Date(),
                    })
                    .catch(() => ({ decision: 'abort' as const }));
                  const timeoutPromise = new Promise<{ decision: 'abort' }>((resolve) =>
                    setTimeout(() => resolve({ decision: 'abort' }), timeoutMs),
                  );
                  const decision = (await Promise.race([checkpointPromise, timeoutPromise])) as any;
                  if (decision?.decision !== 'continue') {
                    try {
                      await hitlManager.cancelRequest(checkpointId, 'checkpoint_timeout_or_abort');
                    } catch {
                      // ignore
                    }
                  }
                  return decision?.decision === 'continue';
                },
          baseUrl: llmBaseUrl,
          fallback: providerId === 'openai' ? openrouterFallback : undefined,
          onFallback: (err, provider) => {
            logger.warn?.('[wunderland/api] fallback activated', { error: err.message, provider });
          },
        });
      } else {
        reply = `No LLM credentials configured. You said: ${text}`;
        messages.push({ role: 'assistant', content: reply });
      }
    } finally {
      try {
        const adapter = adapterByPlatform.get(platform);
        if (adapter) await (adapter as any).sendTypingIndicator?.(conversationId, false);
      } catch {
        // ignore
      }
    }

    if (typeof reply === 'string' && reply.trim()) {
      await sendChannelText({ platform, conversationId, text: reply.trim(), replyToMessageId: message?.messageId });
    }
  }

  if (adapterByPlatform.size > 0) {
    for (const [platform, adapter] of adapterByPlatform.entries()) {
      if (!isChannelAllowedByPolicy(platform)) continue;
      try {
        const unsub = (adapter as any).on(
          async (event: any) => {
            if (!event || event.type !== 'message') return;
            const data = event.data;
            if (!data) return;
            const key = `${platform}:${String(data.conversationId || '').trim()}`;
            enqueueChannelTurn(key, async () => {
              await handleInboundChannelMessage(data);
            });
          },
          ['message'],
        );
        channelUnsubs.push(unsub);
      } catch (err) {
        logger.warn?.('[wunderland/api][channels] subscribe failed', {
          platform,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Wunderland-HITL-Secret');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname.startsWith('/pairing')) {
        if (req.method === 'GET' && url.pathname === '/pairing') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(PAIRING_PAGE_HTML);
          return;
        }

        if (!isHitlAuthorized(req, url, hitlSecret)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }

        const channels = Array.from(adapterByPlatform.keys());

        if (req.method === 'GET' && url.pathname === '/pairing/requests') {
          const requestsByChannel: Record<string, unknown> = {};
          for (const channel of channels) {
            try {
              (requestsByChannel as any)[channel] = await pairing.listRequests(channel as any);
            } catch {
              (requestsByChannel as any)[channel] = [];
            }
          }
          sendJson(res, 200, { pairingEnabled, channels, requestsByChannel });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/pairing/allowlist') {
          const allowlistByChannel: Record<string, unknown> = {};
          for (const channel of channels) {
            try {
              (allowlistByChannel as any)[channel] = await pairing.readAllowlist(channel as any);
            } catch {
              (allowlistByChannel as any)[channel] = [];
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
          const result = await pairing.approveCode(channel as any, code);
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
          const ok = await pairing.rejectCode(channel as any, code);
          void broadcastHitlUpdate({ type: 'pairing_rejected', channel, code });
          sendJson(res, 200, { ok });
          return;
        }

        sendJson(res, 404, { error: 'Not Found' });
        return;
      }

      if (url.pathname.startsWith('/hitl')) {
        if (req.method === 'GET' && url.pathname === '/hitl') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(HITL_PAGE_HTML);
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
            Connection: 'keep-alive',
          });
          res.write('event: ready\\ndata: {}\\n\\n');
          sseClients.add(res);

          try {
            const pending = await hitlManager.getPendingRequests();
            res.write(`event: hitl\\ndata: ${JSON.stringify({ type: 'snapshot', pending })}\\n\\n`);
          } catch {
            // ignore
          }

          const ping = setInterval(() => {
            try {
              res.write(`event: ping\\ndata: ${Date.now()}\\n\\n`);
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
          const decidedBy =
            typeof parsed?.decidedBy === 'string' && parsed.decidedBy.trim() ? parsed.decidedBy.trim() : 'operator';
          const rejectionReason = typeof parsed?.reason === 'string' ? parsed.reason : undefined;

          await hitlManager.submitApprovalDecision({
            actionId,
            approved: action === 'approve',
            decidedBy,
            decidedAt: new Date(),
            ...(action === 'reject' && rejectionReason ? { rejectionReason } : null),
          });

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
          const decidedBy =
            typeof parsed?.decidedBy === 'string' && parsed.decidedBy.trim() ? parsed.decidedBy.trim() : 'operator';
          const instructions = typeof parsed?.instructions === 'string' ? parsed.instructions : undefined;

          await hitlManager.submitCheckpointDecision({
            checkpointId,
            decision: action as any,
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
        sendJson(res, 200, { ok: true, seedId, name: displayName });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = await readBody(req);
        const parsed = JSON.parse(body || '{}');
        const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        if (!message) {
          sendJson(res, 400, { error: 'Missing "message" in JSON body.' });
          return;
        }

        let reply: string;
        if (canUseLLM) {
          const sessionId =
            typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId.trim().slice(0, 128) : 'default';

          if (parsed.reset === true) {
            sessions.delete(sessionId);
          }

          let messages = sessions.get(sessionId);
          if (!messages) {
            messages = [{ role: 'system', content: systemPrompt }];
            sessions.set(sessionId, messages);
          }

          if (messages.length > 200) {
            messages = [messages[0], ...messages.slice(-120)];
            sessions.set(sessionId, messages);
          }

          messages.push({ role: 'user', content: message });

          const toolContext: Record<string, unknown> = {
            gmiId: `wunderland-server-${sessionId}`,
            personaId: seed.seedId,
            userContext: { userId: sessionId },
            agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
            permissionSet: policy.permissionSet,
            securityTier: policy.securityTier,
            executionMode: policy.executionMode,
            toolAccessProfile: policy.toolAccessProfile,
            interactiveSession: false,
            turnApprovalMode,
            ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
            wrapToolOutputs: policy.wrapToolOutputs,
          };

          reply = await runToolCallingTurn({
            providerId,
            apiKey: llmApiKey,
            model,
            messages,
            toolMap,
            toolContext,
            maxRounds: 8,
            dangerouslySkipPermissions: autoApproveToolCalls,
            askPermission: async (tool, args) => {
              if (autoApproveToolCalls) return true;
              const preview = safeJsonStringify(args, 1800);
              const effectLabel = tool.hasSideEffects === true ? 'side effects' : 'read-only';
              const actionId = `tool-${seedId}-${randomUUID()}`;
              const decision = await hitlManager.requestApproval({
                actionId,
                description: `Allow ${tool.name} (${effectLabel})?\\n\\n${preview}`,
                severity: tool.hasSideEffects === true ? 'high' : 'low',
                category: toAgentosApprovalCategory(tool),
                agentId: seed.seedId,
                context: { toolName: tool.name, args, sessionId },
                reversible: tool.hasSideEffects !== true,
                requestedAt: new Date(),
                timeoutMs: 5 * 60_000,
              });
              return decision.approved === true;
            },
            askCheckpoint:
              turnApprovalMode === 'off'
                ? undefined
                : async ({ round, toolCalls }) => {
                    if (autoApproveToolCalls) return true;
                    const checkpointId = `checkpoint-${seedId}-${sessionId}-${round}-${randomUUID()}`;
                    const completedWork = toolCalls.map((c) => {
                      const effect = c.hasSideEffects ? 'side effects' : 'read-only';
                      const preview = safeJsonStringify(c.args, 800);
                      return `${c.toolName} (${effect})\\n${preview}`;
                    });
                    const timeoutMs = 5 * 60_000;
                    const checkpointPromise = hitlManager
                      .checkpoint({
                        checkpointId,
                        workflowId: `chat-${sessionId}`,
                        currentPhase: `tool-round-${round}`,
                        progress: Math.min(1, (round + 1) / 8),
                        completedWork,
                        upcomingWork: ['Continue to next LLM round'],
                        issues: [],
                        notes: 'Continue?',
                        checkpointAt: new Date(),
                      })
                      .catch(() => ({ decision: 'abort' as const }));
                    const timeoutPromise = new Promise<{ decision: 'abort' }>((resolve) =>
                      setTimeout(() => resolve({ decision: 'abort' }), timeoutMs),
                    );
                    const decision = (await Promise.race([checkpointPromise, timeoutPromise])) as any;
                    if (decision?.decision !== 'continue') {
                      try {
                        await hitlManager.cancelRequest(checkpointId, 'checkpoint_timeout_or_abort');
                      } catch {
                        // ignore
                      }
                    }
                    return decision?.decision === 'continue';
                  },
            baseUrl: llmBaseUrl,
            fallback: providerId === 'openai' ? openrouterFallback : undefined,
            onFallback: (err, provider) => {
              logger.warn?.('[wunderland/api] fallback activated', { error: err.message, provider });
            },
          });
        } else {
          reply =
            'No LLM credentials configured. I can run, but I cannot generate real replies yet.\\n\\n' +
            'Set an API key in .env (OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY) or use Ollama, then retry.\\n\\n' +
            `You said: ${message}`;
        }

        sendJson(res, 200, { reply });
        return;
      }

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

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address && 'port' in address ? Number((address as any).port) : port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;

  const close = async () => {
    for (const unsub of channelUnsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }

    await Promise.allSettled(
      (activePacks || [])
        .map((p2) => (typeof (p2 as any)?.onDeactivate === 'function' ? (p2 as any).onDeactivate({ logger: console }) : null))
        .filter(Boolean),
    );

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    await shutdownWunderlandOtel();
  };

  logger.info?.('[wunderland/api] server started', {
    url,
    seedId,
    toolCount: toolMap.size,
    channelCount: adapterByPlatform.size,
    pairingEnabled,
  });

  return {
    server,
    url,
    host,
    port: actualPort,
    hitlSecret,
    seedId,
    displayName,
    providerId: providerId as WunderlandProviderId,
    model,
    canUseLLM,
    toolCount: toolMap.size,
    channelCount: adapterByPlatform.size,
    pairingEnabled,
    policy,
    autoApproveToolCalls,
    turnApprovalMode,
    openaiFallbackEnabled,
    close,
  };
}
