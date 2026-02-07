#!/usr/bin/env node
/**
 * Wunderland CLI
 *
 * Goals:
 * - `wunderland init <dir>`: scaffold a minimal agent project
 * - `wunderland start`: run a local HTTP server for chatting with the agent
 *
 * This intentionally keeps dependencies to zero (Node built-ins only).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as path from 'node:path';

import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../index.js';

type Flags = Record<string, string | boolean>;

type AgentConfigFile = {
  seedId: string;
  displayName: string;
  bio?: string;
  personality?: {
    honesty?: number;
    emotionality?: number;
    extraversion?: number;
    agreeableness?: number;
    conscientiousness?: number;
    openness?: number;
  };
  systemPrompt?: string;
  security?: {
    preLLMClassifier?: boolean;
    dualLLMAudit?: boolean;
    outputSigning?: boolean;
  };
};

function printHelp(): void {
  // Keep this short; the landing/docs reference these commands.
  console.log(`Wunderland CLI

Usage:
  wunderland init <dir>           Scaffold a new Wunderbot project
  wunderland start                Start local agent server (default: :3777)

Options:
  --config <path>                 Path to agent config (default: ./agent.config.json)
  --port <number>                 Server port (default: PORT env or 3777)

Environment:
  OPENAI_API_KEY                  Enables real LLM replies
  OPENAI_MODEL                    Defaults to gpt-4o-mini

Examples:
  wunderland init my-agent
  cd my-agent
  cp .env.example .env
  wunderland start
`);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        const k = raw.slice(0, eq).trim();
        const v = raw.slice(eq + 1);
        if (k) flags[k] = v;
        continue;
      }

      const key = raw.trim();
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      flags.version = true;
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags };
}

function toSeedId(dirName: string): string {
  const base = dirName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return base ? `seed_${base}` : `seed_${Date.now()}`;
}

function toDisplayName(dirName: string): string {
  const cleaned = dirName.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'My Agent';
  return cleaned
    .split(' ')
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ');
}

async function ensureDirEmptyOrForce(dir: string, force: boolean): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir).catch(() => []);
  if (entries.length === 0) return;
  if (!force) {
    throw new Error(
      `Target directory is not empty: ${dir}\nRe-run with --force to write files anyway.`
    );
  }
}

async function cmdInit(args: string[], flags: Flags): Promise<void> {
  const dirName = args[0];
  if (!dirName) {
    throw new Error('Missing directory name. Example: wunderland init my-agent');
  }

  const targetDir = path.resolve(process.cwd(), dirName);
  const force = flags.force === true;
  await ensureDirEmptyOrForce(targetDir, force);
  await mkdir(targetDir, { recursive: true });

  const config: AgentConfigFile = {
    seedId: toSeedId(dirName),
    displayName: toDisplayName(dirName),
    bio: 'Autonomous Wunderland agent',
    personality: {
      honesty: 0.7,
      emotionality: 0.5,
      extraversion: 0.6,
      agreeableness: 0.65,
      conscientiousness: 0.8,
      openness: 0.75,
    },
    systemPrompt: 'You are an autonomous agent in the Wunderland network.',
    security: { preLLMClassifier: true, dualLLMAudit: true, outputSigning: true },
  };

  const configPath = path.join(targetDir, 'agent.config.json');
  const envPath = path.join(targetDir, '.env.example');
  const gitignorePath = path.join(targetDir, '.gitignore');
  const readmePath = path.join(targetDir, 'README.md');

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await writeFile(
    envPath,
    `# Copy to .env and fill in real values
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
PORT=3777
`,
    'utf8'
  );
  await writeFile(gitignorePath, `.env\nnode_modules\n`, 'utf8');
  await writeFile(
    readmePath,
    `# ${config.displayName}

This project was scaffolded by the Wunderland CLI.

## Run

1. Install the CLI (if you don't already have it):

\`\`\`bash
npm install -g @framers/wunderland
\`\`\`

2. Configure env:

\`\`\`bash
cp .env.example .env
\`\`\`

3. Start:

\`\`\`bash
wunderland start
\`\`\`

Agent server:
- GET http://localhost:3777/health
- POST http://localhost:3777/chat { "message": "Hello" }
`,
    'utf8'
  );

  console.log(`Initialized: ${targetDir}`);
  console.log(`Next: cd ${dirName} && cp .env.example .env && wunderland start`);
}

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = val;
  }
  return out;
}

async function loadDotEnvIfPresent(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  const raw = await readFile(filePath, 'utf8');
  const parsed = parseEnvFile(raw);
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const maxBytes = 1_000_000; // 1MB

    req.on('data', (chunk) => {
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

async function chatWithOpenAI(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userMessage },
      ],
      temperature: 0.7,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI error (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text) as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenAI returned an empty response.');
  }
  return content.trim();
}

async function cmdStart(_args: string[], flags: Flags): Promise<void> {
  const configPath =
    typeof flags.config === 'string'
      ? path.resolve(process.cwd(), flags.config)
      : path.resolve(process.cwd(), 'agent.config.json');

  await loadDotEnvIfPresent(path.resolve(process.cwd(), '.env'));
  await loadDotEnvIfPresent(path.resolve(process.cwd(), '.env.local'));

  if (!existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}\nRun: wunderland init my-agent`);
  }

  const rawConfig = await readFile(configPath, 'utf8');
  const cfg = JSON.parse(rawConfig) as Partial<AgentConfigFile>;

  const seedId = String(cfg.seedId ?? 'seed_local_agent');
  const displayName = String(cfg.displayName ?? 'My Agent');
  const description = String(cfg.bio ?? 'Autonomous Wunderland agent');
  const p = cfg.personality ?? {};

  const security = {
    ...DEFAULT_SECURITY_PROFILE,
    enablePreLLMClassifier: cfg.security?.preLLMClassifier ?? DEFAULT_SECURITY_PROFILE.enablePreLLMClassifier,
    enableDualLLMAuditor: cfg.security?.dualLLMAudit ?? DEFAULT_SECURITY_PROFILE.enableDualLLMAuditor,
    enableOutputSigning: cfg.security?.outputSigning ?? DEFAULT_SECURITY_PROFILE.enableOutputSigning,
  };

  const seed = createWunderlandSeed({
    seedId,
    name: displayName,
    description,
    hexacoTraits: {
      // Rabbit Hole UI stores "honesty" as Honesty-Humility; map it to SDK trait key.
      honesty_humility: p.honesty ?? 0.8,
      emotionality: p.emotionality ?? 0.5,
      extraversion: p.extraversion ?? 0.6,
      agreeableness: p.agreeableness ?? 0.7,
      conscientiousness: p.conscientiousness ?? 0.8,
      openness: p.openness ?? 0.7,
    },
    baseSystemPrompt: typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : undefined,
    securityProfile: security,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });

  const portRaw =
    typeof flags.port === 'string' ? flags.port : (process.env.PORT ?? '');
  const port = Number(portRaw) || 3777;

  const apiKey = process.env.OPENAI_API_KEY ?? '';
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

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

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, seedId, name: displayName });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = await readJsonBody(req);
        const parsed = JSON.parse(body || '{}') as { message?: unknown };
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
            `OPENAI_API_KEY is not set. I can run, but I cannot generate real replies yet.\n\n` +
            `Set OPENAI_API_KEY in .env, then retry.\n\n` +
            `You said: ${message}`;
        }

        sendJson(res, 200, { reply });
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Server error';
      sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve());
  });

  console.log(`[wunderland] Agent "${displayName}" listening on http://localhost:${port}`);
  console.log(`[wunderland] Health: curl http://localhost:${port}/health`);
  console.log(
    `[wunderland] Chat:   curl -s http://localhost:${port}/chat -H 'Content-Type: application/json' -d '{\"message\":\"Hello\"}' | jq`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));

  if (!cmd || flags.help === true || cmd === 'help') {
    printHelp();
    return;
  }

  if (flags.version === true || cmd === 'version') {
    // Avoid importing package.json at runtime; keep it simple for now.
    console.log('@framers/wunderland');
    return;
  }

  switch (cmd) {
    case 'init':
      await cmdInit(positional, flags);
      return;
    case 'start':
      await cmdStart(positional, flags);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[wunderland] ${message}`);
  process.exitCode = 1;
});
