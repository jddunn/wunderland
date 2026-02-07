/**
 * @fileoverview `wunderland start` — start local agent server.
 * Ported from bin/wunderland.js cmdStart() with colored output.
 * @module wunderland/cli/commands/start
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import * as path from 'node:path';
import os from 'node:os';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, info as iColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcess } from '../config/env-manager.js';
import { SkillRegistry } from '../../skills/index.js';
import { runToolCallingTurn, type ToolInstance } from '../openai/tool-calling.js';
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

function resolveSkillsDirs(flags: Record<string, string | boolean>): string[] {
  const dirs: string[] = [];
  const skillsDirFlag = flags['skills-dir'];
  if (typeof skillsDirFlag === 'string' && skillsDirFlag.trim()) {
    for (const part of skillsDirFlag.split(',')) {
      const p = part.trim();
      if (p) dirs.push(path.resolve(process.cwd(), p));
    }
  }
  const codexHome = typeof process.env['CODEX_HOME'] === 'string' ? process.env['CODEX_HOME'].trim() : '';
  if (codexHome) dirs.push(path.join(codexHome, 'skills'));
  dirs.push(path.join(os.homedir(), '.codex', 'skills'));
  dirs.push(path.join(process.cwd(), 'skills'));

  const seen = new Set<string>();
  return dirs.filter((d) => {
    if (!d) return false;
    const key = path.resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return existsSync(key);
  });
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdStart(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
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
  const model = typeof flags['model'] === 'string' ? flags['model'] : (process.env['OPENAI_MODEL'] || 'gpt-4o-mini');

  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const dangerouslySkipCommandSafety =
    flags['dangerously-skip-command-safety'] === true || dangerouslySkipPermissions;
  const autoApproveToolCalls = globals.yes || dangerouslySkipPermissions;
  const enableSkills = flags['no-skills'] !== true;

  // Load tools from curated extensions (same stack as `wunderland chat`)
  const [cliExecutor, webSearch, webBrowser, giphy, imageSearch, voiceSynthesis, newsSearch] = await Promise.all([
    import('@framers/agentos-ext-cli-executor'),
    import('@framers/agentos-ext-web-search'),
    import('@framers/agentos-ext-web-browser'),
    import('@framers/agentos-ext-giphy'),
    import('@framers/agentos-ext-image-search'),
    import('@framers/agentos-ext-voice-synthesis'),
    import('@framers/agentos-ext-news-search'),
  ]);

  const packs = [
    cliExecutor.createExtensionPack({
      options: {
        workingDirectory: process.cwd(),
        dangerouslySkipSecurityChecks: dangerouslySkipCommandSafety,
      },
      logger: console,
    }),
    webSearch.createExtensionPack({
      options: {
        serperApiKey: process.env['SERPER_API_KEY'],
        serpApiKey: process.env['SERPAPI_API_KEY'],
        braveApiKey: process.env['BRAVE_API_KEY'],
      },
      logger: console,
    }),
    webBrowser.createExtensionPack({ options: { headless: true }, logger: console }),
    giphy.createExtensionPack({ options: { giphyApiKey: process.env['GIPHY_API_KEY'] }, logger: console }),
    imageSearch.createExtensionPack({
      options: {
        pexelsApiKey: process.env['PEXELS_API_KEY'],
        unsplashApiKey: process.env['UNSPLASH_ACCESS_KEY'],
        pixabayApiKey: process.env['PIXABAY_API_KEY'],
      },
      logger: console,
    }),
    voiceSynthesis.createExtensionPack({ options: { elevenLabsApiKey: process.env['ELEVENLABS_API_KEY'] }, logger: console }),
    newsSearch.createExtensionPack({ options: { newsApiKey: process.env['NEWSAPI_API_KEY'] }, logger: console }),
  ];

  const allTools: ToolInstance[] = packs
    .flatMap((p) => (p?.descriptors || []).filter((d: { kind: string }) => d?.kind === 'tool').map((d: { payload: unknown }) => d.payload))
    .filter(Boolean) as ToolInstance[];

  // In server mode we can't prompt for approvals, so default to safe tools only
  // unless the user explicitly opts into auto-approval.
  const tools: ToolInstance[] = autoApproveToolCalls ? allTools : allTools.filter((t) => t.hasSideEffects !== true);

  const toolMap = new Map<string, ToolInstance>();
  for (const tool of tools) {
    if (!tool?.name) continue;
    toolMap.set(tool.name, tool);
  }

  const toolDefs = [...toolMap.values()].map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));

  // Skills
  let skillsPrompt = '';
  if (enableSkills) {
    const skillRegistry = new SkillRegistry();
    const dirs = resolveSkillsDirs(flags);
    if (dirs.length > 0) {
      await skillRegistry.loadFromDirs(dirs);
      const snapshot = skillRegistry.buildSnapshot({ platform: process.platform });
      skillsPrompt = snapshot.prompt || '';
    }
  }

  const systemPrompt = [
    typeof seed.baseSystemPrompt === 'string' ? seed.baseSystemPrompt : String(seed.baseSystemPrompt),
    'You are a local Wunderland agent server.',
    'You can use tools to read/write files, run shell commands, and browse the web.',
    skillsPrompt || '',
  ].filter(Boolean).join('\n\n');

  const sessions = new Map<string, Array<Record<string, unknown>>>();

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
          const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
            ? parsed.sessionId.trim().slice(0, 128)
            : 'default';

          if (parsed.reset === true) {
            sessions.delete(sessionId);
          }

          let messages = sessions.get(sessionId);
          if (!messages) {
            messages = [{ role: 'system', content: systemPrompt }];
            sessions.set(sessionId, messages);
          }

          // Keep a soft cap to avoid unbounded memory in long-running servers.
          if (messages.length > 200) {
            messages = [messages[0]!, ...messages.slice(-120)];
            sessions.set(sessionId, messages);
          }

          messages.push({ role: 'user', content: message });

          const toolContext = {
            gmiId: `wunderland-server-${sessionId}`,
            personaId: seed.seedId,
            userContext: { userId: sessionId },
          };

          reply = await runToolCallingTurn({
            apiKey,
            model,
            messages,
            toolMap,
            toolDefs,
            toolContext,
            maxRounds: 8,
            dangerouslySkipPermissions: autoApproveToolCalls,
            askPermission: async () => false,
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
  fmt.kvPair('Tools', `${toolDefs.length} loaded`);
  fmt.kvPair('Side Effects', autoApproveToolCalls ? wColor('auto-approved') : sColor('disabled'));
  fmt.blank();
  fmt.ok(`Health: ${iColor(`http://localhost:${port}/health`)}`);
  fmt.ok(`Chat:   ${iColor(`POST http://localhost:${port}/chat`)}`);
  fmt.blank();
}
