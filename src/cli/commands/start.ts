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
import { verifySealedConfig } from '../seal-utils.js';
import { createEnvSecretResolver } from '../security/env-secrets.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../../core/index.js';
import { HumanInteractionManager, type ChannelMessage, type IChannelAdapter } from '@framers/agentos';
import { PairingManager } from '../../pairing/PairingManager.js';
import { WunderlandDiscoveryManager, type WunderlandDiscoveryConfig } from '../../discovery/index.js';

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

function extractChatSecret(req: import('node:http').IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-chat-secret');
  if (fromHeader) return fromHeader;
  const fromQuery = (url.searchParams.get('chat_secret') || url.searchParams.get('secret') || '').trim();
  return fromQuery;
}

function isChatAuthorized(req: import('node:http').IncomingMessage, url: URL, chatSecret: string): boolean {
  if (!chatSecret) return true;
  return extractChatSecret(req, url) === chatSecret;
}

function extractFeedSecret(req: import('node:http').IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-feed-secret');
  if (fromHeader) return fromHeader;
  const fromQuery = (url.searchParams.get('feed_secret') || '').trim();
  return fromQuery;
}

function isFeedAuthorized(req: import('node:http').IncomingMessage, url: URL, feedSecret: string): boolean {
  if (!feedSecret) return true;
  return extractFeedSecret(req, url) === feedSecret;
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

  const configDir = path.dirname(configPath);
  const sealedPath = path.join(configDir, 'sealed.json');

  let configRaw = '';
  try {
    configRaw = await readFile(configPath, 'utf8');
  } catch (err) {
    fmt.errorBlock('Read failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (existsSync(sealedPath)) {
    let sealedRaw = '';
    try {
      sealedRaw = await readFile(sealedPath, 'utf8');
    } catch (err) {
      fmt.errorBlock('Read failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    const verification = verifySealedConfig({ configRaw, sealedRaw });
    if (!verification.ok) {
      fmt.errorBlock(
        'Seal verification failed',
        `${verification.error || 'Verification failed.'}\nRun: ${accent('wunderland verify-seal')}`,
      );
      process.exitCode = 1;
      return;
    }
    if (!verification.signaturePresent) {
      fmt.warning('Sealed config has no signature (hash-only verification).');
    }
  }

  let cfg: any;
  try {
    cfg = JSON.parse(configRaw);
  } catch (err) {
    fmt.errorBlock(
      'Invalid config file',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
    return;
  }
  const seedId = String(cfg.seedId || 'seed_local_agent');
  const displayName = String(cfg.displayName || 'My Agent');
  const description = String(cfg.bio || 'Autonomous Wunderbot');
  const p = cfg.personality || {};
  const policy = normalizeRuntimePolicy(cfg);
  const permissions = getPermissionsForSet(policy.permissionSet);
  const LOCAL_ONLY_CHANNELS = new Set<string>(['webchat']);
  const CLI_REQUIRED_CHANNELS = new Set<string>(['signal', 'zalouser']);
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
        fmt.note('Ollama is configured but not running - starting...');
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
    globals.autoApproveTools || dangerouslySkipPermissions || policy.executionMode === 'autonomous';
  const enableSkills = flags['no-skills'] !== true;
  const lazyTools = flags['lazy-tools'] === true || cfg?.lazyTools === true;
  const workspaceBaseDir = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(seedId);
  // Expose a stable workspace directory path for extension packs (channels/tools) that need
  // to persist lightweight state (rate limits, caches, etc.).
  try {
    const workspaceDir = path.join(workspaceBaseDir, workspaceAgentId);
    if (!process.env['WUNDERLAND_WORKSPACE_DIR']) process.env['WUNDERLAND_WORKSPACE_DIR'] = workspaceDir;
  } catch {
    // ignore
  }

  const ollamaBaseUrl = (() => {
    const raw = String(process.env['OLLAMA_BASE_URL'] || '').trim();
    const base = raw || 'http://localhost:11434';
    const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
    if (normalized.endsWith('/v1')) return normalized;
    return `${normalized}/v1`;
  })();

  const llmBaseUrl =
    providerId === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : providerId === 'ollama' ? ollamaBaseUrl
    : undefined;
  // Resolve auth method (OAuth or API key)
  const authMethod: 'api-key' | 'oauth' =
    (cfg.llmAuthMethod === 'oauth' || flags['oauth'] === true) && providerId === 'openai'
      ? 'oauth'
      : 'api-key';

  let llmApiKey: string;
  let oauthGetApiKey: (() => Promise<string>) | undefined;

  if (authMethod === 'oauth') {
    try {
      const { OpenAIOAuthFlow, FileTokenStore } = await import('@framers/agentos/auth');
      const flow = new OpenAIOAuthFlow({ tokenStore: new FileTokenStore() });
      // Verify we have stored tokens
      const initialKey = await flow.getAccessToken();
      llmApiKey = initialKey;
      oauthGetApiKey = () => flow.getAccessToken();
    } catch (err) {
      fmt.errorBlock(
        'OAuth authentication required',
        `Run ${accent('wunderland login')} to authenticate with your OpenAI subscription.`,
      );
      process.exitCode = 1;
      return;
    }
  } else {
    llmApiKey =
      providerId === 'openrouter' ? openrouterApiKey
      : providerId === 'ollama' ? 'ollama'
      : providerId === 'openai' ? (process.env['OPENAI_API_KEY'] || '')
      : providerId === 'anthropic' ? (process.env['ANTHROPIC_API_KEY'] || '')
      : (process.env['OPENAI_API_KEY'] || '');
  }

  const canUseLLM =
    authMethod === 'oauth'
      ? true
      : providerId === 'ollama'
        ? true
        : providerId === 'openrouter'
          ? !!openrouterApiKey
          : providerId === 'anthropic'
            ? !!process.env['ANTHROPIC_API_KEY']
            : !!llmApiKey || !!openrouterFallback;

  const preloadedPackages: string[] = [];
  let activePacks: any[] = [];
  let allTools: ToolInstance[] = [];
  type ExtensionHttpHandler = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => Promise<boolean> | boolean;
  const loadedChannelAdapters: IChannelAdapter[] = [];
  const loadedHttpHandlers: ExtensionHttpHandler[] = [];
  const hitlSecret = (() => {
    const fromCfg = (cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl))
      ? String((cfg.hitl as any).secret || '').trim()
      : '';
    const fromEnv = String(process.env['WUNDERLAND_HITL_SECRET'] || '').trim();
    return fromCfg || fromEnv || randomUUID();
  })();
  const chatSecret = (() => {
    const fromCfg = (cfg?.chat && typeof cfg.chat === 'object' && !Array.isArray(cfg.chat))
      ? String((cfg.chat as any).secret || '').trim()
      : '';
    const fromEnv = String(process.env['WUNDERLAND_CHAT_SECRET'] || '').trim();
    return fromCfg || fromEnv || '';
  })();
  const feedSecret = (() => {
    const fromEnv = String(process.env['WUNDERLAND_FEED_SECRET'] || '').trim();
    return fromEnv || chatSecret; // fall back to chat secret if no feed secret
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
        'wunderbot-feeds': {
          options: {
            feeds: (cfg as any)?.feeds ?? {},
          },
        },
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

      const channelsFromConfig = Array.isArray((cfg as any)?.channels)
        ? ((cfg as any).channels as unknown[])
        : Array.isArray((cfg as any)?.suggestedChannels)
          ? ((cfg as any).suggestedChannels as unknown[])
          : [];
      const channelsToLoad = Array.from(new Set(
        channelsFromConfig
          .map((v) => String(v ?? '').trim())
          .filter((v) => v.length > 0),
      ));

      const blockedChannels: Array<{ platform: string; reason: string }> = [];

      const allowedChannels = channelsToLoad.filter((platform) => {
        if (LOCAL_ONLY_CHANNELS.has(platform)) return true;
        if (permissions.network.externalApis !== true) {
          blockedChannels.push({ platform, reason: 'blocked_by_permission_set:network.externalApis=false' });
          return false;
        }
        if (CLI_REQUIRED_CHANNELS.has(platform) && permissions.system.cliExecution !== true) {
          blockedChannels.push({ platform, reason: 'blocked_by_permission_set:system.cliExecution=false' });
          return false;
        }
        return true;
      });

      if (blockedChannels.length > 0) {
        const list = blockedChannels.map((c) => c.platform).join(', ');
        fmt.warning(`Permission set blocks some configured channels - skipping: ${list}`);
      }

      const resolved = await resolveExtensionsByNames(
        toolExtensions,
        voiceExtensions,
        productivityExtensions,
        mergedOverrides,
        { secrets: secrets as any, channels: allowedChannels.length > 0 ? allowedChannels : 'none' }
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

      activePacks = packs;

      // Extract messaging-channel adapters (if any) for inbound/outbound channel runtime.
      const adapters = packs
        .flatMap((p: any) => (p?.descriptors || []))
        .filter((d: { kind?: string; payload?: unknown }) => d?.kind === 'messaging-channel')
        .map((d: { payload: unknown }) => d.payload)
        .filter(Boolean) as IChannelAdapter[];
      loadedChannelAdapters.push(...adapters);

      // Extract HTTP handlers from packs (e.g., webhook endpoints).
      const httpHandlers = packs
        .flatMap((p: any) => (p?.descriptors || []))
        .filter((d: { kind?: string; payload?: unknown }) => d?.kind === 'http-handler')
        .map((d: { payload: unknown }) => d.payload)
        .filter(Boolean) as ExtensionHttpHandler[];
      loadedHttpHandlers.push(...httpHandlers);

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

  // Capability discovery — semantic search + graph re-ranking
  const discoveryOpts: WunderlandDiscoveryConfig = {};
  if (cfg?.discovery) {
    const d = cfg.discovery as Record<string, unknown>;
    if (typeof d.enabled === 'boolean') discoveryOpts.enabled = d.enabled;
    if (typeof d.embeddingProvider === 'string') discoveryOpts.embeddingProvider = d.embeddingProvider;
    if (typeof d.embeddingModel === 'string') discoveryOpts.embeddingModel = d.embeddingModel;
    if (typeof d.scanManifests === 'boolean') discoveryOpts.scanManifestDirs = d.scanManifests;
    const budgetFields = { tier0Budget: 'tier0TokenBudget', tier1Budget: 'tier1TokenBudget', tier2Budget: 'tier2TokenBudget', tier1TopK: 'tier1TopK', tier2TopK: 'tier2TopK' } as const;
    const configOverrides: Record<string, number> = {};
    for (const [src, dest] of Object.entries(budgetFields)) {
      if (typeof d[src] === 'number') configOverrides[dest] = d[src] as number;
    }
    // Support tier1MinRelevance directly or via nested config object
    if (typeof d.tier1MinRelevance === 'number') configOverrides['tier1MinRelevance'] = d.tier1MinRelevance;
    if (typeof d.graphBoostFactor === 'number') configOverrides['graphBoostFactor'] = d.graphBoostFactor;
    // Merge nested config object (allows full CapabilityDiscoveryConfig overrides)
    if (d.config && typeof d.config === 'object' && !Array.isArray(d.config)) {
      for (const [k, v] of Object.entries(d.config as Record<string, unknown>)) {
        if (typeof v === 'number') configOverrides[k] = v;
        if (typeof v === 'boolean') (configOverrides as any)[k] = v;
      }
    }
    if (Object.keys(configOverrides).length > 0) discoveryOpts.config = configOverrides as any;
  }
  // Skills — load from filesystem dirs + config-declared skills (BEFORE discovery so we can pass entries)
  let skillsPrompt = '';
  const skillEntries: Array<{ name: string; description: string; content: string; category?: string; tags?: string[] }> = [];
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
      // Extract entries for discovery indexing
      if (typeof skillRegistry.listAll === 'function') {
        for (const entry of skillRegistry.listAll() as any[]) {
          const skill = entry.skill ?? entry;
          skillEntries.push({
            name: skill.name ?? 'unknown',
            description: skill.description ?? '',
            content: skill.content ?? '',
          });
        }
      }
    }

    // 2. Config-declared skills (from agent.config.json "skills" array)
    if (Array.isArray(cfg.skills) && cfg.skills.length > 0) {
      try {
        const { resolveSkillsByNames } = await import('../../core/PresetSkillResolver.js');
        const presetSnapshot = await resolveSkillsByNames(cfg.skills as string[]);
        if (presetSnapshot.prompt) parts.push(presetSnapshot.prompt);
        // Extract skill names for discovery
        if (Array.isArray(presetSnapshot.skills)) {
          const existing = new Set(skillEntries.map((e) => e.name));
          for (const skill of presetSnapshot.skills as any[]) {
            const name = typeof skill === 'string' ? skill : skill.name ?? 'unknown';
            if (!existing.has(name)) {
              skillEntries.push({ name, description: '', content: '' });
            }
          }
        }
      } catch { /* non-fatal — registry package may not be installed */ }
    }

    skillsPrompt = parts.filter(Boolean).join('\n\n');
  }

  // Discovery — initialized after skills so skillEntries can be indexed
  const discoveryManager = new WunderlandDiscoveryManager(discoveryOpts);
  try {
    await discoveryManager.initialize({
      toolMap,
      skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
      llmConfig: { providerId, apiKey: llmApiKey, baseUrl: llmBaseUrl },
    });
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, {
        name: metaTool.name,
        description: metaTool.description,
        inputSchema: metaTool.inputSchema as any,
        hasSideEffects: metaTool.hasSideEffects,
        category: 'productivity',
        execute: metaTool.execute as any,
      });
    }
    const stats = discoveryManager.getStats();
    if (stats.initialized) {
      fmt.ok(`Discovery: ${stats.capabilityCount} capabilities indexed, ${stats.graphEdges} graph edges`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.warning(`Discovery initialization failed (continuing without): ${msg}`);
  }

  const systemPrompt = [
    typeof seed.baseSystemPrompt === 'string' ? seed.baseSystemPrompt : String(seed.baseSystemPrompt),
    'You are a local Wunderbot server.',
    'If you are replying to an inbound channel message, respond with plain text. The runtime will deliver your final answer back to the same conversation. Do not call channel send tools unless you explicitly need to message a different conversation/channel.',
    lazyTools
      ? 'Use extensions_list + extensions_enable to load tools on demand (schema-on-demand).'
      : 'Tools are preloaded. You MUST use the provided tools for any query that needs real-time or external information (weather, news, web searches, current events, etc.). Never say you cannot access real-time data — call the appropriate tool instead.',
    `Execution mode: ${policy.executionMode}. Permission set: ${policy.permissionSet}. Tool access profile: ${policy.toolAccessProfile}.`,
    autoApproveToolCalls
      ? 'All tool calls are auto-approved (fully autonomous mode).'
      : 'Tool authorization is handled automatically by the runtime. Call tools freely — the system will handle any required approvals.',
    turnApprovalMode !== 'off'
      ? `Turn checkpoints: ${turnApprovalMode}.`
      : '',
    skillsPrompt || '',
  ].filter(Boolean).join('\n\n');

  const sessions = new Map<string, Array<Record<string, unknown>>>();
  const channelSessions = new Map<string, Array<Record<string, unknown>>>();
  const channelQueues = new Map<string, Promise<void>>();
  const channelUnsubs: Array<() => void> = [];
  const pairingEnabled = cfg?.pairing?.enabled !== false;
  const pairingGroupTrigger = (() => {
    const raw = (cfg as any)?.pairing?.groupTrigger;
    if (typeof raw === 'string') return raw.trim();
    return '!pair';
  })();
  const pairingGroupTriggerEnabled =
    pairingEnabled && !!pairingGroupTrigger && pairingGroupTrigger.toLowerCase() !== 'off';
  const pairing = new PairingManager({
    storeDir: path.join(workspaceBaseDir, workspaceAgentId, 'pairing'),
    pendingTtlMs: Number.isFinite(cfg?.pairing?.pendingTtlMs) ? cfg.pairing.pendingTtlMs : undefined,
    maxPending: Number.isFinite(cfg?.pairing?.maxPending) ? cfg.pairing.maxPending : undefined,
    codeLength: Number.isFinite(cfg?.pairing?.codeLength) ? cfg.pairing.codeLength : undefined,
  });

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

  // ── Channel Runtime (inbound/outbound) ────────────────────────────────────

  const adapterByPlatform = new Map<string, IChannelAdapter>();
  for (const adapter of loadedChannelAdapters) {
    const platform = (adapter as any)?.platform;
    if (typeof platform !== 'string' || !platform.trim()) continue;
    // Keep first adapter per platform (registry shouldn't load duplicates).
    if (!adapterByPlatform.has(platform)) adapterByPlatform.set(platform, adapter);
  }

  function enqueueChannelTurn(key: string, fn: () => Promise<void>): void {
    const prev = channelQueues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(fn)
      .catch((err) => {
        console.warn(`[channels] Turn failed for ${key}:`, err instanceof Error ? err.message : String(err));
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

  function getSenderLabel(m: ChannelMessage): string {
    const d = (m.sender && typeof m.sender === 'object') ? m.sender : ({} as any);
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

  async function sendChannelText(opts: {
    platform: string;
    conversationId: string;
    text: string;
    replyToMessageId?: string;
  }): Promise<void> {
    if (!isChannelAllowedByPolicy(opts.platform)) return;
    const adapter = adapterByPlatform.get(opts.platform);
    if (!adapter) return;

    const parts = chunkText(opts.text, 1800).filter((p) => p.trim().length > 0);
    for (const part of parts) {
      await adapter.sendMessage(opts.conversationId, {
        blocks: [{ type: 'text', text: part }],
        ...(opts.replyToMessageId ? { replyToMessageId: opts.replyToMessageId } : null),
      });
    }
  }

  async function handleInboundChannelMessage(message: ChannelMessage): Promise<void> {
    const platform = String(message.platform || '').trim();
    const conversationId = String(message.conversationId || '').trim();
    if (!platform || !conversationId) return;

    const text = String(message.text || '').trim();
    if (!text) return;

    const rawEvent = message.rawEvent;
    const rawMeta = rawEvent && typeof rawEvent === 'object' ? (rawEvent as any) : null;
    const explicitInvocation = rawMeta?.explicitInvocation === true;
    const explain = rawMeta?.explain === true;

    const senderId = String((message.sender as any)?.id || '').trim() || 'unknown';
    const isGroupPairingRequest = (() => {
      if (!pairingGroupTriggerEnabled) return false;
      if (message.conversationType === 'direct') return false;
      const t = text.trim();
      if (!t) return false;
      const trig = pairingGroupTrigger;
      const lowerT = t.toLowerCase();
      const lowerTrig = trig.toLowerCase();
      if (lowerT === lowerTrig) return true;
      if (lowerT.startsWith(`${lowerTrig} `)) return true;
      return false;
    })();

    // Pairing / allowlist guardrail (default: enabled).
    if (pairingEnabled) {
      const isAllowed = await pairing.isAllowed(platform, senderId);
      if (!isAllowed) {
        // Avoid spamming group channels with pairing prompts from random participants.
        if (message.conversationType !== 'direct' && !isGroupPairingRequest && !explicitInvocation) {
          return;
        }

        const meta: Record<string, string> = {
          sender: getSenderLabel(message),
          platform,
          conversationId,
        };

        const { code, created } = await pairing.upsertRequest(platform, senderId, meta);
        if (created) {
          void broadcastHitlUpdate({ type: 'pairing_request', platform, senderId, conversationId });
        }

        const prompt =
          code && code.trim()
            ? isGroupPairingRequest
              ? `Pairing requested.\n\nCode: ${code}\n\nAsk the assistant owner to approve this code.`
              : `Pairing required.\n\nCode: ${code}\n\nAsk the assistant owner to approve this code, then retry.`
            : 'Pairing queue is full. Ask the assistant owner to clear/approve pending requests, then retry.';

        await sendChannelText({ platform, conversationId, text: prompt, replyToMessageId: message.messageId });
        return;
      }
    }

    const sessionKey = `${platform}:${conversationId}`;
    // Explicit invocations (slash commands like /ask, /summarize, /deepdive) get a
    // fresh session each time to prevent stale conversation patterns from affecting
    // tool-calling behavior (e.g. model repeating "I don't have real-time data").
    let messages = explicitInvocation ? null : channelSessions.get(sessionKey);
    if (!messages) {
      messages = [{ role: 'system', content: systemPrompt }];
      channelSessions.set(sessionKey, messages);
    }

    // Soft cap to avoid unbounded memory.
    if (messages.length > 200) {
      messages = [messages[0]!, ...messages.slice(-120)];
      channelSessions.set(sessionKey, messages);
    }

    const userPrefix = message.conversationType === 'direct' ? '' : `[${getSenderLabel(message)}] `;
    messages.push({ role: 'user', content: `${userPrefix}${text}` });

    // Optional typing indicator while processing.
    try {
      const adapter = adapterByPlatform.get(platform);
      if (adapter) await adapter.sendTypingIndicator(conversationId, true);
    } catch {
      // ignore
    }

    const traceCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }> = [];

    // Capability discovery — inject tiered context AND build filtered tool set for this turn
    let discoveredToolNames: Set<string> | null = null;
    try {
      const discoveryResult = await discoveryManager.discoverForTurn(text);
      if (discoveryResult) {
        for (let i = messages.length - 1; i >= 1; i--) {
          if (typeof messages[i]?.content === 'string' && String(messages[i]!.content).startsWith('[Capability Context]')) {
            messages.splice(i, 1);
          }
        }
        const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
        if (discoveryResult.tier1.length > 0) {
          ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r) => r.summaryText).join('\n'));
        }
        if (discoveryResult.tier2.length > 0) {
          ctxParts.push(discoveryResult.tier2.map((r) => r.fullText).join('\n'));
        }
        messages.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });

        // Extract discovered tool names for filtered tool defs.
        // Send tier2 (top 3 semantic matches) plus always-on core tools.
        // The full toolMap is still passed for execution, so any tool can
        // still be called if the model requests it via discover_capabilities.
        const names = new Set<string>();
        for (const r of discoveryResult.tier2) {
          const capName = r.capability?.name;
          if (capName && r.capability?.kind === 'tool') {
            const toolName = r.capability.id?.startsWith('tool:') ? r.capability.id.slice(5) : capName;
            names.add(toolName);
          }
        }
        // Always include schema-on-demand meta tools and discover_capabilities
        for (const [name] of toolMap) {
          if (name.startsWith('extensions_') || name === 'discover_capabilities') names.add(name);
        }
        // Always include general-purpose search tools so the model can
        // look things up regardless of discovery ranking.
        const alwaysInclude = ['web_search', 'news_search'];
        for (const coreTool of alwaysInclude) {
          if (toolMap.has(coreTool)) names.add(coreTool);
        }
        if (names.size > 0) discoveredToolNames = names;
      }
    } catch {
      // Non-fatal
    }

    let reply = '';
    try {
      if (canUseLLM) {
        const toolContext = {
          gmiId: `wunderland-channel-${sessionKey}`,
          personaId: seed.seedId,
          userContext: {
            userId: senderId,
            platform,
            conversationId,
          },
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

        // Build filtered tool defs based on discovery (reduces context for small models)
        const filteredGetToolDefs = discoveredToolNames
          ? () => {
            const filtered: Array<Record<string, unknown>> = [];
            for (const [name, tool] of toolMap) {
              if (discoveredToolNames!.has(name)) {
                filtered.push({
                  type: 'function',
                  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
                });
              }
            }
            return filtered;
          }
          : undefined;

        // Debug: log messages and tool names being sent to LLM
        const toolNames = filteredGetToolDefs
          ? filteredGetToolDefs().map((t: any) => t?.function?.name).filter(Boolean)
          : [...toolMap.keys()];
        console.log(`[channel-llm] Sending ${messages.length} messages, ${toolNames.length} tools: [${toolNames.join(', ')}]`);
        for (const m of messages) {
          const role = String(m.role || '');
          const content = String(m.content || '').slice(0, 120);
          console.log(`[channel-llm]   ${role}: ${content}`);
        }

        reply = await runToolCallingTurn({
          providerId,
          apiKey: llmApiKey,
          model,
          messages,
          toolMap,
          ...(filteredGetToolDefs && { getToolDefs: filteredGetToolDefs }),
          toolContext,
          maxRounds: 8,
          dangerouslySkipPermissions,
          onToolCall: (tool: ToolInstance, args: Record<string, unknown>) => {
            if (!explain) return;
            try {
              traceCalls.push({
                toolName: String((tool as any)?.name || 'unknown'),
                hasSideEffects: (tool as any)?.hasSideEffects === true,
                args: args || {},
              });
            } catch {
              // ignore
            }
          },
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
              context: { toolName: tool.name, args, sessionId: sessionKey, platform, conversationId },
              reversible: tool.hasSideEffects !== true,
              requestedAt: new Date(),
              timeoutMs: 5 * 60_000,
            } as any);
            return decision.approved === true;
          },
          askCheckpoint: turnApprovalMode === 'off' ? undefined : async ({ round, toolCalls }) => {
            if (autoApproveToolCalls) return true;

            const checkpointId = `checkpoint-${seedId}-${sessionKey}-${round}-${randomUUID()}`;
            const completedWork = toolCalls.map((c) => {
              const effect = c.hasSideEffects ? 'side effects' : 'read-only';
              const preview = safeJsonStringify(c.args, 800);
              return `${c.toolName} (${effect})\n${preview}`;
            });

            const timeoutMs = 5 * 60_000;
            const checkpointPromise = hitlManager.checkpoint({
              checkpointId,
              workflowId: `channel-${sessionKey}`,
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
          getApiKey: oauthGetApiKey,
        });
      } else {
        reply = `No LLM credentials configured. You said: ${text}`;
        messages.push({ role: 'assistant', content: reply });
      }
    } finally {
      try {
        const adapter = adapterByPlatform.get(platform);
        if (adapter) await adapter.sendTypingIndicator(conversationId, false);
      } catch {
        // ignore
      }
    }

    if (typeof reply === 'string' && reply.trim()) {
      // Strip <think>...</think> blocks from models like qwen3 that expose thinking tokens.
      let cleanReply = reply.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      cleanReply = cleanReply.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();
      if (cleanReply) {
        await sendChannelText({ platform, conversationId, text: cleanReply, replyToMessageId: message.messageId });
      }
    }

    if (explain) {
      const redact = (value: unknown, depth: number): unknown => {
        if (depth <= 0) return '[truncated]';
        if (value === null || value === undefined) return value;
        if (typeof value === 'string') {
          const t = value.trim();
          return t.length > 200 ? `${t.slice(0, 200)}…` : t;
        }
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth - 1));
        if (typeof value === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const key = String(k);
            if (/(api[-_]?key|token|secret|password|auth)/i.test(key)) {
              out[key] = '[REDACTED]';
            } else {
              out[key] = redact(v, depth - 1);
            }
          }
          return out;
        }
        return String(value);
      };

      const maxCalls = 8;
      const shown = traceCalls.slice(0, maxCalls);
      const lines: string[] = [];
      for (const c of shown) {
        const effect = c.hasSideEffects ? 'side effects' : 'read-only';
        const argsPreview = safeJsonStringify(redact(c.args, 4), 700);
        lines.push(`- ${c.toolName} (${effect}) ${argsPreview}`);
      }
      if (traceCalls.length > maxCalls) {
        lines.push(`- … +${traceCalls.length - maxCalls} more`);
      }
      const traceText = lines.length > 0
        ? `Tool trace (what I called):\n${lines.join('\n')}`
        : 'Tool trace: (no tool calls)';

      await sendChannelText({ platform, conversationId, text: traceText, replyToMessageId: message.messageId });
    }
  }

  // ── Founders Extension Integration (Discord) ──────────────────────────────
  // If the Founders extension was loaded, wire its interaction handler and
  // slash commands into the Discord adapter.
  {
    const foundersPack = activePacks.find(
      (p: any) => p?.name === '@framers/agentos-ext-founders',
    ) as any;
    const discordAdapter = adapterByPlatform.get('discord') as any;

    if (foundersPack?.metadata && discordAdapter) {
      try {
        // Read founders channel config from agent.config.json feeds.founders.
        const foundersChannels = cfg?.feeds?.founders as Record<string, string> | undefined;

        // Register slash command definitions with the Discord service.
        const slashCommands = foundersPack.metadata.slashCommands;
        if (slashCommands?.length && discordAdapter.service?.registerSlashCommands) {
          discordAdapter.service.registerSlashCommands(slashCommands);
        }

        // Create the interaction handler (pass channel IDs from agent config) and register it.
        if (typeof foundersPack.metadata.createHandler === 'function') {
          const handler = foundersPack.metadata.createHandler(foundersChannels);
          if (typeof discordAdapter.registerExternalInteractionHandler === 'function') {
            discordAdapter.registerExternalInteractionHandler(
              handler.handleInteraction,
            );
          }
          // Set up the welcome post after a short delay (give Discord gateway time).
          if (typeof handler.ensureWelcomePost === 'function') {
            const client = discordAdapter.service?.getClient?.();
            if (client) {
              setTimeout(() => {
                handler.ensureWelcomePost(client).catch((err: Error) => {
                  console.warn('[Founders] Welcome post setup failed:', err.message);
                });
              }, 5000);
            }
          }
          fmt.ok('Founders extension integrated with Discord adapter');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fmt.warning(`Founders extension integration failed: ${msg}`);
      }
    }
  }

  if (adapterByPlatform.size > 0) {
    for (const [platform, adapter] of adapterByPlatform.entries()) {
      if (!isChannelAllowedByPolicy(platform)) continue;
      try {
        const unsub = adapter.on(async (event: any) => {
          if (!event || event.type !== 'message') return;
          const data = event.data as ChannelMessage;
          if (!data) return;
          const key = `${platform}:${String(data.conversationId || '').trim()}`;
          enqueueChannelTurn(key, async () => {
            await handleInboundChannelMessage(data);
          });
        }, ['message']);
        channelUnsubs.push(unsub);
      } catch (err) {
        console.warn(`[channels] Failed to subscribe to ${platform} adapter:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Wunderland-HITL-Secret, X-Wunderland-Chat-Secret, X-Wunderland-Feed-Secret',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname.startsWith('/pairing')) {
        if (req.method === 'GET' && url.pathname === '/pairing') {
          const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wunderland Pairing</title>
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
      .meta { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
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
      <h1>Wunderland Pairing</h1>
      <div class="meta">
        <span class="pill">Server: <span id="server"></span></span>
        <span class="pill">Stream: <span id="streamStatus">disconnected</span></span>
        <span class="pill">Pairing: <span id="pairingStatus">enabled</span></span>
      </div>
    </header>
    <main>
      <div class="card">
        <h2>Admin Secret</h2>
        <div class="meta">
          <input id="secret" placeholder="Paste x-wunderland-hitl-secret" />
          <button id="connect" class="ok">Connect</button>
          <span class="status" id="hint"></span>
        </div>
        <div class="note" style="margin-top:10px">
          Unknown senders in direct messages receive a pairing code automatically. In group/channel chats, send the pairing trigger (default <code>!pair</code>) to request one.
        </div>
      </div>

      <div class="card">
        <h2>Security</h2>
        <div class="note">
          <div><strong>Treat the secret like a password.</strong> This server binds to <code>0.0.0.0</code> by default.</div>
          <ul>
            <li>Don’t share URLs containing <code>?secret=...</code> (they can end up in browser history/logs).</li>
            <li>This UI stores the secret in localStorage (<code>wunderland_hitl_secret</code>). Clear site data to forget it.</li>
            <li>Set a stable secret via <code>agent.config.json</code> → <code>hitl.secret</code> or <code>WUNDERLAND_HITL_SECRET</code> (restart to rotate).</li>
            <li>Remote ops: use SSH port-forwarding (example: <code>ssh -L 3777:localhost:3777 you@host</code>).</li>
            <li>Approve pairing only for people you trust (it grants the sender access to the agent).</li>
          </ul>
          <div style="margin-top:10px">Tip: run <code>wunderland help security</code> for the full model.</div>
        </div>
      </div>

      <div class="row">
        <div class="card">
          <h2>Pending Requests</h2>
          <div id="requests" class="status">Loading...</div>
        </div>
        <div class="card">
          <h2>Allowlist</h2>
          <div id="allowlist" class="status">Loading...</div>
        </div>
      </div>
    </main>
    <script>
      const server = window.location.origin;
      const serverEl = document.getElementById('server');
      const streamStatus = document.getElementById('streamStatus');
      const pairingStatus = document.getElementById('pairingStatus');
      const secretInput = document.getElementById('secret');
      const hint = document.getElementById('hint');
      const requestsEl = document.getElementById('requests');
      const allowEl = document.getElementById('allowlist');
      serverEl.textContent = server;

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
            div.innerHTML = \`
              <div class=\"title\">
                <div><strong>\${esc(r.code || '')}</strong></div>
                <div class=\"id\">\${esc(r.id || '')}</div>
              </div>
              <div class=\"desc\">\${esc(JSON.stringify(r.meta || {}, null, 2))}</div>
              <div class=\"btns\">
                <button class=\"ok\">Approve</button>
                <button class=\"bad\">Reject</button>
              </div>\`;
            const [approveBtn, rejectBtn] = div.querySelectorAll('button');
            approveBtn.onclick = async () => { await api('/pairing/approve', 'POST', { channel: ch, code: r.code }); await refresh(); };
            rejectBtn.onclick = async () => { await api('/pairing/reject', 'POST', { channel: ch, code: r.code }); await refresh(); };
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
          div.innerHTML = '<div class=\"desc\">' + esc(list.join('\\n') || '(empty)') + '</div>';
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
        } catch (e) {
          requestsEl.innerHTML = '<div class=\"status\">Paste the admin secret to view pairing requests.</div>';
          allowEl.innerHTML = '';
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

        const channels = Array.from(adapterByPlatform.keys());

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
            <li>This UI uses <code>?secret=...</code> for API calls/streaming; don’t share or screenshot URLs with the secret.</li>
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
        if (!isChatAuthorized(req, url, chatSecret)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }

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

          // Capability discovery — inject tiered context AND build filtered tool set
          let apiDiscoveredToolNames: Set<string> | null = null;
          try {
            const discoveryResult = await discoveryManager.discoverForTurn(message);
            if (discoveryResult) {
              for (let i = messages.length - 1; i >= 1; i--) {
                if (typeof messages[i]?.content === 'string' && String(messages[i]!.content).startsWith('[Capability Context]')) {
                  messages.splice(i, 1);
                }
              }
              const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
              if (discoveryResult.tier1.length > 0) {
                ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r) => r.summaryText).join('\n'));
              }
              if (discoveryResult.tier2.length > 0) {
                ctxParts.push(discoveryResult.tier2.map((r) => r.fullText).join('\n'));
              }
              messages.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });

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
              for (const [name] of toolMap) {
                if (name.startsWith('extensions_') || name === 'discover_capabilities') names.add(name);
              }
              if (names.size > 0) apiDiscoveredToolNames = names;
            }
          } catch {
            // Non-fatal
          }

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

          // Build filtered tool defs based on discovery
          const apiFilteredGetToolDefs = apiDiscoveredToolNames
            ? () => {
              const filtered: Array<Record<string, unknown>> = [];
              for (const [name, tool] of toolMap) {
                if (apiDiscoveredToolNames!.has(name)) {
                  filtered.push({
                    type: 'function',
                    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
                  });
                }
              }
              return filtered;
            }
            : undefined;

          reply = await runToolCallingTurn({
            providerId,
            apiKey: llmApiKey,
            model,
            messages,
            toolMap,
            ...(apiFilteredGetToolDefs && { getToolDefs: apiFilteredGetToolDefs }),
            toolContext,
            maxRounds: 8,
            dangerouslySkipPermissions,
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
            getApiKey: oauthGetApiKey,
          });
        } else {
          reply =
            'No LLM credentials configured. I can run, but I cannot generate real replies yet.\n\n' +
            'Set an API key in .env (OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY) or use Ollama, then retry.\n\n' +
            `You said: ${message}`;
        }

        // Strip <think>...</think> blocks from models like qwen3.
        if (typeof reply === 'string') {
          reply = reply.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
          reply = reply.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();
        }
        sendJson(res, 200, { reply });
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

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve());
  });

  // Best-effort OTEL shutdown on exit.
  const handleExit = async () => {
    try {
      // Channel subscriptions + extension teardown (best-effort)
      for (const unsub of channelUnsubs) {
        try { unsub(); } catch { /* ignore */ }
      }
      await Promise.allSettled(
        (activePacks || [])
          .map((p: any) =>
            typeof p?.onDeactivate === 'function'
              ? p.onDeactivate({ logger: console })
              : null
          )
          .filter(Boolean),
      );
      await discoveryManager.close();
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
  fmt.kvPair('Channels', `${adapterByPlatform.size} loaded`);
  const dStats = discoveryManager.getStats();
  fmt.kvPair('Discovery', dStats.initialized ? sColor(`${dStats.capabilityCount} capabilities`) : wColor('disabled'));
  fmt.kvPair('Pairing', pairingEnabled ? sColor('enabled') : wColor('disabled'));
  fmt.kvPair(
    'Authorization',
    autoApproveToolCalls
      ? wColor('fully autonomous (all auto-approved)')
      : policy.executionMode === 'human-all'
        ? sColor('human-all (approve every tool call)')
        : sColor('human-dangerous (approve Tier 3 tools)'),
  );
  fmt.kvPair('Admin Secret', accent(hitlSecret));
  if (turnApprovalMode !== 'off') fmt.kvPair('Turn Checkpoints', sColor(turnApprovalMode));
  if (isOllamaProvider) {
    fmt.kvPair('Ollama', sColor('http://localhost:11434'));
  }
  fmt.blank();
  fmt.ok(`Health: ${iColor(`http://localhost:${port}/health`)}`);
  fmt.ok(`Chat:   ${iColor(`POST http://localhost:${port}/chat`)}`);
  fmt.ok(`HITL:   ${iColor(`http://localhost:${port}/hitl`)}`);
  fmt.ok(`Pairing: ${iColor(`http://localhost:${port}/pairing`)}`);
  if (!autoApproveToolCalls) {
    fmt.note(`CLI HITL: ${accent(`wunderland hitl watch --server http://localhost:${port} --secret ${hitlSecret}`)}`);
  }
  fmt.blank();
}
