/**
 * @fileoverview Shared agent bootstrap sequence extracted from three consumers:
 * - `cli/commands/chat.ts`       (CLI interactive chat)
 * - `public/index.ts`            (library-first API)
 * - `api/chat-runtime.ts`        (in-process chat runtime)
 *
 * All three independently implemented the same 14-step agent initialization
 * sequence. This class consolidates that logic into a single static factory
 * method, {@link AgentBootstrap.create}, that each consumer now delegates to.
 *
 * @module wunderland/bootstrap/AgentBootstrap
 */

import type { AgentMemory } from '@framers/agentos';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
  type NormalizedRuntimePolicy,
} from '../runtime/policy.js';
import { resolveDefaultSkillsDirs } from '../skills/index.js';
import { createEnvSecretResolver } from '../cli/security/env-secrets.js';
import { createSchemaOnDemandTools } from '../runtime/schema-on-demand.js';
import type { ToolInstance } from '../runtime/tool-helpers.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../runtime/workspace.js';
import { resolveAgentDisplayName } from '../runtime/agent-identity.js';
import { buildAgenticSystemPrompt } from '../runtime/system-prompt-builder.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
  type IWunderlandSeed,
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
import type { WunderlandAgentConfig, WunderlandWorkspace } from '../api/types.js';
import { WunderlandAdaptiveExecutionRuntime } from '../runtime/adaptive-execution.js';
import { resolveStrictToolNames } from '../runtime/tool-function-names.js';
import { createMemorySystem, type MemorySystem } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Logger type (subset of console-like logger)
// ---------------------------------------------------------------------------

/** Minimal logger interface shared across all bootstrap consumers. */
export type BootstrapLogger = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration bag for {@link AgentBootstrap.create}.
 *
 * Each consumer (CLI, library API, in-process runtime) maps its own option
 * shape onto this unified config before calling the shared bootstrap.
 */
export interface AgentBootstrapConfig {
  /** Agent config object (from file, preset, or inline). */
  agentConfig?: Record<string, any>;

  /** Override LLM provider ID (`openai`, `anthropic`, `ollama`, etc.). */
  providerId?: string;

  /** Override LLM model identifier. */
  model?: string;

  /** LLM API key (provider-specific). */
  apiKey?: string;

  /** LLM base URL override (e.g. for Ollama or OpenRouter). */
  baseUrl?: string;

  /** OpenRouter fallback API key. */
  fallbackApiKey?: string;

  /** Security tier override (`dangerous`, `permissive`, `balanced`, `strict`, `paranoid`). */
  securityTier?: string;

  /**
   * Bootstrap mode determines system prompt styling:
   * - `chat`    — interactive terminal session
   * - `server`  — HTTP server-hosted agent
   * - `library` — in-process programmatic usage
   */
  mode: 'chat' | 'server' | 'library';

  /** When true, tools are loaded lazily via schema-on-demand. */
  lazyTools?: boolean;

  /** When true, tool calls are auto-approved (no HITL prompts). */
  autoApproveToolCalls?: boolean;

  /** Skip storage and memory initialization entirely. */
  skipMemory?: boolean;

  /** Pre-created AgentMemory instance to reuse instead of creating one. */
  memory?: AgentMemory;

  /** Extra tools to merge into the final tool map. */
  extraTools?: Map<string, ToolInstance>;

  /** Channel display names for system prompt. */
  channelNames?: string[];

  /** Authenticated integration names (e.g. `github`, `telegram`). */
  authenticatedIntegrations?: string[];

  /** Custom workspace agent ID. */
  workspaceId?: string;

  /** Custom workspace base directory. */
  workspaceBaseDir?: string;

  /** Working directory for the agent (defaults to cwd). */
  workingDirectory?: string;

  /** Dangerously skip command safety checks. */
  dangerouslySkipCommandSafety?: boolean;

  /** Logger instance. */
  logger?: BootstrapLogger;

  /**
   * Policy overrides applied before normalization.
   * CLI uses this for `--security-tier` / `--profile` flag defaults.
   */
  policyDefaults?: Record<string, unknown>;

  /**
   * Callback fired when schema-on-demand dynamically adds tools.
   * Used by callers that need to re-index discovery.
   */
  onSchemaToolsChanged?: (toolsAdded: string[]) => void;

  /** Turn approval mode override. */
  turnApprovalMode?: 'off' | 'after-each-turn' | 'after-each-round';

  /** Skills directory flag override (CLI `--skills-dir`). */
  skillsDirFlag?: string;

  /** Disable skills loading. */
  disableSkills?: boolean;

  /** Discovery config overrides. */
  discoveryOverrides?: Record<string, any>;

  /** Verbose logging. */
  verbose?: boolean;

  /**
   * Extension category names to expand instead of using hardcoded defaults.
   * Used by CLI when `extensionCategories` is set in agent.config.json.
   */
  extensionCategories?: string[];

  /**
   * Extension list normalizer function (CLI uses `normalizeExtensionList`).
   * When provided, extension lists pass through this before resolution.
   */
  normalizeExtensionList?: (names: string[]) => string[];

  /** Global config object (for CLI fallback extension/provider defaults). */
  globalConfig?: Record<string, any>;

  /**
   * Additional runtime overrides for extensions (e.g. Google Calendar secrets).
   * Merged on top of the standard runtime overrides.
   */
  extraExtensionOverrides?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The fully bootstrapped agent returned by {@link AgentBootstrap.create}.
 *
 * Consumers use these fields to drive their specific runtime loops (REPL,
 * HTTP handler, library session manager, etc.).
 */
export interface BootstrappedAgent {
  /** Wunderland seed (identity, HEXACO traits, security profile). */
  seed: IWunderlandSeed;

  /** Final tool map after extension loading, policy filtering, and discovery injection. */
  toolMap: Map<string, ToolInstance>;

  /** Shared tool context object passed to every tool invocation. */
  toolContext: Record<string, any>;

  /** Fully assembled system prompt. */
  systemPrompt: string;

  /** Normalized runtime policy (tier, permissions, execution mode, tool profile). */
  policy: NormalizedRuntimePolicy;

  /** Effective agent config after preset/config merging. */
  agentConfig: WunderlandAgentConfig;

  /** Resolved workspace info. */
  workspace: WunderlandWorkspace;

  /** Seed ID used as the agent's primary identifier. */
  seedId: string;

  /** Display name resolved from config hierarchy. */
  displayName: string;

  /** Active persona ID (may differ from seedId when personas are configured). */
  activePersonaId: string;

  /** Whether strict tool names are enabled. */
  strictToolNames: boolean;

  /** Resolved turn approval mode. */
  turnApprovalMode: 'off' | 'after-each-turn' | 'after-each-round';

  /** Capability discovery manager (semantic search + graph re-ranking). */
  discoveryManager?: WunderlandDiscoveryManager;

  /** Adaptive execution runtime (tool failure tracking, KPI windows). */
  adaptiveRuntime?: WunderlandAdaptiveExecutionRuntime;

  /** Per-agent storage manager. */
  storageManager?: import('../storage/AgentStorageManager.js').AgentStorageManager;

  /** Memory retrieval system. */
  memorySystem?: MemorySystem | null;

  /** Cognitive memory manager (HEXACO-modulated mechanisms). */
  cognitiveMemory?: any /* ICognitiveMemoryManager */;

  /** Cognitive mood provider function. */
  cognitiveMoodProvider?: () => { valence: number; arousal: number; dominance: number };

  /** Resolved skills prompt text for system prompt injection. */
  skillsPrompt?: string;

  /** Resolved skill entries for discovery indexing. */
  skillEntries?: Array<{
    name: string;
    description: string;
    content: string;
    category?: string;
    tags?: string[];
  }>;

  /** Content security pipeline summary. */
  securityPipelineSummary?: { active: string[]; total: number } | null;

  /** Extension preloaded package names. */
  preloadedPackages: string[];

  /** Schema-on-demand state for post-bootstrap use. */
  schemaOnDemandSecrets?: Record<string, string>;
  schemaOnDemandGetSecret?: (secretId: string) => string | undefined;
  schemaOnDemandOptions?: Record<string, Record<string, unknown>>;

  /** LLM configuration derived from agent config. */
  llmConfig: {
    providerId: string;
    apiKey: string;
    baseUrl?: string;
  };

  /**
   * Graceful shutdown — closes discovery, adaptive runtime, and storage.
   * Callers should invoke this on process exit or session close.
   */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `value` when it's a finite number, otherwise returns `fallback`.
 * Used for safe HEXACO trait extraction from config objects.
 */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize a loosely-typed tool-like object into the canonical
 * {@link ToolInstance} shape expected by the runtime.
 */
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
    category:
      typeof tool.category === 'string' && tool.category.trim()
        ? tool.category
        : 'productivity',
    requiredCapabilities: tool.requiredCapabilities,
    execute: tool.execute as any,
  };
}

/**
 * Infer turn approval mode from agent config HITL settings.
 */
function inferTurnApprovalMode(
  cfg: WunderlandAgentConfig | undefined,
): 'off' | 'after-each-turn' | 'after-each-round' {
  const raw =
    cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl)
      ? (cfg.hitl as any).turnApprovalMode ?? (cfg.hitl as any).turnApproval
      : undefined;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'after-each-turn') return 'after-each-turn';
  if (v === 'after-each-round') return 'after-each-round';
  return 'off';
}

/** Build a default console logger when none is provided. */
function defaultLogger(): Required<BootstrapLogger> {
  return {
    debug: (msg, meta) => console.debug(msg, meta ?? ''),
    info: (msg, meta) => console.log(msg, meta ?? ''),
    warn: (msg, meta) => console.warn(msg, meta ?? ''),
    error: (msg, meta) => console.error(msg, meta ?? ''),
  };
}

/**
 * Deep-merge two override objects. Nested `options` keys are shallow-merged.
 */
function mergeOverride(base: any, extra: any): any {
  const out = { ...(base || {}), ...(extra || {}) };
  if ((base && base.options) || (extra && extra.options)) {
    out.options = { ...(base?.options || {}), ...(extra?.options || {}) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// AgentBootstrap
// ---------------------------------------------------------------------------

/**
 * Shared agent initialization sequence.
 *
 * Consolidates the 14-step bootstrap that was previously triplicated across
 * the CLI chat command, the public library API, and the in-process chat
 * runtime. Each consumer now calls {@link AgentBootstrap.create} with its
 * own configuration variant and receives a fully wired {@link BootstrappedAgent}.
 *
 * Steps (in order):
 *  1. Resolve effective agent config
 *  2. Normalize runtime policy
 *  3. Resolve workspace
 *  4. Create seed (HEXACO traits)
 *  5. Init security pipeline
 *  6. Load tool map (extensions + schema-on-demand + RAG + policy filter)
 *  7. Resolve skills
 *  8. Init discovery
 *  9. Init adaptive runtime
 * 10. Init storage + memory
 * 11. Build system prompt
 * 12. Build tool context
 */
export class AgentBootstrap {
  /**
   * Create a fully bootstrapped agent from the given configuration.
   *
   * This is the only public entry point. All initialization steps run
   * sequentially in the correct order, matching the original logic from
   * `chat-runtime.ts`, `public/index.ts`, and `cli/commands/chat.ts`.
   *
   * @param config - Unified bootstrap configuration
   * @returns A fully initialized {@link BootstrappedAgent}
   */
  static async create(config: AgentBootstrapConfig): Promise<BootstrappedAgent> {
    const base = defaultLogger();
    const logger: Required<BootstrapLogger> = {
      debug: config.logger?.debug ?? base.debug,
      info: config.logger?.info ?? base.info,
      warn: config.logger?.warn ?? base.warn,
      error: config.logger?.error ?? base.error,
    };
    const workingDirectory = config.workingDirectory ?? process.cwd();
    const dangerouslySkipCommandSafety = config.dangerouslySkipCommandSafety ?? false;

    // ── Step 1: Resolve effective agent config ──────────────────────────
    const { agentConfig } = await resolveEffectiveAgentConfig({
      agentConfig: { ...(config.policyDefaults ?? {}), ...(config.agentConfig ?? {}) },
      workingDirectory,
      logger,
    });

    // ── Step 2: Normalize runtime policy ────────────────────────────────
    const policy = normalizeRuntimePolicy(agentConfig as any);
    const permissions = getPermissionsForSet(policy.permissionSet);
    const turnApprovalMode =
      config.turnApprovalMode ?? inferTurnApprovalMode(agentConfig);
    const strictToolNames = resolveStrictToolNames(
      (agentConfig as any)?.toolCalling?.strictToolNames,
    );

    // ── Step 3: Resolve workspace ───────────────────────────────────────
    const seedIdForWorkspace =
      typeof agentConfig.seedId === 'string' && agentConfig.seedId.trim()
        ? agentConfig.seedId.trim()
        : `seed_${Date.now()}`;
    const workspace: WunderlandWorkspace = {
      agentId: sanitizeAgentWorkspaceId(config.workspaceId ?? seedIdForWorkspace),
      baseDir: config.workspaceBaseDir ?? resolveAgentWorkspaceBaseDir(),
    };

    // ── Step 4: Create seed (HEXACO) ────────────────────────────────────
    const seedId =
      typeof agentConfig.seedId === 'string' && agentConfig.seedId.trim()
        ? agentConfig.seedId.trim()
        : seedIdForWorkspace;
    const displayName = resolveAgentDisplayName({
      displayName: agentConfig.displayName,
      agentName: agentConfig.agentName,
      seedId,
      fallback: seedId,
    });
    const bio =
      typeof agentConfig.bio === 'string' && agentConfig.bio.trim()
        ? agentConfig.bio.trim()
        : 'Autonomous Wunderbot';
    const personality = agentConfig.personality || {};

    const seed = createWunderlandSeed({
      seedId,
      name: displayName,
      description: bio,
      hexacoTraits: {
        honesty_humility: finiteNumber(personality.honesty, 0.8),
        emotionality: finiteNumber(personality.emotionality, 0.5),
        extraversion: finiteNumber(personality.extraversion, 0.6),
        agreeableness: finiteNumber(personality.agreeableness, 0.7),
        conscientiousness: finiteNumber(personality.conscientiousness, 0.8),
        openness: finiteNumber(personality.openness, 0.7),
      },
      baseSystemPrompt:
        typeof agentConfig.systemPrompt === 'string'
          ? agentConfig.systemPrompt
          : undefined,
      securityProfile: DEFAULT_SECURITY_PROFILE,
      inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
      stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
    });

    const activePersonaId =
      typeof agentConfig.selectedPersonaId === 'string' &&
      agentConfig.selectedPersonaId.trim()
        ? agentConfig.selectedPersonaId.trim()
        : seedId;

    // ── Step 5: Init security pipeline ──────────────────────────────────
    let securityPipelineSummary: { active: string[]; total: number } | null =
      null;
    try {
      const { initializeSecurityPipeline } = await import(
        '../runtime/tool-helpers.js'
      );
      securityPipelineSummary = await initializeSecurityPipeline({
        securityTier: policy.securityTier,
        guardrailPackOverrides: policy.guardrailPackOverrides,
        disableGuardrailPacks: policy.disableGuardrailPacks,
        enableOnlyPacks: policy.enableOnlyGuardrailPacks,
        seedId,
      });
    } catch {
      // Non-fatal — content guardrails not available.
      logger.warn?.(
        '[wunderland/bootstrap] Security pipeline initialization failed (continuing without content guardrails)',
      );
    }

    // ── Step 6: Load tool map ───────────────────────────────────────────
    const toolMap = new Map<string, ToolInstance>();
    const preloadedPackages: string[] = [];
    let schemaOnDemandSecrets: Record<string, string> | undefined;
    let schemaOnDemandGetSecret:
      | ((secretId: string) => string | undefined)
      | undefined;
    let schemaOnDemandOptions:
      | Record<string, Record<string, unknown>>
      | undefined;

    const lazyTools = config.lazyTools ?? agentConfig.lazyTools === true;

    if (!lazyTools) {
      const extensionsFromConfig = agentConfig.extensions;
      let toolExtensions: string[] = [];
      let voiceExtensions: string[] = [];
      let productivityExtensions: string[] = [];
      const normalize = config.normalizeExtensionList ?? ((x: string[]) => x);

      if (extensionsFromConfig) {
        toolExtensions = normalize(extensionsFromConfig.tools || []);
        voiceExtensions = normalize(extensionsFromConfig.voice || []);
        productivityExtensions = normalize(
          extensionsFromConfig.productivity || [],
        );
      } else {
        toolExtensions = normalize([
          'cli-executor',
          'web-search',
          'web-browser',
          'giphy',
          'image-search',
          'news-search',
        ]);
        voiceExtensions = normalize(getDefaultVoiceExtensions());
        productivityExtensions = [];
      }

      // Auto-include GitHub extension when a PAT is available
      if (!toolExtensions.includes('github')) {
        const ghToken = (
          process.env['GITHUB_TOKEN'] ||
          process.env['GH_TOKEN'] ||
          ''
        ).trim();
        if (ghToken) toolExtensions.push('github');
      }

      // Auto-include Telegram extension when a bot token is available
      if (
        !toolExtensions.includes('telegram') &&
        process.env['TELEGRAM_BOT_TOKEN']
      ) {
        const tgToken = process.env['TELEGRAM_BOT_TOKEN'].trim();
        if (/^\d+:[A-Za-z0-9_-]{35,}$/.test(tgToken))
          toolExtensions.push('telegram');
      }

      try {
        const configOverrides =
          agentConfig?.extensionOverrides &&
          typeof agentConfig.extensionOverrides === 'object' &&
          !Array.isArray(agentConfig.extensionOverrides)
            ? agentConfig.extensionOverrides
            : {};

        // Build filesystem roots: agent workspace + user's home directory + cwd.
        const homeDir = (await import('node:os')).homedir();
        const agentWorkspaceId = sanitizeAgentWorkspaceId(workspace.agentId);
        const workspaceDir = (await import('node:path')).resolve(
          workspace.baseDir,
          agentWorkspaceId,
        );
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
                writeRoots: permissions.filesystem.write
                  ? writeRoots
                  : undefined,
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
          'news-search': {
            options: { newsApiKey: process.env['NEWSAPI_API_KEY'] },
          },
          // Telegram: send-only mode to avoid 409 Conflict polling errors
          telegram: { options: { sendOnly: true } },
          'channel-telegram': { options: { sendOnly: true } },
          ...(config.extraExtensionOverrides ?? {}),
        };

        const mergedOverrides: Record<string, any> = mergeExtensionOverrides(
          configOverrides as Record<string, any>,
          {},
        );
        for (const [name, override] of Object.entries(runtimeOverrides)) {
          mergedOverrides[name] = mergeOverride(mergedOverrides[name], override);
        }

        const cfgSecrets =
          agentConfig?.secrets &&
          typeof agentConfig.secrets === 'object' &&
          !Array.isArray(agentConfig.secrets)
            ? (agentConfig.secrets as Record<string, string>)
            : undefined;
        const getSecret = createEnvSecretResolver({
          configSecrets: cfgSecrets,
        });
        const secrets = new Proxy<Record<string, string>>({} as any, {
          get: (_target, prop) =>
            typeof prop === 'string' ? getSecret(prop) : undefined,
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

        const channelsFromConfig = Array.isArray((agentConfig as any)?.channels)
          ? ((agentConfig as any).channels as unknown[])
          : Array.isArray((agentConfig as any)?.suggestedChannels)
            ? ((agentConfig as any).suggestedChannels as unknown[])
            : [];
        const channelsToLoad = Array.from(
          new Set(
            channelsFromConfig
              .map((v) => String(v ?? '').trim())
              .filter((v) => v.length > 0),
          ),
        );

        const CLI_REQUIRED_CHANNELS = new Set<string>(['signal', 'zalouser']);
        const allowedChannels =
          permissions.network.externalApis === true
            ? channelsToLoad.filter(
                (platform) =>
                  !CLI_REQUIRED_CHANNELS.has(platform) ||
                  permissions.system.cliExecution === true,
              )
            : [];

        const resolved = await resolveExtensionsByNames(
          toolExtensions,
          voiceExtensions,
          productivityExtensions,
          mergedOverrides,
          {
            secrets: secrets as any,
            channels:
              allowedChannels.length > 0 ? allowedChannels : 'none',
          },
        );

        const packs: any[] = [];

        for (const packEntry of resolved.manifest.packs) {
          try {
            if ((packEntry as any)?.enabled === false) continue;

            if (typeof (packEntry as any)?.factory === 'function') {
              const pack = await (packEntry as any).factory();
              if (pack) {
                packs.push(pack);
                if (typeof pack?.name === 'string')
                  preloadedPackages.push(pack.name);
              }
              continue;
            }

            let packageName: string | undefined;
            if ('package' in (packEntry as any))
              packageName = (packEntry as any).package as string;
            else if ('module' in (packEntry as any))
              packageName = (packEntry as any).module as string;
            if (!packageName) continue;

            const extModule = await import(packageName);
            const factory =
              extModule.createExtensionPack ??
              extModule.default?.createExtensionPack ??
              extModule.default;
            if (typeof factory !== 'function') continue;
            const options: any = (packEntry as any).options || {};
            const pack = await factory({
              options,
              logger: console,
              getSecret,
            });
            packs.push(pack);
            if (typeof pack?.name === 'string')
              preloadedPackages.push(pack.name);
          } catch (err) {
            logger.warn?.(
              '[wunderland/bootstrap] Failed to load extension pack',
              {
                error:
                  err instanceof Error ? err.message : String(err),
              },
            );
          }
        }

        await Promise.all(
          packs
            .map((p: any) =>
              typeof p?.onActivate === 'function'
                ? p.onActivate({ logger: console, getSecret })
                : null,
            )
            .filter(Boolean),
        );

        const tools = packs
          .flatMap((p: any) =>
            (p?.descriptors || [])
              .filter((d: any) => d?.kind === 'tool')
              .map((d: any) => d.payload),
          )
          .filter(Boolean) as ToolInstance[];

        for (const tool of tools) {
          if (!tool?.name) continue;
          toolMap.set(tool.name, tool);
        }
      } catch (err) {
        logger.warn?.(
          '[wunderland/bootstrap] Extension loading failed (continuing with meta tools only)',
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // Schema-on-demand meta tools are always present (even in lazy-tools mode).
    // Capture discoveryManager ref for re-index callback.
    let discoveryManager: WunderlandDiscoveryManager | null = null;

    for (const metaTool of createSchemaOnDemandTools({
      toolMap,
      runtimeDefaults: {
        workingDirectory,
        headlessBrowser: true,
        dangerouslySkipCommandSafety,
        agentWorkspace: {
          agentId: sanitizeAgentWorkspaceId(workspace.agentId),
          baseDir: workspace.baseDir,
        },
      },
      initialEnabledPackages: preloadedPackages,
      secrets: schemaOnDemandSecrets as any,
      getSecret: schemaOnDemandGetSecret,
      defaultExtensionOptions: schemaOnDemandOptions,
      allowPackages: true,
      logger: console,
      onToolsChanged: (...args: any[]) => {
        config.onSchemaToolsChanged?.(...(args as [string[]]));
        discoveryManager?.reindex?.({ toolMap }).catch(() => {});
      },
    })) {
      toolMap.set(metaTool.name, metaTool);
    }

    // RAG tools from agent config
    for (const ragTool of createConfiguredRagTools(agentConfig)) {
      if (!ragTool?.name) continue;
      toolMap.set(ragTool.name, toToolInstance(ragTool as any));
    }

    // Enforce policy (tool access profile + permission set).
    const filtered = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: policy.toolAccessProfile,
      permissions,
    });
    // Clear and repopulate the original map to preserve the reference.
    toolMap.clear();
    for (const [k, v] of filtered.toolMap.entries()) toolMap.set(k, v);

    // Merge extra tools from the caller (e.g. curated tools from library API).
    if (config.extraTools) {
      for (const [name, tool] of config.extraTools.entries()) {
        toolMap.set(name, tool);
      }
    }

    // ── Step 7: Resolve skills ──────────────────────────────────────────
    let skillsPrompt = '';
    let skillEntries: Array<{
      name: string;
      description: string;
      content: string;
      category?: string;
      tags?: string[];
    }> = [];

    if (!config.disableSkills) {
      const resolvedSkills = await resolveSkillContext({
        filesystemDirs: resolveDefaultSkillsDirs({
          cwd: workingDirectory,
          skillsDirFlag: config.skillsDirFlag,
        }),
        curatedSkills:
          Array.isArray(agentConfig.skills) && agentConfig.skills.length > 0
            ? agentConfig.skills
            : undefined,
        platform: process.platform,
        logger,
        warningPrefix: '[wunderland/bootstrap]',
      });
      skillsPrompt = resolvedSkills.skillsPrompt;
      skillEntries = resolvedSkills.skillEntries;
    }

    // ── Step 8: Init discovery ──────────────────────────────────────────
    const discoveryOpts = {
      ...buildDiscoveryOptionsFromAgentConfig(agentConfig),
      ...(config.discoveryOverrides ?? {}),
      verbose: config.verbose ?? false,
    };
    discoveryManager = new WunderlandDiscoveryManager(discoveryOpts);

    const llmProviderId = config.providerId ?? 'openai';
    const llmApiKey = config.apiKey ?? '';
    const llmBaseUrl = config.baseUrl;

    try {
      await discoveryManager.initialize({
        toolMap,
        skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
        llmConfig: {
          providerId: llmProviderId,
          apiKey: llmApiKey,
          baseUrl: llmBaseUrl,
        },
      });
      const metaTool = discoveryManager.getMetaTool();
      if (metaTool) {
        toolMap.set(metaTool.name, toToolInstance(metaTool as any));
      }
    } catch (error) {
      logger.warn?.(
        '[wunderland/bootstrap] Discovery initialization failed (continuing without)',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    // ── Step 9: Init adaptive runtime ───────────────────────────────────
    const adaptiveRuntime = new WunderlandAdaptiveExecutionRuntime({
      toolFailureMode: agentConfig.toolFailureMode,
      taskOutcomeTelemetry: agentConfig.taskOutcomeTelemetry,
      adaptiveExecution: agentConfig.adaptiveExecution,
      logger,
    });
    await adaptiveRuntime.initialize();

    // ── Step 10: Init storage + memory ──────────────────────────────────
    let storageManager:
      | import('../storage/AgentStorageManager.js').AgentStorageManager
      | undefined;
    let memorySystem: MemorySystem | null = null;
    let cognitiveMemoryManager: any /* ICognitiveMemoryManager */ | undefined;
    let cognitiveMoodProvider:
      | (() => { valence: number; arousal: number; dominance: number })
      | undefined;

    if (!config.skipMemory && agentConfig.memory?.enabled !== false) {
      try {
        const { AgentStorageManager, resolveAgentStorageConfig } = await import(
          '../storage/index.js'
        );
        const storageConfig = resolveAgentStorageConfig(
          seedId,
          (agentConfig as any).storage,
        );
        storageManager = new AgentStorageManager(storageConfig);
        await storageManager.initialize();

        // Cognitive Memory (optional — when cognitiveMechanisms config present)
        if (agentConfig.memory?.cognitiveMechanisms) {
          try {
            const { initializeCognitiveMemory } = await import(
              '../memory/CognitiveMemoryInitializer.js'
            );
            const result = await initializeCognitiveMemory({
              cognitiveMechanisms: agentConfig.memory.cognitiveMechanisms,
              vectorStore: storageManager.getVectorStore(),
              traits: (agentConfig.personality ?? {}) as any,
              agentId: seedId,
              llm: {
                providerId: llmProviderId,
                apiKey: llmApiKey,
                baseUrl: llmBaseUrl,
              },
            });
            cognitiveMemoryManager = result.manager;
            cognitiveMoodProvider = result.moodProvider;
          } catch (err) {
            logger.warn?.(
              '[wunderland/bootstrap] Cognitive memory init failed (continuing without)',
              { error: err instanceof Error ? err.message : String(err) },
            );
          }
        }

        memorySystem = await createMemorySystem({
          vectorStore: storageManager.getVectorStore(),
          traits: (agentConfig.personality ?? {}) as any,
          llm: {
            providerId: llmProviderId,
            apiKey: llmApiKey,
            baseUrl: llmBaseUrl,
          },
          ollama: (agentConfig as any).ollama,
          retrievalBudgetTokens:
            agentConfig.memory?.retrievalBudgetTokens ?? 4000,
          agentId: seedId,
          cognitiveMemoryManager,
          moodProvider: cognitiveMoodProvider,
        });
      } catch (err) {
        logger.warn?.(
          '[wunderland/bootstrap] Memory system init failed (continuing without retrieval)',
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // ── Step 11: Build system prompt ────────────────────────────────────
    const autoApprove =
      config.autoApproveToolCalls === true ||
      policy.executionMode === 'autonomous';

    // Detect authenticated integrations
    const authenticatedIntegrations: string[] = [
      ...(config.authenticatedIntegrations ?? []),
    ];
    if (
      authenticatedIntegrations.length === 0 &&
      (toolMap.has('github_search') ||
        toolMap.has('github_issue_list') ||
        process.env['GITHUB_TOKEN'] ||
        process.env['GH_TOKEN'])
    ) {
      authenticatedIntegrations.push('github');
    }
    if (
      !authenticatedIntegrations.includes('telegram') &&
      (toolMap.has('telegram_send_message') ||
        process.env['TELEGRAM_BOT_TOKEN'])
    ) {
      authenticatedIntegrations.push('telegram');
    }

    const systemPrompt = buildAgenticSystemPrompt({
      seed,
      policy,
      mode: config.mode,
      lazyTools,
      autoApproveToolCalls: autoApprove,
      skillsPrompt: skillsPrompt || undefined,
      turnApprovalMode,
      channelNames: config.channelNames,
      authenticatedIntegrations:
        authenticatedIntegrations.length > 0
          ? authenticatedIntegrations
          : undefined,
    });

    // ── Step 12: Build tool context ─────────────────────────────────────
    const toolContext: Record<string, any> = {
      agentId: workspace.agentId,
      personaId: activePersonaId,
      securityTier: policy.securityTier,
      permissionSet: policy.permissionSet,
      toolAccessProfile: policy.toolAccessProfile,
      executionMode: policy.executionMode,
      wrapToolOutputs: policy.wrapToolOutputs,
      strictToolNames,
      ...(policy.folderPermissions
        ? { folderPermissions: policy.folderPermissions }
        : null),
      turnApprovalMode,
      agentWorkspace: {
        agentId: workspace.agentId,
        baseDir: workspace.baseDir,
      },
      workingDirectory,
    };

    // ── Assemble result ─────────────────────────────────────────────────
    return {
      seed,
      toolMap,
      toolContext,
      systemPrompt,
      policy,
      agentConfig,
      workspace,
      seedId,
      displayName,
      activePersonaId,
      strictToolNames,
      turnApprovalMode,
      discoveryManager: discoveryManager ?? undefined,
      adaptiveRuntime,
      storageManager,
      memorySystem,
      cognitiveMemory: cognitiveMemoryManager,
      cognitiveMoodProvider,
      skillsPrompt,
      skillEntries,
      securityPipelineSummary,
      preloadedPackages,
      schemaOnDemandSecrets,
      schemaOnDemandGetSecret,
      schemaOnDemandOptions,
      llmConfig: {
        providerId: llmProviderId,
        apiKey: llmApiKey,
        baseUrl: llmBaseUrl,
      },
      async shutdown() {
        if (discoveryManager) await discoveryManager.close();
        await adaptiveRuntime.close();
        if (storageManager) await storageManager.shutdown().catch(() => {});
      },
    };
  }
}
