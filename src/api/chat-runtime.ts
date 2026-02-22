/**
 * @fileoverview High-level in-process chat runtime for Wunderland.
 * @module wunderland/api/chat-runtime
 *
 * This is the programmatic counterpart to `wunderland chat`:
 * - Loads tools from extension packs (optional)
 * - Applies permission-set + tool-access-profile filtering
 * - Runs the OpenAI/Anthropic tool-calling loop with guardrails
 *
 * It intentionally does NOT start an HTTP server. Use `wunderland start` when you
 * want the full server + HITL UI + channel runtime.
 */

import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
  type NormalizedRuntimePolicy,
} from '../runtime/policy.js';
import { createEnvSecretResolver } from '../cli/security/env-secrets.js';
import { createSchemaOnDemandTools } from '../cli/openai/schema-on-demand.js';
import { runToolCallingTurn, type ToolInstance } from '../runtime/tool-calling.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../runtime/workspace.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../core/index.js';
import { resolveExtensionsByNames } from '../core/PresetExtensionResolver.js';
import type { WunderlandAgentConfig, WunderlandLLMConfig, WunderlandWorkspace } from './types.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

export type WunderlandChatRuntime = {
  readonly policy: NormalizedRuntimePolicy;
  readonly toolMap: Map<string, ToolInstance>;
  /** Returns a copy of the current message history for a session. */
  getMessages: (sessionId?: string) => Array<Record<string, unknown>>;
  /** Run one user turn and return the assistant's text reply. */
  runTurn: (
    input: string,
    opts?: {
      sessionId?: string;
      onToolCall?: (tool: ToolInstance, args: Record<string, unknown>) => void;
    },
  ) => Promise<string>;
};

function consoleLogger(): Required<LoggerLike> {
  return {
    debug: (msg, meta) => console.debug(msg, meta ?? ''),
    info: (msg, meta) => console.log(msg, meta ?? ''),
    warn: (msg, meta) => console.warn(msg, meta ?? ''),
    error: (msg, meta) => console.error(msg, meta ?? ''),
  };
}

function inferTurnApprovalMode(cfg: WunderlandAgentConfig | undefined): 'off' | 'after-each-turn' | 'after-each-round' {
  const raw =
    cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl)
      ? (cfg.hitl as any).turnApprovalMode ?? (cfg.hitl as any).turnApproval
      : undefined;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'after-each-turn') return 'after-each-turn';
  if (v === 'after-each-round') return 'after-each-round';
  return 'off';
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function buildSeedFromAgentConfig(cfg: WunderlandAgentConfig, workspaceSeedId: string) {
  const seedId =
    typeof cfg.seedId === 'string' && cfg.seedId.trim() ? cfg.seedId.trim() : workspaceSeedId;
  const displayName =
    typeof cfg.displayName === 'string' && cfg.displayName.trim()
      ? cfg.displayName.trim()
      : seedId;
  const bio =
    typeof cfg.bio === 'string' && cfg.bio.trim() ? cfg.bio.trim() : 'Autonomous Wunderbot';
  const p = cfg.personality || {};

  return createWunderlandSeed({
    seedId,
    name: displayName,
    description: bio,
    hexacoTraits: {
      honesty_humility: finiteNumber(p.honesty, 0.8),
      emotionality: finiteNumber(p.emotionality, 0.5),
      extraversion: finiteNumber(p.extraversion, 0.6),
      agreeableness: finiteNumber(p.agreeableness, 0.7),
      conscientiousness: finiteNumber(p.conscientiousness, 0.8),
      openness: finiteNumber(p.openness, 0.7),
    },
    baseSystemPrompt: typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : undefined,
    securityProfile: DEFAULT_SECURITY_PROFILE,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });
}

async function loadToolMapFromAgentConfig(opts: {
  agentConfig: WunderlandAgentConfig;
  policy: NormalizedRuntimePolicy;
  workspace: WunderlandWorkspace;
  workingDirectory: string;
  dangerouslySkipCommandSafety: boolean;
  logger: Required<LoggerLike>;
}): Promise<{ toolMap: Map<string, ToolInstance>; preloadedPackages: string[] }> {
  const { agentConfig: cfg, policy, workspace, workingDirectory, dangerouslySkipCommandSafety, logger } = opts;

  const permissions = getPermissionsForSet(policy.permissionSet);
  const lazyTools = cfg?.lazyTools === true;

  const toolMap = new Map<string, ToolInstance>();
  const preloadedPackages: string[] = [];

  if (!lazyTools) {
    const extensionsFromConfig = cfg.extensions;
    let toolExtensions: string[] = [];
    let voiceExtensions: string[] = [];
    let productivityExtensions: string[] = [];

    if (extensionsFromConfig) {
      toolExtensions = extensionsFromConfig.tools || [];
      voiceExtensions = extensionsFromConfig.voice || [];
      productivityExtensions = extensionsFromConfig.productivity || [];
    } else {
      toolExtensions = ['cli-executor', 'web-search', 'web-browser', 'giphy', 'image-search', 'news-search'];
      voiceExtensions = ['voice-synthesis'];
      productivityExtensions = [];
    }

    try {
      const configOverrides =
        cfg?.extensionOverrides && typeof cfg.extensionOverrides === 'object' && !Array.isArray(cfg.extensionOverrides)
          ? cfg.extensionOverrides
          : {};

      const runtimeOverrides: Record<string, any> = {
        'cli-executor': {
          options: {
            filesystem: { allowRead: permissions.filesystem.read, allowWrite: permissions.filesystem.write },
            agentWorkspace: {
              agentId: sanitizeAgentWorkspaceId(workspace.agentId),
              baseDir: workspace.baseDir,
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

      const cfgSecrets =
        cfg?.secrets && typeof cfg.secrets === 'object' && !Array.isArray(cfg.secrets)
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
      const channelsToLoad = Array.from(
        new Set(channelsFromConfig.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0)),
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

      for (const packEntry of resolved.manifest.packs) {
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
          const factory = extModule.createExtensionPack ?? extModule.default?.createExtensionPack ?? extModule.default;
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

      await Promise.all(
        packs
          .map((p: any) =>
            typeof p?.onActivate === 'function' ? p.onActivate({ logger: console, getSecret }) : null,
          )
          .filter(Boolean),
      );

      const tools = packs
        .flatMap((p: any) => (p?.descriptors || []).filter((d: any) => d?.kind === 'tool').map((d: any) => d.payload))
        .filter(Boolean) as ToolInstance[];

      for (const tool of tools) {
        if (!tool?.name) continue;
        toolMap.set(tool.name, tool);
      }
    } catch (err) {
      logger.warn?.('[wunderland/api] Extension loading failed (continuing with meta tools only)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Schema-on-demand meta tools are always present (even in lazy-tools mode).
  for (const metaTool of createSchemaOnDemandTools({
    toolMap,
    runtimeDefaults: {
      workingDirectory,
      headlessBrowser: true,
      dangerouslySkipCommandSafety,
      agentWorkspace: { agentId: sanitizeAgentWorkspaceId(workspace.agentId), baseDir: workspace.baseDir },
    },
    initialEnabledPackages: preloadedPackages,
    allowPackages: true,
    logger: console,
  })) {
    toolMap.set(metaTool.name, metaTool);
  }

  // Enforce policy (tool access profile + permission set).
  const filtered = filterToolMapByPolicy({ toolMap, toolAccessProfile: policy.toolAccessProfile, permissions });
  return { toolMap: filtered.toolMap, preloadedPackages };
}

export async function createWunderlandChatRuntime(opts: {
  agentConfig?: WunderlandAgentConfig;
  llm: WunderlandLLMConfig;
  workspace?: Partial<WunderlandWorkspace>;
  workingDirectory?: string;
  /**
   * When true, bypasses Tier-3 approvals (fully autonomous). Still enforces:
   * - permission sets
   * - tool access profiles
   * - SafeGuardrails validation
   */
  autoApproveToolCalls?: boolean;
  /**
   * Required unless `autoApproveToolCalls` is true or the config's `executionMode`
   * is `autonomous`.
   */
  askPermission?: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  logger?: LoggerLike;
}): Promise<WunderlandChatRuntime> {
  const baseLogger = consoleLogger();
  const logger: Required<LoggerLike> = {
    debug: opts.logger?.debug ?? baseLogger.debug,
    info: opts.logger?.info ?? baseLogger.info,
    warn: opts.logger?.warn ?? baseLogger.warn,
    error: opts.logger?.error ?? baseLogger.error,
  };
  const agentConfig = opts.agentConfig ?? {};
  const policy = normalizeRuntimePolicy(agentConfig as any);
  const turnApprovalMode = inferTurnApprovalMode(agentConfig);

  const seedIdForWorkspace =
    typeof agentConfig.seedId === 'string' && agentConfig.seedId.trim()
      ? agentConfig.seedId.trim()
      : `seed_${Date.now()}`;

  const workspace: WunderlandWorkspace = {
    agentId: sanitizeAgentWorkspaceId(opts.workspace?.agentId ?? seedIdForWorkspace),
    baseDir: opts.workspace?.baseDir ?? resolveAgentWorkspaceBaseDir(),
  };

  const seed = buildSeedFromAgentConfig(agentConfig, seedIdForWorkspace);
  const dangerouslySkipCommandSafety = false;
  const workingDirectory = opts.workingDirectory ?? process.cwd();

  const { toolMap } = await loadToolMapFromAgentConfig({
    agentConfig,
    policy,
    workspace,
    workingDirectory,
    dangerouslySkipCommandSafety,
    logger,
  });

  const systemPrompt = [
    typeof seed.baseSystemPrompt === 'string' ? seed.baseSystemPrompt : String(seed.baseSystemPrompt),
    'You are a Wunderland in-process agent runtime.',
    `Execution mode: ${policy.executionMode}. Permission set: ${policy.permissionSet}. Tool access profile: ${policy.toolAccessProfile}.`,
    agentConfig.lazyTools === true
      ? 'Use extensions_list + extensions_enable to load tools on demand (schema-on-demand).'
      : 'Tools are preloaded, and you can also use extensions_enable to load additional packs on demand.',
    'When you need up-to-date information, use web_search and/or browser_* tools (enable them first if missing).',
    turnApprovalMode !== 'off' ? `Turn checkpoints: ${turnApprovalMode}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const sessions = new Map<string, Array<Record<string, unknown>>>();

  const autoApprove =
    opts.autoApproveToolCalls === true || policy.executionMode === 'autonomous';

  if (!autoApprove && typeof opts.askPermission !== 'function') {
    throw new Error(
      'createWunderlandChatRuntime: askPermission is required unless autoApproveToolCalls=true or executionMode="autonomous".',
    );
  }

  const askPermission = async (tool: ToolInstance, args: Record<string, unknown>) => {
    if (autoApprove) return true;
    return (opts.askPermission as any)(tool, args);
  };

  const toolContext: Record<string, unknown> = {
    agentId: workspace.agentId,
    securityTier: policy.securityTier,
    permissionSet: policy.permissionSet,
    toolAccessProfile: policy.toolAccessProfile,
    executionMode: policy.executionMode,
    wrapToolOutputs: policy.wrapToolOutputs,
    ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
    turnApprovalMode,
    agentWorkspace: { agentId: workspace.agentId, baseDir: workspace.baseDir },
    workingDirectory,
  };

  return {
    policy,
    toolMap,
    getMessages: (sessionId?: string) => {
      const key = sessionId && sessionId.trim() ? sessionId.trim() : 'default';
      const msgs = sessions.get(key) ?? [];
      return msgs.map((m) => ({ ...m }));
    },
    runTurn: async (input: string, runOpts) => {
      const key = runOpts?.sessionId && runOpts.sessionId.trim() ? runOpts.sessionId.trim() : 'default';
      const history = sessions.get(key) ?? [
        { role: 'system', content: systemPrompt },
      ];

      history.push({ role: 'user', content: String(input ?? '') });

      const reply = await runToolCallingTurn({
        providerId: opts.llm.providerId,
        apiKey: opts.llm.apiKey,
        model: opts.llm.model,
        messages: history,
        toolMap,
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions: false,
        askPermission,
        onToolCall: runOpts?.onToolCall,
        baseUrl: opts.llm.baseUrl,
        fallback: opts.llm.fallback,
      });

      sessions.set(key, history);
      return reply;
    },
  };
}
