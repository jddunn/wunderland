/**
 * @fileoverview `wunderland hitl` — watch and resolve HITL approvals/checkpoints.
 * @module wunderland/cli/commands/hitl
 */

import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import type { GlobalFlags } from '../types.js';
import { accent, warn as wColor, success as sColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';

type PendingSnapshot = {
  approvals?: Array<{ actionId: string; severity?: string; description?: string }>;
  checkpoints?: Array<{ checkpointId: string; currentPhase?: string; completedWork?: string[] }>;
};

function normalizeServerUrl(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return 'http://localhost:3777';
  if (v.startsWith('http://') || v.startsWith('https://')) return v.replace(/\/+$/, '');
  return `http://${v}`.replace(/\/+$/, '');
}

function buildUrl(base: string, path: string, secret: string): string {
  const u = new URL(path, base);
  u.searchParams.set('secret', secret);
  return u.toString();
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

export default async function cmdHitl(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const sub = (args[0] || 'watch').trim().toLowerCase();
  if (sub !== 'watch') {
    fmt.errorBlock('Unknown subcommand', `wunderland hitl ${sub}\nSupported: watch`);
    process.exitCode = 1;
    return;
  }

  const server = normalizeServerUrl(typeof flags['server'] === 'string' ? flags['server'] : (process.env['WUNDERLAND_SERVER_URL'] || ''));
  const secret = String(typeof flags['secret'] === 'string' ? flags['secret'] : (process.env['WUNDERLAND_HITL_SECRET'] || '')).trim();
  if (!secret) {
    fmt.errorBlock(
      'Missing HITL secret',
      `Provide --secret <token> or set WUNDERLAND_HITL_SECRET.\nServer UI: ${accent(`${server}/hitl`)}`,
    );
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const g = glyphs();
  let processing = false;

  async function getPending(): Promise<PendingSnapshot> {
    return await fetchJson(buildUrl(server, '/hitl/pending', secret));
  }

  async function approve(actionId: string): Promise<void> {
    await fetchJson(buildUrl(server, `/hitl/approvals/${encodeURIComponent(actionId)}/approve`, secret), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decidedBy: process.env['USER'] || 'operator' }),
    });
  }

  async function reject(actionId: string, reason?: string): Promise<void> {
    await fetchJson(buildUrl(server, `/hitl/approvals/${encodeURIComponent(actionId)}/reject`, secret), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decidedBy: process.env['USER'] || 'operator', reason: reason || '' }),
    });
  }

  async function checkpointDecision(checkpointId: string, decision: 'continue' | 'abort'): Promise<void> {
    await fetchJson(buildUrl(server, `/hitl/checkpoints/${encodeURIComponent(checkpointId)}/${decision}`, secret), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decidedBy: process.env['USER'] || 'operator' }),
    });
  }

  async function processPending(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      for (;;) {
        const pending = await getPending();
        const approvals = Array.isArray(pending?.approvals) ? pending.approvals : [];
        const checkpoints = Array.isArray(pending?.checkpoints) ? pending.checkpoints : [];

        if (approvals.length === 0 && checkpoints.length === 0) break;

        if (approvals.length > 0) {
          const a = approvals[0]!;
          fmt.section('Approval Required');
          fmt.kvPair('Action', accent(a.actionId));
          if (a.severity) fmt.kvPair('Severity', String(a.severity));
          if (a.description) console.log(`\n${dim(a.description)}\n`);
          const ans = (await rl.question(`  ${wColor(g.warn)} Approve? ${muted('[y]es / [n]o / [s]kip')} `)).trim().toLowerCase();
          if (ans === 'y' || ans === 'yes') {
            await approve(a.actionId);
            fmt.ok(`${sColor('approved')} ${a.actionId}`);
            continue;
          }
          if (ans === 'n' || ans === 'no') {
            const reason = (await rl.question(`  ${muted('Reason (optional):')} `)).trim();
            await reject(a.actionId, reason);
            fmt.ok(`${wColor('rejected')} ${a.actionId}`);
            continue;
          }
          // skip
          break;
        }

        const c = checkpoints[0]!;
        fmt.section('Checkpoint');
        fmt.kvPair('Checkpoint', accent(c.checkpointId));
        if (c.currentPhase) fmt.kvPair('Phase', String(c.currentPhase));
        if (Array.isArray(c.completedWork) && c.completedWork.length > 0) {
          console.log(`\n${dim(c.completedWork.join('\n\n').slice(0, 2000))}\n`);
        }
        const ans = (await rl.question(`  ${wColor(g.warn)} Continue? ${muted('[y]es / [a]bort / [s]kip')} `)).trim().toLowerCase();
        if (ans === 'y' || ans === 'yes') {
          await checkpointDecision(c.checkpointId, 'continue');
          fmt.ok(`${sColor('continued')} ${c.checkpointId}`);
          continue;
        }
        if (ans === 'a' || ans === 'abort') {
          await checkpointDecision(c.checkpointId, 'abort');
          fmt.ok(`${wColor('aborted')} ${c.checkpointId}`);
          continue;
        }
        // skip
        break;
      }
    } finally {
      processing = false;
    }
  }

  fmt.section('HITL Watch');
  fmt.kvPair('Server', accent(server));
  fmt.kvPair('Stream', accent('/hitl/stream'));
  fmt.blank();
  fmt.note(`UI: ${accent(`${server}/hitl`)}`);
  fmt.blank();

  await processPending();

  async function connectStream(): Promise<void> {
    const url = buildUrl(server, '/hitl/stream', secret);
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
    if (!res.ok || !res.body) throw new Error(`Stream failed: HTTP ${res.status}`);

    const stream = Readable.fromWeb(res.body as any);
    let buf = '';

    for await (const chunk of stream) {
      buf += chunk.toString('utf8');
      for (;;) {
        const idx = buf.indexOf('\n\n');
        if (idx === -1) break;
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        const lines = rawEvent.split('\n');
        let eventName = '';
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (eventName === 'hitl') {
          void processPending();
        }
      }
    }
  }

  for (;;) {
    try {
      await connectStream();
    } catch (err) {
      fmt.warning(`HITL stream disconnected: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
