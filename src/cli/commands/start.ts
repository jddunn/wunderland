/**
 * @fileoverview `wunderland start` — start local agent server.
 * Ported from bin/wunderland.js cmdStart() with colored output.
 * @module wunderland/cli/commands/start
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, info as iColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../config/workspace.js';
import { isOllamaRunning, startOllama, detectOllamaInstall } from '../ollama/ollama-manager.js';
import { SkillRegistry, resolveDefaultSkillsDirs } from '../../skills/index.js';
import { runToolCallingTurn, safeJsonStringify, type ToolInstance, type LLMProviderConfig } from '../openai/tool-calling.js';
import { createSchemaOnDemandTools } from '../openai/schema-on-demand.js';
import { startWunderlandOtel, shutdownWunderlandOtel } from '../observability/otel.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
} from '../security/runtime-policy.js';
import { createEnvSecretResolver } from '../security/env-secrets.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../../core/index.js';
import { HumanInteractionManager } from '@framers/agentos';

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
  const description = String(cfg.bio || 'Autonomous Wunderbot');
  const p = cfg.personality || {};
  const policy = normalizeRuntimePolicy(cfg);
  const permissions = getPermissionsForSet(policy.permissionSet);
  const turnApprovalMode = (() => {
    const raw = (cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl))
      ? (cfg.hitl as any).turnApprovalMode ?? (cfg.hitl as any).turnApproval
      : undefined;
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (v === 'after-each-turn') return 'after-each-turn';
    if (v === 'after-each-round') return 'after-each-round';
    return 'off';
  })();

  // Observability (OTEL) is opt-in, and config can override env.
  const cfgOtelEnabled = cfg?.observability?.otel?.enabled;
  if (typeof cfgOtelEnabled === 'boolean') {
    process.env['WUNDERLAND_OTEL_ENABLED'] = cfgOtelEnabled ? 'true' : 'false';
  }
  const cfgOtelLogsEnabled = cfg?.observability?.otel?.exportLogs;
  if (typeof cfgOtelLogsEnabled === 'boolean') {
    process.env['WUNDERLAND_OTEL_LOGS_ENABLED'] = cfgOtelLogsEnabled ? 'true' : 'false';
  }

  await startWunderlandOtel({ serviceName: `wunderbot-${seedId}` });

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

  // Resolve provider/model from config (fallbacks preserve legacy env behavior).
  const providerFlag = typeof flags['provider'] === 'string' ? String(flags['provider']).trim() : '';
  const providerFromConfig = typeof cfg.llmProvider === 'string' ? String(cfg.llmProvider).trim() : '';
  const providerId = (flags['ollama'] === true ? 'ollama' : (providerFlag || providerFromConfig || 'openai')).toLowerCase();
  if (!new Set(['openai', 'openrouter', 'ollama', 'anthropic']).has(providerId)) {
    fmt.errorBlock(
      'Unsupported LLM provider',
      `Provider "${providerId}" is not supported by this CLI runtime.\nSupported: openai, openrouter, ollama, anthropic`,
    );
    process.exitCode = 1;
    return;
  }

  const modelFromConfig = typeof cfg.llmModel === 'string' ? String(cfg.llmModel).trim() : '';
  const model = typeof flags['model'] === 'string'
    ? String(flags['model'])
    : (modelFromConfig || (process.env['OPENAI_MODEL'] || 'gpt-4o-mini'));

  // Auto-start Ollama if configured as provider
  const isOllamaProvider = providerId === 'ollama';
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

  // OpenRouter fallback — when OPENROUTER_API_KEY is set, use it as automatic fallback
  const openrouterApiKey = process.env['OPENROUTER_API_KEY'] || '';
  const openrouterFallback: LLMProviderConfig | undefined = openrouterApiKey
    ? {
        apiKey: openrouterApiKey,
        model: typeof flags['openrouter-model'] === 'string' ? flags['openrouter-model'] : 'auto',
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: { 'HTTP-Referer': 'https://wunderland.sh', 'X-Title': 'Wunderbot' },
      }
    : undefined;

  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const dangerouslySkipCommandSafety =
    flags['dangerously-skip-command-safety'] === true || dangerouslySkipPermissions;
  const autoApproveToolCalls =
    globals.yes || dangerouslySkipPermissions || policy.executionMode === 'autonomous';
  const enableSkills = flags['no-skills'] !== true;
  const lazyTools = flags['lazy-tools'] === true || cfg?.lazyTools === true;
  const workspaceBaseDir = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(seedId);

  const llmBaseUrl =
    providerId === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : providerId === 'ollama' ? 'http://localhost:11434/v1'
    : undefined;
  const llmApiKey =
    providerId === 'openrouter' ? openrouterApiKey
    : providerId === 'ollama' ? 'ollama'
    : providerId === 'openai' ? (process.env['OPENAI_API_KEY'] || '')
    : providerId === 'anthropic' ? (process.env['ANTHROPIC_API_KEY'] || '')
    : (process.env['OPENAI_API_KEY'] || '');

  const canUseLLM =
    providerId === 'ollama'
      ? true
      : providerId === 'openrouter'
        ? !!openrouterApiKey
        : providerId === 'anthropic'
          ? !!process.env['ANTHROPIC_API_KEY']
          : !!llmApiKey || !!openrouterFallback;

  const preloadedPackages: string[] = [];
  let allTools: ToolInstance[] = [];
  const hitlSecret = (() => {
    const fromCfg = (cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl))
      ? String((cfg.hitl as any).secret || '').trim()
      : '';
    const fromEnv = String(process.env['WUNDERLAND_HITL_SECRET'] || '').trim();
    return fromCfg || fromEnv || randomUUID();
  })();
  const sseClients = new Set<import('node:http').ServerResponse>();

  async function broadcastHitlUpdate(payload: Record<string, unknown>): Promise<void> {
    const data = JSON.stringify(payload);
    for (const client of Array.from(sseClients)) {
      try {
        client.write(`event: hitl\ndata: ${data}\n\n`);
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
    // Load extensions dynamically from agent.config.json or use defaults
    const extensionsFromConfig = cfg.extensions;
    let toolExtensions: string[] = [];
    let voiceExtensions: string[] = [];
    let productivityExtensions: string[] = [];

    if (extensionsFromConfig) {
      // Load from config if present
      toolExtensions = extensionsFromConfig.tools || [];
      voiceExtensions = extensionsFromConfig.voice || [];
      productivityExtensions = extensionsFromConfig.productivity || [];
      fmt.note(`Loading ${toolExtensions.length + voiceExtensions.length + productivityExtensions.length} extensions from config...`);
    } else {
      // Fall back to hardcoded defaults if no extensions field
      toolExtensions = ['cli-executor', 'web-search', 'web-browser', 'giphy', 'image-search', 'news-search'];
      voiceExtensions = ['voice-synthesis'];
      productivityExtensions = [];
      fmt.note('No extensions configured, using defaults...');
    }

    // Resolve extensions to manifests using PresetExtensionResolver
    try {
      const { resolveExtensionsByNames } = await import('../../core/PresetExtensionResolver.js');
      const configOverrides = (cfg?.extensionOverrides && typeof cfg.extensionOverrides === 'object')
        ? (cfg.extensionOverrides as Record<string, any>)
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
        'web-browser': { options: { headless: true } },
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

      const cfgSecrets = (cfg?.secrets && typeof cfg.secrets === 'object' && !Array.isArray(cfg.secrets))
        ? (cfg.secrets as Record<string, string>)
        : undefined;
      const getSecret = createEnvSecretResolver({ configSecrets: cfgSecrets });
      const secrets = new Proxy<Record<string, string>>({} as any, {
        get: (_target, prop) => (typeof prop === 'string' ? getSecret(prop) : undefined),
      });

      const resolved = await resolveExtensionsByNames(
        toolExtensions,
        voiceExtensions,
        productivityExtensions,
        mergedOverrides,
        { secrets: secrets as any }
      );

      const packs: any[] = [];

      for (const packEntry of resolved.manifest.packs) {
        if ((packEntry as any)?.enabled === false) continue;

        try {
          if (typeof (packEntry as any)?.factory === 'function') {
            const pack = await (packEntry as any).factory();
            if (pack) {
              packs.push(pack);
              if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
            }
            continue;
          }

          // Back-compat for manifests that still emit {package}/{module} resolvers.
          let packageName: string | undefined;
          if ('package' in (packEntry as any)) packageName = (packEntry as any).package as string;
          else if ('module' in (packEntry as any)) packageName = (packEntry as any).module as string;
          if (!packageName) continue;

          const extModule = await import(packageName);
          const factory = extModule.createExtensionPack ?? extModule.default?.createExtensionPack ?? extModule.default;
          if (typeof factory !== 'function') {
            fmt.warning(`Extension ${packageName} does not export createExtensionPack`);
            continue;
          }
          const options: any = (packEntry as any).options || {};
          const pack = await factory({ options, logger: console, getSecret });
          packs.push(pack);
          if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fmt.warning(`Failed to load extension pack: ${msg}`);
        }
      }

      // Optional skills extension (may not be installed in standalone builds)
      try {
        const skillsPkg = '@framers/agentos-ext-skills';
        const skillsExt: any = await import(/* webpackIgnore: true */ skillsPkg);
        if (skillsExt?.createExtensionPack) {
          packs.push(skillsExt.createExtensionPack({ options: {}, logger: console, getSecret }));
          preloadedPackages.push(skillsPkg);
        }
      } catch {
        // Not available — skip silently
      }

      // Activate all packs
      await Promise.all(
        packs
          .map((p: any) =>
            typeof p?.onActivate === 'function'
              ? p.onActivate({ logger: console, getSecret })
              : null
          )
          .filter(Boolean),
      );

      // Extract tools from packs
      allTools = packs
        .flatMap((p: any) => (p?.descriptors || []).filter((d: { kind: string }) => d?.kind === 'tool').map((d: { payload: unknown }) => d.payload))
        .filter(Boolean) as ToolInstance[];

      fmt.ok(`Loaded ${allTools.length} tools from ${packs.length} extensions`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fmt.warning(`Extension loading failed, using empty toolset: ${msg}`);
    }
  }

  const toolMap = new Map<string, ToolInstance>();
  for (const tool of allTools) {
    if (!tool?.name) continue;
    toolMap.set(tool.name, tool);
  }
  // Schema-on-demand meta tools (always available; policy-filtered below).
  for (const meta of createSchemaOnDemandTools({
    toolMap,
    runtimeDefaults: {
      workingDirectory: process.cwd(),
      headlessBrowser: true,
      dangerouslySkipCommandSafety,
      agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    },
    initialEnabledPackages: preloadedPackages,
    allowPackages: true,
    logger: console,
  })) {
    toolMap.set(meta.name, meta);
  }

  // Enforce tool access profile + permission set so the model only sees allowed tools.
  const filtered = filterToolMapByPolicy({
    toolMap,
    toolAccessProfile: policy.toolAccessProfile,
    permissions,
  });
  toolMap.clear();
  for (const [k, v] of filtered.toolMap.entries()) toolMap.set(k, v);

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
    'You are a local Wunderbot server.',
    lazyTools
      ? 'Use extensions_list + extensions_enable to load tools on demand (schema-on-demand).'
      : 'Tools are preloaded, and you can also use extensions_enable to load additional packs on demand.',
    `Execution mode: ${policy.executionMode}. Permission set: ${policy.permissionSet}. Tool access profile: ${policy.toolAccessProfile}.`,
    autoApproveToolCalls
      ? 'All tool calls are auto-approved (fully autonomous mode).'
      : 'Tool calls that have side effects may require operator approval (HITL).',
    turnApprovalMode !== 'off'
      ? `Turn checkpoints: ${turnApprovalMode}.`
      : '',
    skillsPrompt || '',
  ].filter(Boolean).join('\n\n');

  const sessions = new Map<string, Array<Record<string, unknown>>>();

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
            Connection: 'keep-alive',
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
            askPermission: async (tool: ToolInstance, args: Record<string, unknown>) => {
              if (autoApproveToolCalls) return true;

              const preview = safeJsonStringify(args, 1800);
              const effectLabel = tool.hasSideEffects === true ? 'side effects' : 'read-only';
              const actionId = `tool-${seedId}-${randomUUID()}`;
              const decision = await hitlManager.requestApproval({
                actionId,
                description: `Allow ${tool.name} (${effectLabel})?\n\n${preview}`,
                severity: tool.hasSideEffects === true ? 'high' : 'low',
                category: toAgentosApprovalCategory(tool),
                agentId: seed.seedId,
                context: { toolName: tool.name, args, sessionId },
                reversible: tool.hasSideEffects !== true,
                requestedAt: new Date(),
                timeoutMs: 5 * 60_000,
              } as any);
              return decision.approved === true;
            },
            askCheckpoint: turnApprovalMode === 'off' ? undefined : async ({ round, toolCalls }) => {
              if (autoApproveToolCalls) return true;

              const checkpointId = `checkpoint-${seedId}-${sessionId}-${round}-${randomUUID()}`;
              const completedWork = toolCalls.map((c) => {
                const effect = c.hasSideEffects ? 'side effects' : 'read-only';
                const preview = safeJsonStringify(c.args, 800);
                return `${c.toolName} (${effect})\n${preview}`;
              });

              const timeoutMs = 5 * 60_000;
              const checkpointPromise = hitlManager.checkpoint({
                checkpointId,
                workflowId: `chat-${sessionId}`,
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
            onFallback: (err, provider) => {
              console.warn(`[fallback] Primary provider failed (${err.message}), routing to ${provider}`);
            },
          });
        } else {
          reply =
            'No LLM credentials configured. I can run, but I cannot generate real replies yet.\n\n' +
            'Set an API key in .env (OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY) or use Ollama, then retry.\n\n' +
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

  // Best-effort OTEL shutdown on exit.
  const handleExit = async () => {
    try {
      await shutdownWunderlandOtel();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void handleExit());
  process.once('SIGTERM', () => void handleExit());

  // Status display
  fmt.section('Agent Server Running');
  fmt.kvPair('Agent', accent(displayName));
  fmt.kvPair('Seed ID', seedId);
  fmt.kvPair('LLM Provider', providerId);
  fmt.kvPair('Model', model);
  fmt.kvPair('API Key', canUseLLM ? sColor('configured') : wColor('not set'));
  if (providerId === 'openai' && openrouterFallback) {
    fmt.kvPair('Fallback', sColor('OpenRouter (auto)'));
  }
  fmt.kvPair('Port', String(port));
  fmt.kvPair('Tools', `${toolMap.size} loaded`);
  fmt.kvPair(
    'Authorization',
    autoApproveToolCalls
      ? wColor('fully autonomous (all auto-approved)')
      : policy.executionMode === 'human-all'
        ? sColor('human-all (approve every tool call)')
        : sColor('human-dangerous (approve Tier 3 tools)'),
  );
  if (!autoApproveToolCalls) {
    fmt.kvPair('HITL Secret', accent(hitlSecret));
    if (turnApprovalMode !== 'off') fmt.kvPair('Turn Checkpoints', sColor(turnApprovalMode));
  }
  if (isOllamaProvider) {
    fmt.kvPair('Ollama', sColor('http://localhost:11434'));
  }
  fmt.blank();
  fmt.ok(`Health: ${iColor(`http://localhost:${port}/health`)}`);
  fmt.ok(`Chat:   ${iColor(`POST http://localhost:${port}/chat`)}`);
  fmt.ok(`HITL:   ${iColor(`http://localhost:${port}/hitl`)}`);
  if (!autoApproveToolCalls) {
    fmt.note(`CLI HITL: ${accent(`wunderland hitl watch --server http://localhost:${port} --secret ${hitlSecret}`)}`);
  }
  fmt.blank();
}
