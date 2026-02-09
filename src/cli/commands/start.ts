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
import { accent, success as sColor, info as iColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../config/workspace.js';
import { isOllamaRunning, startOllama, detectOllamaInstall } from '../ollama/ollama-manager.js';
import { SkillRegistry, resolveDefaultSkillsDirs } from '../../skills/index.js';
import { createAuthorizationManager, runToolCallingTurn, type ToolInstance } from '../openai/tool-calling.js';
import { createSchemaOnDemandTools } from '../openai/schema-on-demand.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
  ToolRiskTier,
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
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

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

  // Auto-start Ollama if configured as provider
  const isOllamaProvider = cfg.llmProvider === 'ollama' || flags['ollama'] === true;
  if (isOllamaProvider) {
    const ollamaBin = await detectOllamaInstall();
    if (ollamaBin) {
      const running = await isOllamaRunning();
      if (!running) {
        fmt.note('Ollama is configured but not running — starting...');
        try {
          await startOllama();
          fmt.ok('Ollama server started at http://localhost:11434');
        } catch {
          fmt.warning('Failed to start Ollama. Start it manually: ollama serve');
        }
      } else {
        fmt.ok('Ollama server is running');
      }
    }
  }

  const portRaw = typeof flags['port'] === 'string' ? flags['port'] : (process.env['PORT'] || '');
  const port = Number(portRaw) || 3777;
  const apiKey = process.env['OPENAI_API_KEY'] || '';
  const model = typeof flags['model'] === 'string' ? flags['model'] : (process.env['OPENAI_MODEL'] || 'gpt-4o-mini');

  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const dangerouslySkipCommandSafety =
    flags['dangerously-skip-command-safety'] === true || dangerouslySkipPermissions;
  const autoApproveToolCalls = globals.yes || dangerouslySkipPermissions;
  const enableSkills = flags['no-skills'] !== true;
  const lazyTools = flags['lazy-tools'] === true || cfg?.lazyTools === true;
  const workspaceBaseDir = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(seedId);

  const preloadedPackages: string[] = [];
  let allTools: ToolInstance[] = [];

  if (!lazyTools) {
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

    const skillsExtModule: string = '@framers/agentos-ext-skills';
    const skillsExt = await import(skillsExtModule).catch(() => null);

    const packs = [
      cliExecutor.createExtensionPack({
        options: {
          filesystem: { allowRead: true, allowWrite: true },
          agentWorkspace: {
            agentId: workspaceAgentId,
            baseDir: workspaceBaseDir,
            createIfMissing: true,
            subdirs: ['assets', 'exports', 'tmp'],
          },
          dangerouslySkipSecurityChecks: dangerouslySkipCommandSafety,
        },
        logger: console,
      }),
      skillsExt ? skillsExt.createExtensionPack({ options: {}, logger: console }) : null,
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
    ].filter(Boolean);

    await Promise.all(
      packs
        .map((p: any) =>
          typeof p?.onActivate === 'function'
            ? p.onActivate({ logger: console, getSecret: () => undefined })
            : null
        )
        .filter(Boolean),
    );

    allTools = packs
      .flatMap((p: any) => (p?.descriptors || []).filter((d: { kind: string }) => d?.kind === 'tool').map((d: { payload: unknown }) => d.payload))
      .filter(Boolean) as ToolInstance[];

    preloadedPackages.push(
      '@framers/agentos-ext-cli-executor',
      '@framers/agentos-ext-web-search',
      '@framers/agentos-ext-web-browser',
      '@framers/agentos-ext-giphy',
      '@framers/agentos-ext-image-search',
      '@framers/agentos-ext-voice-synthesis',
      '@framers/agentos-ext-news-search',
    );
    if (skillsExt) preloadedPackages.push('@framers/agentos-ext-skills');
  }

  // In server mode we can't prompt for approvals. Expose only tools that are
  // executable without Tier 3 HITL unless the user explicitly opts into
  // fully-autonomous mode (`--yes` / `--dangerously-skip-permissions`).
  const headlessAuthManager = autoApproveToolCalls
    ? undefined
    : createAuthorizationManager({ dangerouslySkipPermissions: false });

  const tools: ToolInstance[] = autoApproveToolCalls
    ? allTools
    : allTools.filter((tool) => {
        // Extra conservative: never expose side-effecting tools in headless mode.
        if (tool.hasSideEffects === true) return false;
        const tier = headlessAuthManager!.getRiskTier({
          tool: {
            id: tool.name,
            displayName: tool.name,
            description: tool.description,
            category: tool.category,
            hasSideEffects: tool.hasSideEffects ?? false,
            requiredCapabilities: tool.requiredCapabilities,
          },
          args: {},
          context: { userId: 'server', sessionId: 'server', gmiId: seed.seedId },
          timestamp: new Date(),
        });
        return tier !== ToolRiskTier.TIER_3_SYNC_HITL;
      });

  const toolMap = new Map<string, ToolInstance>();
  for (const tool of tools) {
    if (!tool?.name) continue;
    toolMap.set(tool.name, tool);
  }
  // Schema-on-demand meta tools only make sense when tool calls can actually run.
  if (autoApproveToolCalls) {
    for (const meta of createSchemaOnDemandTools({
      toolMap,
      runtimeDefaults: {
        workingDirectory: process.cwd(),
        headlessBrowser: true,
        dangerouslySkipCommandSafety,
        agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
      },
      initialEnabledPackages: preloadedPackages,
      logger: console,
    })) {
      toolMap.set(meta.name, meta);
    }
  }

  // Skills — load from filesystem dirs + config-declared skills
  let skillsPrompt = '';
  if (enableSkills) {
    const parts: string[] = [];

    // 1. Directory-based skills (local ./skills/ dirs, --skills-dir flag)
    const skillRegistry = new SkillRegistry();
    const dirs = resolveDefaultSkillsDirs({
      cwd: process.cwd(),
      skillsDirFlag: typeof flags['skills-dir'] === 'string' ? flags['skills-dir'] : undefined,
    });
    if (dirs.length > 0) {
      await skillRegistry.loadFromDirs(dirs);
      const snapshot = skillRegistry.buildSnapshot({ platform: process.platform, strict: true });
      if (snapshot.prompt) parts.push(snapshot.prompt);
    }

    // 2. Config-declared skills (from agent.config.json "skills" array)
    if (Array.isArray(cfg.skills) && cfg.skills.length > 0) {
      try {
        const { resolveSkillsByNames } = await import('../../core/PresetSkillResolver.js');
        const presetSnapshot = await resolveSkillsByNames(cfg.skills as string[]);
        if (presetSnapshot.prompt) parts.push(presetSnapshot.prompt);
      } catch { /* non-fatal — registry package may not be installed */ }
    }

    skillsPrompt = parts.filter(Boolean).join('\n\n');
  }

  const systemPrompt = [
    typeof seed.baseSystemPrompt === 'string' ? seed.baseSystemPrompt : String(seed.baseSystemPrompt),
    'You are a local Wunderland agent server.',
    autoApproveToolCalls
      ? (lazyTools
        ? 'Use extensions_list + extensions_enable to load tools on demand (schema-on-demand).'
        : 'You can use tools to read/write files, run shell commands, and browse the web.')
      : 'You can use tools, but high-risk tools (filesystem, shell, and other side effects) are disabled in this mode.',
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
  fmt.kvPair('Tools', `${toolMap.size} loaded`);
  fmt.kvPair('Authorization', autoApproveToolCalls ? wColor('fully autonomous (all auto-approved)') : sColor('tiered (safe tools only)'));
  if (isOllamaProvider) {
    fmt.kvPair('Ollama', sColor('http://localhost:11434'));
  }
  fmt.blank();
  fmt.ok(`Health: ${iColor(`http://localhost:${port}/health`)}`);
  fmt.ok(`Chat:   ${iColor(`POST http://localhost:${port}/chat`)}`);
  fmt.blank();
}
