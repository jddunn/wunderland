// @ts-nocheck
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

import { resolveDefaultSkillsDirs } from '../skills/index.js';
import { resolveExtensionsByNames } from '../agents/presets/PresetExtensionResolver.js';
import { PairingManager } from '../pairing/PairingManager.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../core/index.js';
import { resolveSkillContext } from '../core/resolve-skill-context.js';
import {
  buildDiscoveryOptionsFromAgentConfig,
  resolveEffectiveAgentConfig,
} from '../config/effective-agent-config.js';
import { resolveWunderlandProviderId, resolveWunderlandTextModel } from '../config/provider-defaults.js';
import { loadDotEnvIntoProcessUpward } from '../cli/config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../runtime-new/tools/workspace.js';
import {
  runToolCallingTurn,
  safeJsonStringify,
  type LLMProviderConfig,
  type ToolInstance,
} from '../runtime-new/tools/tool-calling.js';
import { WunderlandAdaptiveExecutionRuntime } from '../runtime-new/execution/adaptive-execution.js';
import { resolveStrictToolNames } from '../runtime-new/tools/tool-function-names.js';
import { createSchemaOnDemandTools } from '../runtime-new/execution/schema-on-demand.js';
import { startWunderlandOtel, shutdownWunderlandOtel } from '../observability/otel.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
  type NormalizedRuntimePolicy,
} from '../runtime-new/tools/policy.js';
import { createEnvSecretResolver } from '../security/env-secrets.js';
import { resolveAgentDisplayName } from '../runtime-new/identity/agent-identity.js';
import { buildAgenticSystemPrompt } from '../runtime-new/execution/system-prompt-builder.js';
import { buildOllamaRuntimeOptions } from '../runtime-new/tools/ollama-options.js';
import { WunderlandDiscoveryManager } from '../discovery/index.js';
import { createConfiguredRagTools } from '../memory-new/rag/runtime-tools.js';
import { maybeProxyAgentosRagRequest } from '../memory-new/rag/http-proxy.js';
import { mergeExtensionOverrides } from '../cli/extensions/settings.js';
import {
  createSpeechExtensionEnvOverrides,
  getDefaultVoiceExtensions,
} from '../voice/speech-catalog.js';
import { getRecordedWunderlandSessionUsage, getRecordedWunderlandTokenUsage } from '../observability/token-usage.js';
import { resolveWunderlandTextLogConfig, WunderlandSessionTextLogger } from '../observability/session-text-log.js';
import type { TokenUsageSummary } from '../core/TokenUsageTracker.js';

import type {
  WunderlandAdaptiveExecutionConfig,
  WunderlandAgentConfig,
  WunderlandProviderId,
  WunderlandTaskOutcomeTelemetryConfig,
  WunderlandToolFailureMode,
  WunderlandWorkspace,
} from './types.js';

import { dispatchRoute } from './routes/index.js';
import type { ServerDeps } from './routes/types.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};


// HTTP helpers extracted to server-helpers.ts
export {
  consoleLogger,
  toToolInstance,
  readBody,
  sendJson,
  getHeaderString,
  extractHitlSecret,
  isHitlAuthorized,
  inferTurnApprovalMode,
  finiteNumber,
  HITL_PAGE_HTML, PAIRING_PAGE_HTML,
} from "./server-helpers.js";
import {
  consoleLogger,
  toToolInstance,
  sendJson,
  inferTurnApprovalMode,
  finiteNumber,
} from "./server-helpers.js";

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
  selectedPersonaId?: string;
  personaCount: number;
  pairingEnabled: boolean;
  policy: NormalizedRuntimePolicy;
  autoApproveToolCalls: boolean;
  turnApprovalMode: 'off' | 'after-each-turn' | 'after-each-round';
  openaiFallbackEnabled: boolean;
  usage: (opts?: { sessionId?: string }) => Promise<TokenUsageSummary>;
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
  /** Override default tool-call failure behavior for this runtime. */
  toolFailureMode?: WunderlandToolFailureMode;
  /** Runtime task-outcome telemetry controls. */
  taskOutcomeTelemetry?: WunderlandTaskOutcomeTelemetryConfig;
  /** Runtime adaptive execution controls. */
  adaptiveExecution?: WunderlandAdaptiveExecutionConfig;
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
  const rawAgentConfig = JSON.parse(JSON.stringify(cfg)) as WunderlandAgentConfig;
  const effectiveConfigResult = await resolveEffectiveAgentConfig({
    agentConfig: cfg,
    workingDirectory,
    logger,
  });
  cfg = effectiveConfigResult.agentConfig;
  const selectedPersona = effectiveConfigResult.selectedPersona;
  const availablePersonas = effectiveConfigResult.availablePersonas;

  const seedId = String(cfg.seedId || 'seed_local_agent');
  const activePersonaId =
    typeof cfg.selectedPersonaId === 'string' && cfg.selectedPersonaId.trim()
      ? cfg.selectedPersonaId.trim()
      : seedId;
  const displayName = resolveAgentDisplayName({
    displayName: cfg.displayName,
    agentName: cfg.agentName,
    seedId,
    fallback: 'My Agent',
  });
  const description = String(cfg.bio || 'Autonomous Wunderbot');
  const p = cfg.personality || {};

  const policy = normalizeRuntimePolicy(cfg as any);
  const permissions = getPermissionsForSet(policy.permissionSet);
  const turnApprovalMode = inferTurnApprovalMode(cfg);
  const strictToolNames = resolveStrictToolNames((cfg as any)?.toolCalling?.strictToolNames);

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
  let providerId: WunderlandProviderId;
  try {
    providerId = resolveWunderlandProviderId(providerIdRaw);
  } catch {
    throw new Error(
      `createWunderlandServer: unsupported LLM provider "${providerIdRaw}". Supported: openai, openrouter, ollama, anthropic, gemini`,
    );
  }

  const modelFromConfig = typeof (cfg as any).llmModel === 'string' ? String((cfg as any).llmModel).trim() : '';
  const model = resolveWunderlandTextModel({
    providerId,
    model:
      typeof opts?.llm?.model === 'string' && opts.llm.model.trim()
        ? opts.llm.model.trim()
        : modelFromConfig,
  });

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
  const sessionTextLogger = new WunderlandSessionTextLogger(
    resolveWunderlandTextLogConfig({
      agentConfig: cfg,
      workingDirectory,
      workspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
      defaultAgentId: workspaceAgentId,
      configBacked: true,
    }),
    logger,
  );

  const ollamaBaseUrl = (() => {
    if (opts?.llm?.baseUrl) return opts.llm.baseUrl;
    const configBaseUrl =
      typeof (cfg as any)?.ollama?.baseUrl === 'string'
        ? String((cfg as any).ollama.baseUrl).trim()
        : '';
    const raw = String(process.env['OLLAMA_BASE_URL'] || '').trim() || configBaseUrl;
    const base = raw || 'http://localhost:11434';
    const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
    if (normalized.endsWith('/v1')) return normalized;
    return `${normalized}/v1`;
  })();

  const llmBaseUrl =
    providerId === 'openrouter'
      ? (opts?.llm?.baseUrl ?? 'https://openrouter.ai/api/v1')
      : providerId === 'ollama'
        ? ollamaBaseUrl
        : providerId === 'gemini'
          ? (opts?.llm?.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai')
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
              : providerId === 'gemini'
                ? (process.env['GEMINI_API_KEY'] || '')
                : (process.env['OPENAI_API_KEY'] || '');

  const canUseLLM =
    providerId === 'ollama'
      ? true
      : providerId === 'openrouter'
        ? !!llmApiKey
        : providerId === 'anthropic'
          ? !!llmApiKey
          : providerId === 'gemini'
            ? !!llmApiKey
            : !!llmApiKey || !!openrouterFallback;

  const openaiFallbackEnabled = providerId === 'openai' && !!openrouterFallback;
  const telemetryConfig: WunderlandTaskOutcomeTelemetryConfig = {
    ...(cfg.taskOutcomeTelemetry ?? {}),
    ...(opts?.taskOutcomeTelemetry ?? {}),
    storage: {
      ...(cfg.taskOutcomeTelemetry?.storage ?? {}),
      ...(opts?.taskOutcomeTelemetry?.storage ?? {}),
    },
  };
  const adaptiveConfig: WunderlandAdaptiveExecutionConfig = {
    ...(cfg.adaptiveExecution ?? {}),
    ...(opts?.adaptiveExecution ?? {}),
  };
  const adaptiveRuntime = new WunderlandAdaptiveExecutionRuntime({
    toolFailureMode: opts?.toolFailureMode ?? cfg.toolFailureMode,
    taskOutcomeTelemetry: telemetryConfig,
    adaptiveExecution: adaptiveConfig,
    logger,
  });
  await adaptiveRuntime.initialize();
  const defaultTenantId =
    typeof (cfg as any)?.organizationId === 'string' && String((cfg as any).organizationId).trim()
      ? String((cfg as any).organizationId).trim()
      : undefined;

  const preloadedPackages: string[] = [];
  let activePacks: any[] = [];
  let allTools: ToolInstance[] = [];
  const loadedChannelAdapters: any[] = [];
  const loadedHttpHandlers: Array<
    (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean> | boolean
  > = [];
  let schemaOnDemandSecrets: Record<string, string> | undefined;
  let schemaOnDemandGetSecret: ((secretId: string) => string | undefined) | undefined;
  let schemaOnDemandOptions: Record<string, Record<string, unknown>> | undefined;

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

  const toolApiSecret = String(process.env['WUNDERLAND_TOOL_API_KEY'] || '').trim();

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
      toolExtensions = ['cli-executor', 'web-search', 'web-browser', 'browser-automation', 'content-extraction', 'credential-vault', 'giphy', 'image-search', 'news-search', 'weather', 'skills', 'deep-research', 'github'];
      voiceExtensions = getDefaultVoiceExtensions();
      productivityExtensions = [];
    }

    try {
      const configOverrides =
        (cfg as any)?.extensionOverrides && typeof (cfg as any).extensionOverrides === 'object' && !Array.isArray((cfg as any).extensionOverrides)
          ? (cfg as any).extensionOverrides
          : {};

      // Build filesystem roots: agent workspace + user's home directory + cwd.
      const homeDir = (await import('node:os')).homedir();
      const workspaceDir = path.resolve(workspaceBaseDir, workspaceAgentId);
      const cwd = process.cwd();
      const readRoots = [workspaceDir, homeDir, cwd, '/tmp'];
      const writeRoots = [workspaceDir, homeDir, cwd, '/tmp'];

      const runtimeOverrides: Record<string, any> = {
        'cli-executor': {
          options: {
            workingDirectory: cwd,
            filesystem: {
              allowRead: permissions.filesystem.read,
              allowWrite: permissions.filesystem.write,
              readRoots: permissions.filesystem.read ? readRoots : undefined,
              writeRoots: permissions.filesystem.write ? writeRoots : undefined,
            },
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
        ...createSpeechExtensionEnvOverrides(),
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

      const mergedOverrides: Record<string, any> = mergeExtensionOverrides(
        configOverrides as Record<string, any>,
        {},
      );
      for (const [name, override] of Object.entries(runtimeOverrides)) {
        mergedOverrides[name] = mergeOverride(mergedOverrides[name], override);
      }

      const cfgSecrets =
        (cfg as any)?.secrets && typeof (cfg as any).secrets === 'object' && !Array.isArray((cfg as any).secrets)
          ? ((cfg as any).secrets as Record<string, string>)
          : undefined;
      const getSecret = createEnvSecretResolver({ configSecrets: cfgSecrets });

      const secrets = new Proxy<Record<string, string>>({} as any, {
        get: (_target, prop) => (typeof prop === 'string' ? getSecret(prop) : undefined),
      });
      schemaOnDemandSecrets = cfgSecrets;
      schemaOnDemandGetSecret = getSecret;
      schemaOnDemandOptions = Object.fromEntries(
        Object.entries(mergedOverrides).map(([name, value]) => [
          name,
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {},
        ]),
      );

      const channelsFromConfig = Array.isArray((cfg as any)?.channels)
        ? ((cfg as any).channels as unknown[])
        : Array.isArray((cfg as any)?.suggestedChannels)
          ? ((cfg as any).suggestedChannels as unknown[])
          : [];
      const channelAliases: Record<string, string> = {
        'blog-publisher': 'devto',
        'blog publisher': 'devto',
        'dev.to': 'devto',
        hashnode: 'devto',
        medium: 'devto',
        wordpress: 'devto',
      };
      const channelsToLoad = Array.from(
        new Set(
          channelsFromConfig
            .map((v) => String(v ?? '').trim().toLowerCase())
            .filter((v) => v.length > 0)
            .map((v) => channelAliases[v] ?? v),
        ),
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

  let discoveryManager: WunderlandDiscoveryManager | undefined;
  for (const meta of createSchemaOnDemandTools({
    toolMap,
    runtimeDefaults: {
      workingDirectory,
      headlessBrowser: true,
      dangerouslySkipCommandSafety,
      agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    },
    initialEnabledPackages: preloadedPackages,
    secrets: schemaOnDemandSecrets as any,
    getSecret: schemaOnDemandGetSecret,
    defaultExtensionOptions: schemaOnDemandOptions,
    allowPackages: true,
    logger: console,
    onToolsChanged: () => {
      if (!discoveryManager) return;
      discoveryManager.reindex?.({ toolMap }).catch(() => {});
    },
  })) {
    toolMap.set((meta as any).name, meta as any);
  }

  for (const ragTool of createConfiguredRagTools(cfg)) {
    if (!ragTool?.name) continue;
    toolMap.set(ragTool.name, toToolInstance(ragTool as any));
  }

  const filtered = filterToolMapByPolicy({
    toolMap,
    toolAccessProfile: policy.toolAccessProfile,
    permissions,
  });
  toolMap.clear();
  for (const [k, v] of filtered.toolMap.entries()) toolMap.set(k, v);

  let skillsPrompt = '';
  let skillEntries: Array<{ name: string; description: string; content: string }> = [];
  if (enableSkills) {
    const resolvedSkills = await resolveSkillContext({
      filesystemDirs: resolveDefaultSkillsDirs({ cwd: workingDirectory }),
      curatedSkills:
        Array.isArray((cfg as any).skills) && (cfg as any).skills.length > 0
          ? ((cfg as any).skills as string[])
          : undefined,
      platform: process.platform,
      logger: {
        warn: (msg: string, meta?: unknown) => logger.warn?.(msg, meta),
      },
      warningPrefix: '[wunderland/api]',
    });
    skillsPrompt = resolvedSkills.skillsPrompt;
    skillEntries = resolvedSkills.skillEntries;
  }

  discoveryManager = new WunderlandDiscoveryManager(buildDiscoveryOptionsFromAgentConfig(cfg));
  try {
    await discoveryManager.initialize({
      toolMap,
      skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
      llmConfig: { providerId: providerId as any, apiKey: llmApiKey, baseUrl: llmBaseUrl },
    });
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, toToolInstance(metaTool as any));
    }
  } catch (err) {
    logger.warn?.('[wunderland/api] Discovery initialization failed (continuing without)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const systemPrompt = buildAgenticSystemPrompt({
    seed,
    policy,
    mode: 'server',
    lazyTools,
    autoApproveToolCalls,
    channelNames: loadedChannelAdapters.length > 0
      ? loadedChannelAdapters
        .map((a: any) => a.displayName || a.platform)
        .filter((name: unknown): name is string => typeof name === 'string' && name.trim().length > 0)
      : undefined,
    skillsPrompt: skillsPrompt || undefined,
    turnApprovalMode,
  });

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

    const tenantId =
      (typeof (message as any)?.organizationId === 'string' && String((message as any).organizationId).trim())
      || defaultTenantId;
    const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
      scope: {
        sessionId: sessionKey,
        userId: senderId,
        personaId: activePersonaId,
        tenantId: tenantId || undefined,
      },
    });

    let reply = '';
    let turnFailed = false;
    let fallbackTriggered = false;
    let toolCallCount = 0;
    try {
      if (canUseLLM) {
        const toolContext: Record<string, unknown> = {
          gmiId: `wunderland-channel-${sessionKey}`,
          sessionId: sessionKey,
          personaId: activePersonaId,
          userContext: {
            userId: senderId,
            platform,
            conversationId,
            ...(tenantId ? { organizationId: tenantId } : null),
          },
          ...(opts?.configDirOverride ? { wunderlandConfigDir: opts.configDirOverride } : null),
          agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
          permissionSet: policy.permissionSet,
          securityTier: policy.securityTier,
          executionMode: policy.executionMode,
          toolAccessProfile: policy.toolAccessProfile,
          interactiveSession: false,
          turnApprovalMode,
          toolFailureMode: adaptiveDecision.toolFailureMode,
          adaptiveExecution: {
            degraded: adaptiveDecision.degraded,
            reason: adaptiveDecision.reason,
            actions: adaptiveDecision.actions,
            kpi: adaptiveDecision.kpi ?? undefined,
          },
          ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
          wrapToolOutputs: policy.wrapToolOutputs,
          strictToolNames,
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
          strictToolNames,
          toolFailureMode: adaptiveDecision.toolFailureMode,
          ollamaOptions: buildOllamaRuntimeOptions(cfg?.ollama),
          onToolCall: () => {
            toolCallCount += 1;
          },
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
            fallbackTriggered = true;
            logger.warn?.('[wunderland/api] fallback activated', { error: err.message, provider });
          },
        });
      } else {
        reply = `No LLM credentials configured. You said: ${text}`;
        messages.push({ role: 'assistant', content: reply });
      }
    } catch (error) {
      turnFailed = true;
      throw error;
    } finally {
      try {
        await adaptiveRuntime.recordTurnOutcome({
          scope: {
            sessionId: sessionKey,
            userId: senderId,
            personaId: activePersonaId,
            tenantId: tenantId || undefined,
          },
          degraded: adaptiveDecision.degraded || fallbackTriggered,
          replyText: reply,
          didFail: turnFailed,
          toolCallCount,
        });
      } catch (error) {
        logger.warn?.('[wunderland/api][channels] failed to record adaptive outcome', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

  /* ── Assemble shared deps for extracted route handlers ─────────────────── */
  const routeDeps: ServerDeps = {
    seedId,
    displayName,
    activePersonaId,
    selectedPersona,
    availablePersonas: availablePersonas ?? [],
    providerId,
    model,
    llmApiKey,
    llmBaseUrl,
    canUseLLM,
    openrouterFallback,
    seed,
    cfg,
    rawAgentConfig,
    policy,
    toolMap,
    sessions,
    systemPrompt,
    adaptiveRuntime,
    discoveryManager: discoveryManager!,
    strictToolNames,
    autoApproveToolCalls,
    turnApprovalMode,
    defaultTenantId,
    workspaceAgentId,
    workspaceBaseDir,
    lazyTools,
    skillsPrompt,
    workingDirectory,
    hitlSecret,
    hitlManager,
    sseClients,
    broadcastHitlUpdate,
    pairingEnabled,
    pairing,
    adapterByPlatform,
    loadedChannelAdapters,
    loadedHttpHandlers,
    sessionTextLogger,
    logger,
    configDirOverride: opts?.configDirOverride,
    toolApiSecret,
    dangerouslySkipPermissions,
  };

  const server = createServer(async (req, res) => {
    try {
      /* ── CORS ───────────────────────────────────────────────────────────── */
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Api-Key, X-Wunderland-HITL-Secret, X-Wunderland-Chat-Secret, X-Wunderland-Feed-Secret',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      /* ── RAG proxy pass-through ─────────────────────────────────────────── */
      if (await maybeProxyAgentosRagRequest({ req, res, url, agentConfig: cfg, logger })) {
        return;
      }

      /* ── Dispatch to extracted route handlers ───────────────────────────── */
      if (await dispatchRoute(req, res, url, routeDeps)) {
        return;
      }

      /* ── Extension HTTP handlers (webhooks, etc.) ───────────────────────── */
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

    await adaptiveRuntime.close();
    await discoveryManager.close().catch(() => undefined);
    await shutdownWunderlandOtel();
  };

  logger.info?.('[wunderland/api] server started', {
    url,
    seedId,
    toolCount: toolMap.size,
    channelCount: adapterByPlatform.size,
    pairingEnabled,
  });

  const usage = async (usageOpts?: { sessionId?: string }): Promise<TokenUsageSummary> => {
    if (usageOpts?.sessionId) {
      return getRecordedWunderlandSessionUsage(usageOpts.sessionId, opts?.configDirOverride);
    }
    return getRecordedWunderlandTokenUsage(opts?.configDirOverride);
  };

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
    selectedPersonaId: activePersonaId !== seedId ? activePersonaId : undefined,
    personaCount: availablePersonas?.length ?? 0,
    pairingEnabled,
    policy,
    autoApproveToolCalls,
    turnApprovalMode,
    openaiFallbackEnabled,
    usage,
    close,
  };
}
