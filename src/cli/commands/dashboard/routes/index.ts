// @ts-nocheck
/**
 * @fileoverview Route dispatcher for the multi-agent dashboard server.
 * @module wunderland/cli/commands/dashboard/routes
 *
 * Maps incoming requests to handlers:
 *  - `GET  /`                          — Serve the hub SPA HTML
 *  - `GET  /api/agents`                — List all agents with health info
 *  - `POST /api/agents/:seedId/start`  — Start an agent daemon
 *  - `POST /api/agents/:seedId/stop`   — Stop an agent daemon
 *  - `POST /api/spawn`                 — Create + start agent from NL description
 *  - `GET  /api/agents/:seedId/logs`   — Last 200 lines of agent stdout log
 *  - `GET  /health`                    — Dashboard server health check
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
// os module available if needed for future hostname/tmpdir usage

import { HUB_PAGE_HTML } from './hub-html.js';
import type { DashboardDeps } from './types.js';
import {
  readAllDaemons,
  isDaemonAlive,
  removeDaemonInfo,
  cleanStaleDaemons,
  fetchDaemonHealth,
  getDaemonDir,
} from '../../../daemon/daemon-state.js';
import { readAgentHistory } from '../../../config/agent-history.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Read the full request body (up to 1 MB) as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > 1_000_000) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Send a JSON response with the given status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Check whether the request carries a valid admin secret (query or header). */
function isAuthorized(req: IncomingMessage, url: URL, adminSecret: string): boolean {
  if (!adminSecret) return true;
  const fromQuery = (url.searchParams.get('secret') || '').trim();
  if (fromQuery === adminSecret) return true;
  const fromHeader = req.headers['x-wunderland-secret'];
  const headerVal = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  return (headerVal || '').trim() === adminSecret;
}

/** Extract seedId from URL like /api/agents/:seedId/action. */
function extractSeedId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/agents\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Scan current directory + subdirectories for agent.config.json files. */
async function scanLocalAgents(): Promise<Array<{ configPath: string; seedId: string; displayName: string }>> {
  const results: Array<{ configPath: string; seedId: string; displayName: string }> = [];

  const cwdConfig = path.join(process.cwd(), 'agent.config.json');
  if (existsSync(cwdConfig)) {
    const cfg = await tryParseConfig(cwdConfig);
    if (cfg) results.push({ configPath: cwdConfig, seedId: cfg.seedId, displayName: cfg.displayName });
  }

  try {
    const entries = await readdir(process.cwd(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const subConfig = path.join(process.cwd(), entry.name, 'agent.config.json');
      if (existsSync(subConfig)) {
        const cfg = await tryParseConfig(subConfig);
        if (cfg) results.push({ configPath: subConfig, seedId: cfg.seedId, displayName: cfg.displayName });
      }
    }
  } catch { /* skip unreadable directories */ }

  return results;
}

/** Try to parse an agent.config.json file. */
async function tryParseConfig(configPath: string): Promise<{ seedId: string; displayName: string } | null> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    return {
      seedId: cfg.seedId || 'unknown',
      displayName: cfg.displayName || cfg.agentName || path.basename(path.dirname(configPath)),
    };
  } catch {
    return null;
  }
}

// ── Route dispatcher ──────────────────────────────────────────────────────

/**
 * Handle all routes for the multi-agent dashboard.
 * Returns `true` when a route was matched and handled.
 */
export async function dispatchDashboardRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DashboardDeps,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method || 'GET';

  /* ── GET / — Serve hub HTML ──────────────────────────────────────────── */
  if (method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HUB_PAGE_HTML);
    return true;
  }

  /* ── GET /health — Dashboard server health ───────────────────────────── */
  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'wunderland-hub',
      port: deps.port,
      startedAt: deps.startedAt,
      uptime: Date.now() - new Date(deps.startedAt).getTime(),
    });
    return true;
  }

  /* ── All /api/* routes require auth ──────────────────────────────────── */
  if (pathname.startsWith('/api/')) {
    if (!isAuthorized(req, url, deps.adminSecret)) {
      sendJson(res, 401, { error: 'Unauthorized — invalid or missing admin secret' });
      return true;
    }

    /* ── GET /api/agents — List all agents with health info ────────────── */
    if (method === 'GET' && pathname === '/api/agents') {
      return await handleListAgents(res, deps);
    }

    /* ── POST /api/agents/:seedId/start ────────────────────────────────── */
    if (method === 'POST' && pathname.match(/^\/api\/agents\/[^/]+\/start$/)) {
      const seedId = extractSeedId(pathname);
      if (!seedId) { sendJson(res, 400, { error: 'Missing seedId' }); return true; }
      return await handleStartAgent(res, seedId, deps);
    }

    /* ── POST /api/agents/:seedId/stop ─────────────────────────────────── */
    if (method === 'POST' && pathname.match(/^\/api\/agents\/[^/]+\/stop$/)) {
      const seedId = extractSeedId(pathname);
      if (!seedId) { sendJson(res, 400, { error: 'Missing seedId' }); return true; }
      return await handleStopAgent(res, seedId);
    }

    /* ── POST /api/spawn ───────────────────────────────────────────────── */
    if (method === 'POST' && pathname === '/api/spawn') {
      return await handleSpawn(req, res, deps);
    }

    /* ── GET /api/agents/:seedId/logs ──────────────────────────────────── */
    if (method === 'GET' && pathname.match(/^\/api\/agents\/[^/]+\/logs$/)) {
      const seedId = extractSeedId(pathname);
      if (!seedId) { sendJson(res, 400, { error: 'Missing seedId' }); return true; }
      return await handleLogs(res, seedId);
    }

    /* Unmatched API route */
    sendJson(res, 404, { error: 'Not Found' });
    return true;
  }

  return false;
}

// ── Route handlers ────────────────────────────────────────────────────────

/**
 * List all known agents — running daemons, local directory scan, and history.
 * Enriches running agents with /health data (uptime, memory, tools, channels).
 */
async function handleListAgents(
  res: ServerResponse,
  _deps: DashboardDeps,
): Promise<boolean> {
  await cleanStaleDaemons();

  const daemons = await readAllDaemons();
  const aliveDaemons = daemons.filter((d) => isDaemonAlive(d.pid));
  const history = readAgentHistory();
  const localAgents = await scanLocalAgents();

  /** Deduplicated agent map, keyed by resolved config path. */
  const seen = new Map<string, any>();

  /* Running daemons (highest priority) — enrich with /health */
  for (const d of aliveDaemons) {
    const resolved = path.resolve(d.configPath);
    const health = await fetchDaemonHealth(d.port, 2000);

    seen.set(resolved, {
      name: health.data?.name || d.displayName,
      seedId: d.seedId,
      status: 'running',
      port: d.port,
      pid: d.pid,
      configPath: resolved,
      startedAt: d.startedAt,
      uptime: health.data?.uptime ?? (Date.now() - new Date(d.startedAt).getTime()),
      memory: health.data?.memory ?? null,
      tools: health.data?.tools ?? null,
      channels: health.data?.channels ?? null,
    });
  }

  /* Local directory scan */
  for (const local of localAgents) {
    const resolved = path.resolve(local.configPath);
    if (seen.has(resolved)) continue;
    seen.set(resolved, {
      name: local.displayName,
      seedId: local.seedId,
      status: 'stopped',
      port: null,
      pid: null,
      configPath: resolved,
      startedAt: null,
      uptime: null,
      memory: null,
      tools: null,
      channels: null,
    });
  }

  /* History (lowest priority) */
  for (const h of history) {
    const resolved = path.resolve(h.configPath);
    if (seen.has(resolved)) continue;
    if (!existsSync(resolved)) continue;
    seen.set(resolved, {
      name: h.displayName,
      seedId: h.seedId,
      status: 'stopped',
      port: null,
      pid: null,
      configPath: resolved,
      startedAt: null,
      uptime: null,
      memory: null,
      tools: null,
      channels: null,
    });
  }

  sendJson(res, 200, Array.from(seen.values()));
  return true;
}

/**
 * Start an agent by spawning `wunderland serve --config <path>`.
 * Looks up the agent's configPath from daemon info or local scan.
 */
async function handleStartAgent(
  res: ServerResponse,
  seedId: string,
  _deps: DashboardDeps,
): Promise<boolean> {
  /* Find the agent's config path from history or local scan. */
  let configPath: string | null = null;

  const history = readAgentHistory();
  const histEntry = history.find((h) => h.seedId === seedId);
  if (histEntry && existsSync(histEntry.configPath)) {
    configPath = histEntry.configPath;
  }

  if (!configPath) {
    const localAgents = await scanLocalAgents();
    const localEntry = localAgents.find((a) => a.seedId === seedId);
    if (localEntry) configPath = localEntry.configPath;
  }

  if (!configPath || !existsSync(configPath)) {
    sendJson(res, 404, { error: `No config found for agent "${seedId}"` });
    return true;
  }

  /* Resolve the wunderland binary. */
  const wunderlandBin = process.argv[1];
  if (!wunderlandBin || !existsSync(wunderlandBin)) {
    sendJson(res, 500, { error: 'Could not resolve the wunderland binary path' });
    return true;
  }

  /* Shell out to `wunderland serve --config <path>`. */
  const childArgs = [wunderlandBin, 'serve', '--config', configPath];

  try {
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(configPath),
      env: { ...process.env },
    });
    child.unref();

    sendJson(res, 200, {
      ok: true,
      seedId,
      configPath,
      pid: child.pid || null,
      message: `Starting agent "${seedId}" — it may take a few seconds to become healthy.`,
    });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Spawn failed' });
  }

  return true;
}

/**
 * Stop a running agent daemon by sending SIGTERM to its PID.
 * Cleans up the daemon info after termination.
 */
async function handleStopAgent(
  res: ServerResponse,
  seedId: string,
): Promise<boolean> {
  const { readDaemonInfo } = await import('../../../daemon/daemon-state.js');
  const info = await readDaemonInfo(seedId);

  if (!info) {
    sendJson(res, 404, { error: `No daemon info found for "${seedId}"` });
    return true;
  }

  if (!isDaemonAlive(info.pid)) {
    await removeDaemonInfo(seedId);
    sendJson(res, 200, { ok: true, message: `Agent "${seedId}" was already stopped (stale PID).` });
    return true;
  }

  try {
    /* If there is a watchdog, kill that first. */
    if (info.watchdogPid && isDaemonAlive(info.watchdogPid)) {
      try { process.kill(info.watchdogPid, 'SIGTERM'); } catch { /* ignore */ }
    }

    process.kill(info.pid, 'SIGTERM');
    await removeDaemonInfo(seedId);
    sendJson(res, 200, { ok: true, message: `Agent "${seedId}" (PID ${info.pid}) stopped.` });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Failed to stop' });
  }

  return true;
}

/**
 * Spawn a brand-new agent from a natural language description.
 * Uses `extractAgentConfig` to derive config, writes files, then starts the daemon.
 */
async function handleSpawn(
  req: IncomingMessage,
  res: ServerResponse,
  _deps: DashboardDeps,
): Promise<boolean> {
  let body: { description?: string; port?: number };
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return true;
  }

  const description = body.description?.trim();
  if (!description) {
    sendJson(res, 400, { error: 'Missing "description" field' });
    return true;
  }

  const requestedPort = body.port;

  try {
    /* Lazy-import the NL agent builder. */
    const { extractAgentConfig } = await import('../../../../core/NaturalLanguageAgentBuilder.js');

    /* Build a simple LLM invoker from env vars (non-interactive). */
    const openaiKey = process.env['OPENAI_API_KEY'] || '';
    const orKey = process.env['OPENROUTER_API_KEY'] || '';
    const anthropicKey = process.env['ANTHROPIC_API_KEY'] || '';
    if (!openaiKey && !orKey && !anthropicKey) {
      sendJson(res, 500, { error: 'No LLM API key found in environment (OPENAI_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY)' });
      return true;
    }
    const baseUrl = orKey ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
    const apiKey = orKey || openaiKey;
    const llmModel = orKey ? 'openai/gpt-4o' : 'gpt-4o';

    const invoker = async (prompt: string): Promise<string> => {
      if (anthropicKey && !apiKey) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2048, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`Anthropic error (${r.status}): ${text.slice(0, 300)}`);
        const d = JSON.parse(text);
        return d?.content?.find((b: any) => b?.type === 'text')?.text || '';
      }
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: llmModel, temperature: 0.1, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`LLM error (${r.status}): ${text.slice(0, 300)}`);
      return JSON.parse(text)?.choices?.[0]?.message?.content || '';
    };

    const config = await extractAgentConfig(description, invoker);

    /* Write agent files to a directory. */
    const safeName = (config.displayName || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const agentDir = path.join(process.cwd(), safeName);
    await mkdir(agentDir, { recursive: true });

    const agentConfig: Record<string, any> = {
      seedId: config.seedId || `seed_${safeName.replace(/-/g, '_')}_${Date.now().toString(36)}`,
      displayName: config.displayName || safeName,
      systemPrompt: config.systemPrompt || `You are ${config.displayName || 'an AI assistant'}.`,
      extensions: config.extensions || {},
      channels: config.channels || [],
    };

    if (requestedPort) {
      agentConfig.port = requestedPort;
    }

    const configPath = path.join(agentDir, 'agent.config.json');
    await writeFile(configPath, JSON.stringify(agentConfig, null, 2) + '\n', 'utf-8');

    /* Copy relevant env vars into a .env file. */
    const envLines: string[] = [];
    const envVars = [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
      'GOOGLE_AI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
    ];
    for (const key of envVars) {
      if (process.env[key]) envLines.push(`${key}=${process.env[key]}`);
    }
    if (envLines.length) {
      await writeFile(path.join(agentDir, '.env'), envLines.join('\n') + '\n', 'utf-8');
    }

    /* Start the agent as a daemon. */
    const wunderlandBin = process.argv[1];
    if (wunderlandBin && existsSync(wunderlandBin)) {
      const serveArgs = [wunderlandBin, 'serve', '--config', configPath];
      if (requestedPort) serveArgs.push('--port', String(requestedPort));

      const child = spawn(process.execPath, serveArgs, {
        detached: true,
        stdio: 'ignore',
        cwd: agentDir,
        env: { ...process.env },
      });
      child.unref();
    }

    sendJson(res, 200, {
      ok: true,
      seedId: agentConfig.seedId,
      displayName: agentConfig.displayName,
      port: requestedPort || 3777,
      configPath,
    });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'Spawn failed',
    });
  }

  return true;
}

/**
 * Serve the last 200 lines of an agent's stdout log.
 */
async function handleLogs(
  res: ServerResponse,
  seedId: string,
): Promise<boolean> {
  const daemonDir = getDaemonDir(seedId);
  const logPath = path.join(daemonDir, 'stdout.log');

  if (!existsSync(logPath)) {
    sendJson(res, 404, { error: `No log file found for "${seedId}"` });
    return true;
  }

  try {
    const raw = await readFile(logPath, 'utf-8');
    const allLines = raw.split('\n');
    const lastLines = allLines.slice(-200).join('\n');
    sendJson(res, 200, { seedId, lines: lastLines });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Failed to read log' });
  }

  return true;
}
