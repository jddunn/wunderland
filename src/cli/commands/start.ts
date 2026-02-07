/**
 * @fileoverview `wunderland start` — start local agent server.
 * Ported from bin/wunderland.js cmdStart() with colored output.
 * @module wunderland/cli/commands/start
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, info as iColor, warn as wColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcess } from '../config/env-manager.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../../core/index.js';

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

async function chatWithOpenAI(opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage },
      ],
      temperature: 0.7,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI error (${res.status}): ${text.slice(0, 300)}`);

  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('OpenAI returned an empty response.');
  return content.trim();
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdStart(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const configPath = typeof flags['config'] === 'string'
    ? path.resolve(process.cwd(), flags['config'])
    : path.resolve(process.cwd(), 'agent.config.json');

  // Load environment
  await loadDotEnvIntoProcess(
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
  );

  if (!existsSync(configPath)) {
    fmt.errorBlock('Missing config file', `${configPath}\nRun: ${accent('wunderland init my-agent')}`);
    process.exitCode = 1;
    return;
  }

  const cfg = JSON.parse(await readFile(configPath, 'utf8'));
  const seedId = String(cfg.seedId || 'seed_local_agent');
  const displayName = String(cfg.displayName || 'My Agent');
  const description = String(cfg.bio || 'Autonomous Wunderland agent');
  const p = cfg.personality || {};

  const security = {
    ...DEFAULT_SECURITY_PROFILE,
    enablePreLLMClassifier: cfg?.security?.preLLMClassifier ?? DEFAULT_SECURITY_PROFILE.enablePreLLMClassifier,
    enableDualLLMAuditor: cfg?.security?.dualLLMAudit ?? DEFAULT_SECURITY_PROFILE.enableDualLLMAuditor,
    enableOutputSigning: cfg?.security?.outputSigning ?? DEFAULT_SECURITY_PROFILE.enableOutputSigning,
  };

  const seed = createWunderlandSeed({
    seedId,
    name: displayName,
    description,
    hexacoTraits: {
      honesty_humility: Number.isFinite(p.honesty) ? p.honesty : 0.8,
      emotionality: Number.isFinite(p.emotionality) ? p.emotionality : 0.5,
      extraversion: Number.isFinite(p.extraversion) ? p.extraversion : 0.6,
      agreeableness: Number.isFinite(p.agreeableness) ? p.agreeableness : 0.7,
      conscientiousness: Number.isFinite(p.conscientiousness) ? p.conscientiousness : 0.8,
      openness: Number.isFinite(p.openness) ? p.openness : 0.7,
    },
    baseSystemPrompt: typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : undefined,
    securityProfile: security,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });

  const portRaw = typeof flags['port'] === 'string' ? flags['port'] : (process.env['PORT'] || '');
  const port = Number(portRaw) || 3777;
  const apiKey = process.env['OPENAI_API_KEY'] || '';
  const model = process.env['OPENAI_MODEL'] || 'gpt-4o-mini';

  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

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
        if (apiKey) {
          reply = await chatWithOpenAI({
            apiKey,
            model,
            systemPrompt: seed.baseSystemPrompt,
            userMessage: message,
          });
        } else {
          reply =
            'OPENAI_API_KEY is not set. I can run, but I cannot generate real replies yet.\n\n' +
            'Set OPENAI_API_KEY in .env, then retry.\n\n' +
            `You said: ${message}`;
        }

        sendJson(res, 200, { reply });
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Server error' });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve());
  });

  // Status display
  fmt.section('Agent Server Running');
  fmt.kvPair('Agent', accent(displayName));
  fmt.kvPair('Seed ID', seedId);
  fmt.kvPair('Model', model);
  fmt.kvPair('API Key', apiKey ? sColor('set') : wColor('not set'));
  fmt.kvPair('Port', String(port));
  fmt.blank();
  fmt.ok(`Health: ${iColor(`http://localhost:${port}/health`)}`);
  fmt.ok(`Chat:   ${iColor(`POST http://localhost:${port}/chat`)}`);
  fmt.blank();
}
