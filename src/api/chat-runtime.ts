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
import { resolveDefaultSkillsDirs } from '../skills/index.js';
import { createEnvSecretResolver } from '../cli/security/env-secrets.js';
import { createSchemaOnDemandTools } from '../cli/openai/schema-on-demand.js';
import { runToolCallingTurn, type ToolInstance } from '../runtime/tool-calling.js';
import { resolveStrictToolNames } from '../runtime/tool-function-names.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../runtime/workspace.js';
import { resolveAgentDisplayName } from '../runtime/agent-identity.js';
import { buildAgenticSystemPrompt } from '../runtime/system-prompt-builder.js';
import { buildOllamaRuntimeOptions } from '../runtime/ollama-options.js';
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
import { resolveExtensionsByNames } from '../core/PresetExtensionResolver.js';
import { WunderlandDiscoveryManager } from '../discovery/index.js';
import { createConfiguredRagTools } from '../rag/runtime-tools.js';
import { mergeExtensionOverrides } from '../cli/extensions/settings.js';
import {
  createSpeechExtensionEnvOverrides,
  getDefaultVoiceExtensions,
} from '../voice/speech-catalog.js';
import type { WunderlandAgentConfig, WunderlandLLMConfig, WunderlandWorkspace } from './types.js';
import { AgentMemory } from '@framers/agentos';
import type { ICognitiveMemoryManager } from '@framers/agentos/memory';
import { createMemorySystem, type MemorySystem } from '../memory/index.js';
import { injectMemoryContext } from '../memory/index.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

export type WunderlandChatRuntime = {
  readonly policy: NormalizedRuntimePolicy;
  readonly toolMap: Map<string, ToolInstance>;
  readonly memory?: AgentMemory;
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

function resolveAgentMemory(
  input: AgentMemory | ICognitiveMemoryManager | undefined,
): AgentMemory | undefined {
  if (!input) return undefined;
  const candidate = input as { remember?: unknown; recall?: unknown; raw?: unknown };
  if (
    input instanceof AgentMemory ||
    (
      typeof input === 'object' &&
      typeof candidate.remember === 'function' &&
      typeof candidate.recall === 'function' &&
      'raw' in candidate
    )
  ) {
    return input as unknown as AgentMemory;
  }
  return AgentMemory.wrap(input);
}

function consoleLogger(): Required<LoggerLike> {
  return {
    debug: (msg, meta) => console.debug(msg, meta ?? ''),
    info: (msg, meta) => console.log(msg, meta ?? ''),
    warn: (msg, meta) => console.warn(msg, meta ?? ''),
    error: (msg, meta) => console.error(msg, meta ?? ''),
  };
}

function toToolInstance(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  category?: string;
  requiredCapabilities?: string[];
  execute: (...args: any[]) => any;
}): ToolInstance {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as any,
    hasSideEffects: tool.hasSideEffects === true,
    category: typeof tool.category === 'string' && tool.category.trim() ? tool.category : 'productivity',
    requiredCapabilities: tool.requiredCapabilities,
    execute: tool.execute as any,
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
  const displayName = resolveAgentDisplayName({
    displayName: cfg.displayName,
    agentName: cfg.agentName,
    seedId,
    fallback: seedId,
  });
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
  onSchemaToolsChanged?: (toolsAdded: string[]) => void;
}): Promise<{ toolMap: Map<string, ToolInstance>; preloadedPackages: string[] }> {
  const { agentConfig: cfg, policy, workspace, workingDirectory, dangerouslySkipCommandSafety, logger } = opts;

  const permissions = getPermissionsForSet(policy.permissionSet);
  const lazyTools = cfg?.lazyTools === true;

  const toolMap = new Map<string, ToolInstance>();
  const preloadedPackages: string[] = [];
  let schemaOnDemandSecrets: Record<string, string> | undefined;
  let schemaOnDemandGetSecret: ((secretId: string) => string | undefined) | undefined;
  let schemaOnDemandOptions: Record<string, Record<string, unknown>> | undefined;

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
      voiceExtensions = getDefaultVoiceExtensions();
      productivityExtensions = [];
    }

    // Auto-include GitHub extension when a PAT is available
    if (!toolExtensions.includes('github')) {
      const ghToken = (process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'] || '').trim();
      if (ghToken) toolExtensions.push('github');
    }

    // Auto-include Telegram extension when a bot token is available
    if (!toolExtensions.includes('telegram') && process.env['TELEGRAM_BOT_TOKEN']) {
      const tgToken = process.env['TELEGRAM_BOT_TOKEN'].trim();
      if (/^\d+:[A-Za-z0-9_-]{35,}$/.test(tgToken)) toolExtensions.push('telegram');
    }

    try {
      const configOverrides =
        cfg?.extensionOverrides && typeof cfg.extensionOverrides === 'object' && !Array.isArray(cfg.extensionOverrides)
          ? cfg.extensionOverrides
          : {};

      // Build filesystem roots: agent workspace + user's home directory + cwd.
      const homeDir = (await import('node:os')).homedir();
      const agentWorkspaceId = sanitizeAgentWorkspaceId(workspace.agentId);
      const workspaceDir = (await import('node:path')).resolve(workspace.baseDir, agentWorkspaceId);
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
              agentId: agentWorkspaceId,
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
        ...createSpeechExtensionEnvOverrides(),
        'news-search': { options: { newsApiKey: process.env['NEWSAPI_API_KEY'] } },
        // Telegram: send-only mode in server context to avoid 409 Conflict polling errors
        'telegram': { options: { sendOnly: true } },
        'channel-telegram': { options: { sendOnly: true } },
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
        cfg?.secrets && typeof cfg.secrets === 'object' && !Array.isArray(cfg.secrets)
          ? (cfg.secrets as Record<string, string>)
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
    secrets: schemaOnDemandSecrets as any,
    getSecret: schemaOnDemandGetSecret,
    defaultExtensionOptions: schemaOnDemandOptions,
    allowPackages: true,
    logger: console,
    onToolsChanged: opts.onSchemaToolsChanged,
  })) {
    toolMap.set(metaTool.name, metaTool);
  }

  for (const ragTool of createConfiguredRagTools(cfg)) {
    if (!ragTool?.name) continue;
    toolMap.set(ragTool.name, toToolInstance(ragTool as any));
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
  memory?: AgentMemory | ICognitiveMemoryManager;
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
  const memory = resolveAgentMemory(opts.memory);
  const baseLogger = consoleLogger();
  const logger: Required<LoggerLike> = {
    debug: opts.logger?.debug ?? baseLogger.debug,
    info: opts.logger?.info ?? baseLogger.info,
    warn: opts.logger?.warn ?? baseLogger.warn,
    error: opts.logger?.error ?? baseLogger.error,
  };
  const workingDirectory = opts.workingDirectory ?? process.cwd();
  const { agentConfig } = await resolveEffectiveAgentConfig({
    agentConfig: opts.agentConfig ?? {},
    workingDirectory,
    logger,
  });
  const policy = normalizeRuntimePolicy(agentConfig as any);
  const turnApprovalMode = inferTurnApprovalMode(agentConfig);
  const strictToolNames = resolveStrictToolNames((agentConfig as any)?.toolCalling?.strictToolNames);

  const seedIdForWorkspace =
    typeof agentConfig.seedId === 'string' && agentConfig.seedId.trim()
      ? agentConfig.seedId.trim()
      : `seed_${Date.now()}`;

  const workspace: WunderlandWorkspace = {
    agentId: sanitizeAgentWorkspaceId(opts.workspace?.agentId ?? seedIdForWorkspace),
    baseDir: opts.workspace?.baseDir ?? resolveAgentWorkspaceBaseDir(),
  };

  const seed = buildSeedFromAgentConfig(agentConfig, seedIdForWorkspace);
  const activePersonaId =
    typeof agentConfig.selectedPersonaId === 'string' && agentConfig.selectedPersonaId.trim()
      ? agentConfig.selectedPersonaId.trim()
      : seed.seedId;
  const dangerouslySkipCommandSafety = false;

  // ── Content Security Pipeline (optional) ──────────────────────────────────
  // Initializes the WunderlandSecurityPipeline singleton for content-level
  // guardrails. Fail-safe: if creation fails, the runtime continues without them.
  try {
    const { initializeSecurityPipeline } = await import('../runtime/tool-helpers.js');
    await initializeSecurityPipeline({
      securityTier: policy.securityTier,
      guardrailPackOverrides: policy.guardrailPackOverrides,
      disableGuardrailPacks: policy.disableGuardrailPacks,
      enableOnlyPacks: policy.enableOnlyGuardrailPacks,
      seedId: seedIdForWorkspace,
    });
  } catch {
    // Non-fatal — content guardrails not available.
    logger.warn?.('[wunderland/api] Security pipeline initialization failed (continuing without content guardrails)');
  }
  let discoveryManager: WunderlandDiscoveryManager | null = null;
  let liveToolMap: Map<string, ToolInstance> | null = null;

  const { toolMap } = await loadToolMapFromAgentConfig({
    agentConfig,
    policy,
    workspace,
    workingDirectory,
    dangerouslySkipCommandSafety,
    logger,
    onSchemaToolsChanged: () => {
      if (!discoveryManager || !liveToolMap) return;
      discoveryManager.reindex?.({ toolMap: liveToolMap }).catch(() => {});
    },
  });
  liveToolMap = toolMap;

  // ── Memory Retrieval System ───────────────────────────────────────────
  let memorySystem: MemorySystem | null = null;
  if (agentConfig.memory?.enabled !== false) {
    try {
      const { AgentStorageManager, resolveAgentStorageConfig } = await import('../storage/index.js');
      const storageConfig = resolveAgentStorageConfig(seedIdForWorkspace, (agentConfig as any).storage);
      const storageMgr = new AgentStorageManager(storageConfig);
      await storageMgr.initialize();

      memorySystem = await createMemorySystem({
        vectorStore: storageMgr.getVectorStore(),
        traits: seed.personality as any,
        llm: { providerId: opts.llm.providerId, apiKey: opts.llm.apiKey, baseUrl: opts.llm.baseUrl },
        ollama: (agentConfig as any).ollama,
        retrievalBudgetTokens: agentConfig.memory?.retrievalBudgetTokens ?? 4000,
        agentId: seedIdForWorkspace,
      });
    } catch (err) {
      logger.warn?.('[wunderland/api] Memory system init failed (continuing without retrieval)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let skillsPrompt = '';
  const resolvedSkills = await resolveSkillContext({
    filesystemDirs: resolveDefaultSkillsDirs({ cwd: workingDirectory }),
    curatedSkills:
      Array.isArray(agentConfig.skills) && agentConfig.skills.length > 0
        ? agentConfig.skills
        : undefined,
    platform: process.platform,
    logger,
    warningPrefix: '[wunderland/api]',
  });
  skillsPrompt = resolvedSkills.skillsPrompt;
  const skillEntries = resolvedSkills.skillEntries;

  discoveryManager = new WunderlandDiscoveryManager(buildDiscoveryOptionsFromAgentConfig(agentConfig));
  try {
    await discoveryManager.initialize({
      toolMap,
      skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
      llmConfig: { providerId: opts.llm.providerId, apiKey: opts.llm.apiKey, baseUrl: opts.llm.baseUrl },
    });
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, toToolInstance(metaTool as any));
    }
  } catch (error) {
    logger.warn?.('[wunderland/api] Discovery initialization failed (continuing without)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const sessions = new Map<string, Array<Record<string, unknown>>>();
  const autoApprove =
    opts.autoApproveToolCalls === true || policy.executionMode === 'autonomous';
  // Detect authenticated integrations
  const authenticatedIntegrations: string[] = [];
  if (toolMap.has('github_search') || toolMap.has('github_issue_list') || process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN']) {
    authenticatedIntegrations.push('github');
  }
  if (toolMap.has('telegram_send_message') || process.env['TELEGRAM_BOT_TOKEN']) {
    authenticatedIntegrations.push('telegram');
  }

  const systemPrompt = buildAgenticSystemPrompt({
    seed,
    policy,
    mode: 'library',
    lazyTools: agentConfig.lazyTools === true,
    autoApproveToolCalls: autoApprove,
    skillsPrompt: skillsPrompt || undefined,
    turnApprovalMode,
    authenticatedIntegrations: authenticatedIntegrations.length > 0 ? authenticatedIntegrations : undefined,
  });

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
    personaId: activePersonaId,
    securityTier: policy.securityTier,
    permissionSet: policy.permissionSet,
    toolAccessProfile: policy.toolAccessProfile,
    executionMode: policy.executionMode,
    wrapToolOutputs: policy.wrapToolOutputs,
    strictToolNames,
    ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
    turnApprovalMode,
    agentWorkspace: { agentId: workspace.agentId, baseDir: workspace.baseDir },
    workingDirectory,
  };

  return {
    policy,
    toolMap,
    memory,
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

      const userContent = String(input ?? '');
      history.push({ role: 'user', content: userContent });

      // Feed user message to memory observer (automatic observation extraction)
      if (memory?.observe) {
        memory.observe('user', userContent).catch(() => {});
      }

      // Retrieve and inject memory context
      if (memorySystem) {
        await injectMemoryContext(history as any, memorySystem, userContent).catch(() => {});
      }

      const reply = await runToolCallingTurn({
        providerId: opts.llm.providerId,
        apiKey: opts.llm.apiKey,
        model: opts.llm.model,
        messages: history,
        toolMap,
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions: false,
        strictToolNames,
        askPermission,
        onToolCall: runOpts?.onToolCall,
        baseUrl: opts.llm.baseUrl,
        ollamaOptions: buildOllamaRuntimeOptions(agentConfig.ollama),
        fallback: opts.llm.fallback,
      });

      // Feed assistant reply to memory observer
      if (memory?.observe && reply?.content) {
        memory.observe('assistant', String(reply.content)).catch(() => {});
      }

      sessions.set(key, history);
      return reply;
    },
  };
}
