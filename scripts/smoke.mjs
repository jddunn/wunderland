#!/usr/bin/env node
/**
 * Wunderland smoke test — five live-API checks.
 * Run from packages/wunderland/ after `pnpm build`.
 * Exits 0 on all pass, 1 on any check fail, 2 on missing required env.
 *
 * Spec: docs/superpowers/specs/2026-04-19-wunderland-env-wiring-smoke-test-design.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

try {
  const envPath = path.join(PACKAGE_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      if (process.env[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
} catch (e) {
  console.error('[smoke] failed to load .env:', e?.message);
}

const DYN = new Date().toISOString() + '-' + Math.random().toString(36).slice(2, 8);

const REQUIRED = ['OPENAI_API_KEY', 'SERPER_API_KEY', 'GIPHY_API_KEY', 'ELEVENLABS_API_KEY', 'WUNDERLAND_SIGNING_SECRET'];
for (const name of REQUIRED) {
  const v = process.env[name];
  if (!v) {
    console.error(`[smoke] missing required env: ${name}`);
    process.exit(2);
  }
  if (name === 'WUNDERLAND_SIGNING_SECRET' && v.startsWith('wunderland-dev-signing-secret')) {
    console.error(`[smoke] WUNDERLAND_SIGNING_SECRET is still the dev placeholder — rotate via openssl rand -hex 32`);
    process.exit(2);
  }
}

const { createWunderland } = await import('../dist/index.js');
const { SerperSearchTool, GiphyTool, ElevenLabsTool } = await import('../dist/tools/index.js');

const stubContext = { requestId: `smoke-${DYN}`, logger: { info() {}, warn() {}, error() {}, debug() {} } };

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

try {
  const app = await createWunderland({
    llm: { providerId: 'openai', model: 'gpt-4o-mini' },
  });
  const session = app.session();
  const turn = await session.sendText(`Respond with a single fresh adjective. Tag: ${DYN}.`);
  const ok = Boolean(turn?.text && turn.text.length > 0 && turn.meta?.sessionId);
  record('llm-turn', ok, ok ? `${turn.text.slice(0, 80)} [session=${turn.meta.sessionId.slice(0, 8)}]` : JSON.stringify(turn).slice(0, 200));

  const usage = await session.usage();
  const totalCalls = usage?.totalCalls ?? 0;
  const totalTokens = (usage?.totalTokens ?? usage?.total_tokens ?? 0);
  record('usage', totalCalls > 0 && totalTokens > 0, `calls=${totalCalls} tokens=${totalTokens}`);
} catch (e) {
  record('llm-turn', false, `${e?.message ?? e}`);
  record('usage', false, 'skipped — llm-turn failed');
}

try {
  const serper = new SerperSearchTool();
  const out = await serper.execute({ query: `ai agent frameworks ${DYN}`, num: 3 }, stubContext);
  const hits = out?.output?.results?.length ?? 0;
  record('serper', Boolean(out?.success && hits > 0), out?.success ? `${hits} hits` : (out?.error ?? 'no output'));
} catch (e) {
  record('serper', false, `${e?.message ?? e}`);
}

try {
  const giphy = new GiphyTool(process.env.GIPHY_API_KEY);
  const out = await giphy.execute({ query: 'rabbit hole', limit: 3 }, stubContext);
  const hits = out?.output?.results?.length ?? 0;
  record('giphy', Boolean(out?.success && hits > 0), out?.success ? `${hits} gifs` : (out?.error ?? 'no output'));
} catch (e) {
  record('giphy', false, `${e?.message ?? e}`);
}

let ttsOutPath = '';
try {
  const tts = new ElevenLabsTool({ elevenLabsApiKey: process.env.ELEVENLABS_API_KEY, defaultProvider: 'elevenlabs' });
  const out = await tts.execute({ text: `Smoke check ${DYN}`, provider: 'elevenlabs' }, stubContext);
  const b64 = out?.output?.audioBase64 ?? '';
  const bytes = b64 ? Buffer.from(b64, 'base64').length : 0;
  if (bytes > 1024) {
    ttsOutPath = path.join(os.tmpdir(), `wunderland-smoke-${DYN}.mp3`);
    fs.writeFileSync(ttsOutPath, Buffer.from(b64, 'base64'));
  }
  record('tts', Boolean(out?.success && bytes > 1024), out?.success ? `${bytes} bytes @ ${ttsOutPath || '(not written)'}` : (out?.error ?? 'no output'));
} catch (e) {
  record('tts', false, `${e?.message ?? e}`);
}

const ORDER = ['llm-turn', 'serper', 'giphy', 'tts', 'usage'];
const ordered = ORDER.map((n) => results.find((r) => r.name === n)).filter(Boolean);
for (const r of ordered) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`);
}
const failed = ordered.filter((r) => !r.ok).length;
const total = ordered.length;
if (failed) {
  console.error(`[smoke] ${total - failed}/${total} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`[smoke] ${total}/${total} passed`);
process.exit(0);
