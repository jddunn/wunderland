/**
 * @fileoverview Library-first Wunderland API (developer-friendly entrypoint).
 * @module wunderland/public
 *
 * Golden path:
 * ```ts
 * import { createWunderland } from 'wunderland';
 *
 * const app = await createWunderland({ llm: { providerId: 'openai' } });
 * const session = app.session();
 * const out = await session.sendText('Hello!');
 * console.log(out.text);
 * ```
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ITool } from '@framers/agentos';

import { createWunderlandTools, getToolAvailability, type ToolRegistryConfig } from '../tools/ToolRegistry.js';
import {
  runToolCallingTurn,
  safeJsonStringify,
  type ToolInstance,
  type LLMProviderConfig,
} from '../runtime/tool-calling.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
  type NormalizedRuntimePolicy,
} from '../runtime/policy.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../runtime/workspace.js';

import type { WunderlandAgentConfig, WunderlandProviderId, WunderlandWorkspace } from '../api/types.js';
import { WunderlandConfigError } from '../config/errors.js';
import { loadAgentConfig, resolveLlmConfig } from '../config/load.js';
import { WunderlandDiscoveryManager } from '../discovery/index.js';
import type { WunderlandDiscoveryConfig, WunderlandDiscoveryStats, DiscoverySkillEntry } from '../discovery/index.js';
import type { AgentPreset } from '../core/PresetLoader.js';

// =============================================================================
// Public Types
// =============================================================================

export type WunderlandMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ToolCallRecord = {
  toolName: string;
  hasSideEffects: boolean;
  args: Record<string, unknown>;
  approved: boolean;
  /** Tool output JSON/text as returned to the LLM (best-effort). */
  toolResult?: string;
  deniedReason?: string;
};

export type WunderlandTurnResult = {
  text: string;
  messages: WunderlandMessage[];
  toolCalls: ToolCallRecord[];
  meta: {
    providerId: WunderlandProviderId;
    model: string;
    sessionId: string;
    elapsedMs: number;
  };
};

export type WunderlandDiagnostics = {
  llm: {
    providerId: WunderlandProviderId;
    model: string;
    baseUrl?: string;
    canUseLLM: boolean;
    openaiFallbackEnabled: boolean;
  };
  policy: NormalizedRuntimePolicy;
  approvals: {
    mode: WunderlandApprovalsMode;
  };
  tools: {
    count: number;
    names: string[];
    droppedByPolicy: Array<{ tool: string; reason: string }>;
    availability?: Record<string, { available: boolean; reason?: string }>;
  };
  skills: {
    count: number;
    names: string[];
  };
  workspace: {
    agentId: string;
    baseDir: string;
    workingDirectory: string;
  };
  discovery?: WunderlandDiscoveryStats;
};

export type ToolApprovalRequest = {
  sessionId: string;
  tool: Pick<ToolInstance, 'name' | 'description' | 'hasSideEffects' | 'category' | 'requiredCapabilities'>;
  args: Record<string, unknown>;
  preview: string;
};

export type WunderlandApprovalsMode = 'deny-side-effects' | 'auto-all' | 'custom';

export type WunderlandOptions = {
  /** Direct config object (control-plane). */
  agentConfig?: WunderlandAgentConfig;
  /** Optional path to `agent.config.json` (resolved relative to workingDirectory). */
  configPath?: string;
  /** Defaults to `process.cwd()` */
  workingDirectory?: string;
  /** Workspace location for tool execution state. */
  workspace?: Partial<WunderlandWorkspace>;
  /** LLM configuration (apiKey/model default from env when omitted). */
  llm?: Partial<{
    providerId: WunderlandProviderId | string;
    apiKey: string;
    model: string;
    baseUrl?: string;
    fallback?: LLMProviderConfig;
  }>;
  /**
   * Tool sources:
   * - 'none': no tools (pure chat)
   * - 'curated': curated tool packs (requires optional deps)
   * - object: curated + custom tools
   */
  tools?:
    | 'none'
    | 'curated'
    | {
        curated?: ToolRegistryConfig;
        custom?: ITool[];
      };
  /**
   * Load a preset by ID — auto-configures tools, skills, extensions, and personality.
   * Preset values are merged with explicit `tools`, `skills`, and `extensions` options
   * (explicit options take precedence).
   * @example preset: 'research-assistant'
   */
  preset?: string;
  /**
   * Skill sources (merged with preset skills if both provided):
   * - `'all'`: all curated skills for the current platform
   * - `string[]`: skill names from the curated registry
   * - object: fine-grained control over skill loading
   */
  skills?:
    | 'all'
    | string[]
    | {
        /** Curated skill names to load. */
        names?: string[];
        /** Additional skill directories to scan. */
        dirs?: string[];
        /** Scan default dirs (./skills, ~/.codex/skills) — default: true. */
        includeDefaults?: boolean;
      };
  /**
   * Extension sources (merged with preset extensions if both provided).
   * Extensions are resolved from `@framers/agentos-extensions-registry`.
   */
  extensions?: {
    /** Tool extension names (e.g. ['web-search', 'web-browser', 'giphy']). */
    tools?: string[];
    /** Voice provider extension names (e.g. ['voice-synthesis']). */
    voice?: string[];
    /** Productivity extension names (e.g. ['google-calendar']). */
    productivity?: string[];
    /** Per-extension overrides (enabled, priority, options). */
    overrides?: Record<string, { enabled?: boolean; priority?: number; options?: unknown }>;
  };
  approvals?: {
    /** Default: 'deny-side-effects' */
    mode?: WunderlandApprovalsMode;
    /**
     * Called only for side-effect tools when mode='custom'.
     * Return true to allow execution.
     */
    onRequest?: (req: ToolApprovalRequest) => Promise<boolean>;
  };
  /** Optional default userId for guardrails/audit context. */
  userId?: string;
  logger?: {
    debug?: (msg: string, meta?: unknown) => void;
    info?: (msg: string, meta?: unknown) => void;
    warn?: (msg: string, meta?: unknown) => void;
    error?: (msg: string, meta?: unknown) => void;
  };
  /** Capability discovery configuration. */
  discovery?: WunderlandDiscoveryConfig;
};

export type WunderlandSession = {
  readonly id: string;
  messages: () => WunderlandMessage[];
  sendText: (text: string, opts?: { userId?: string }) => Promise<WunderlandTurnResult>;
};

export type WunderlandApp = {
  session: (sessionId?: string) => WunderlandSession;
  diagnostics: () => WunderlandDiagnostics;
  close: () => Promise<void>;
};

// =============================================================================
// Internal helpers
// =============================================================================

function consoleLogger(): Required<NonNullable<WunderlandOptions['logger']>> {
  return {
    debug: (msg, meta) => console.debug(msg, meta ?? ''),
    info: (msg, meta) => console.log(msg, meta ?? ''),
    warn: (msg, meta) => console.warn(msg, meta ?? ''),
    error: (msg, meta) => console.error(msg, meta ?? ''),
  };
}

function toPublicMessages(raw: Array<Record<string, unknown>>): WunderlandMessage[] {
  const out: WunderlandMessage[] = [];
  for (const msg of raw) {
    const role = typeof msg?.role === 'string' ? msg.role : '';
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    const content = typeof msg?.content === 'string' ? msg.content : '';
    // Skip synthetic assistant tool-call frames that have no content.
    if (role === 'assistant' && !content.trim() && Array.isArray((msg as any)?.tool_calls)) continue;
    out.push({ role, content: String(content ?? '') });
  }
  return out;
}

function toToolInstance(tool: ITool): ToolInstance {
  const category =
    typeof (tool as any).category === 'string' && String((tool as any).category).trim()
      ? String((tool as any).category).trim()
      : 'productivity';

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as any,
    hasSideEffects: tool.hasSideEffects,
    category,
    requiredCapabilities: tool.requiredCapabilities,
    execute: tool.execute as any,
  };
}

async function resolveToolMap(opts: {
  tools: WunderlandOptions['tools'];
  policy: NormalizedRuntimePolicy;
  logger: Required<NonNullable<WunderlandOptions['logger']>>;
}): Promise<{
  toolMap: Map<string, ToolInstance>;
  droppedByPolicy: Array<{ tool: string; reason: string }>;
  availability?: Record<string, { available: boolean; reason?: string }>;
}> {
  const permissions = getPermissionsForSet(opts.policy.permissionSet);

  const toolsOpt = opts.tools ?? 'none';
  const useCurated = toolsOpt === 'curated' || (typeof toolsOpt === 'object' && !!toolsOpt?.curated);
  const curatedConfig = typeof toolsOpt === 'object' ? toolsOpt.curated : undefined;
  const customTools = typeof toolsOpt === 'object' ? (toolsOpt.custom ?? []) : [];

  const rawTools: ITool[] = [];

  if (useCurated) {
    try {
      rawTools.push(...(await createWunderlandTools(curatedConfig)));
    } catch (err) {
      opts.logger.warn?.('[wunderland] failed to load curated tools (continuing without)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const t of customTools) rawTools.push(t);

  const toolMap = new Map<string, ToolInstance>();
  for (const t of rawTools) {
    if (!t?.name) continue;
    toolMap.set(t.name, toToolInstance(t));
  }

  const filtered = filterToolMapByPolicy({ toolMap, toolAccessProfile: opts.policy.toolAccessProfile, permissions });
  return {
    toolMap: filtered.toolMap,
    droppedByPolicy: filtered.dropped,
    availability: useCurated ? getToolAvailability(curatedConfig) : undefined,
  };
}

async function resolveSkillsFromOpts(opts: {
  skills: WunderlandOptions['skills'];
  preset?: AgentPreset;
  logger: Required<NonNullable<WunderlandOptions['logger']>>;
}): Promise<{
  skillsPrompt: string;
  skillEntries: DiscoverySkillEntry[];
  skillNames: string[];
}> {
  const empty = { skillsPrompt: '', skillEntries: [], skillNames: [] as string[] };
  const skillsOpt = opts.skills;
  const presetSkills = opts.preset?.suggestedSkills ?? [];

  // Collect all named skills (from option + preset, deduplicated)
  let namedSkills: string[] = [];
  let dirs: string[] = [];
  let includeDefaults = false;

  if (skillsOpt === 'all') {
    namedSkills = ['all'];
  } else if (Array.isArray(skillsOpt)) {
    namedSkills = [...skillsOpt];
  } else if (typeof skillsOpt === 'object' && skillsOpt !== null) {
    namedSkills = [...(skillsOpt.names ?? [])];
    dirs = [...(skillsOpt.dirs ?? [])];
    includeDefaults = skillsOpt.includeDefaults ?? false;
  }

  // Merge preset skills (dedup)
  if (presetSkills.length > 0 && !namedSkills.includes('all')) {
    const existing = new Set(namedSkills);
    for (const name of presetSkills) {
      if (!existing.has(name)) namedSkills.push(name);
    }
  }

  if (namedSkills.length === 0 && dirs.length === 0 && !includeDefaults) {
    return empty;
  }

  const promptParts: string[] = [];
  const allEntries: DiscoverySkillEntry[] = [];
  const allNames: string[] = [];

  // 1. Directory-based skills (local dirs + defaults)
  if (dirs.length > 0 || includeDefaults) {
    try {
      const skillsMod: any = await import('../skills/index.js');
      const SkillRegistry = skillsMod.SkillRegistry;
      const resolveDefaultSkillsDirs = skillsMod.resolveDefaultSkillsDirs;

      const registry = new SkillRegistry();
      const scanDirs = [...dirs];
      if (includeDefaults && typeof resolveDefaultSkillsDirs === 'function') {
        scanDirs.push(...resolveDefaultSkillsDirs({ cwd: process.cwd() }));
      }
      if (scanDirs.length > 0) {
        await registry.loadFromDirs(scanDirs);
        const snapshot = registry.buildSnapshot({ platform: process.platform, strict: true });
        if (snapshot.prompt) promptParts.push(snapshot.prompt);
        // Extract entries for discovery
        if (typeof registry.listAll === 'function') {
          for (const entry of registry.listAll() as any[]) {
            const skill = entry.skill ?? entry;
            const name = skill.name ?? 'unknown';
            allEntries.push({
              name,
              description: skill.description ?? '',
              content: skill.content ?? '',
            });
            allNames.push(name);
          }
        }
      }
    } catch (err) {
      opts.logger.warn?.('[wunderland] Failed to load skills from directories (continuing without)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Named skills from curated registry
  if (namedSkills.length > 0) {
    try {
      const { resolveSkillsByNames } = await import('../core/PresetSkillResolver.js');

      let snapshot: any;
      if (namedSkills.includes('all')) {
        // Load all curated skills
        const catalogModule: string = '@framers/agentos-skills-registry/catalog';
        const catalog: any = await import(catalogModule);
        const allSkillNames = typeof catalog.listSkillNames === 'function'
          ? catalog.listSkillNames()
          : typeof catalog.searchSkills === 'function'
            ? catalog.searchSkills('').map((s: any) => s.name)
            : [];
        snapshot = await resolveSkillsByNames(allSkillNames);
      } else {
        snapshot = await resolveSkillsByNames(namedSkills);
      }

      if (snapshot?.prompt) promptParts.push(snapshot.prompt);

      // Build SkillEntries for discovery
      if (Array.isArray(snapshot?.skills)) {
        for (const skill of snapshot.skills as any[]) {
          const name = typeof skill === 'string' ? skill : skill.name ?? 'unknown';
          if (!allNames.includes(name)) {
            allEntries.push({ name, description: '', content: '' });
            allNames.push(name);
          }
        }
      }
    } catch (err) {
      opts.logger.warn?.('[wunderland] Failed to load curated skills (continuing without)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    skillsPrompt: promptParts.filter(Boolean).join('\n\n'),
    skillEntries: allEntries,
    skillNames: allNames,
  };
}

async function resolveExtensionsFromOpts(opts: {
  extensions: WunderlandOptions['extensions'];
  preset?: AgentPreset;
  logger: Required<NonNullable<WunderlandOptions['logger']>>;
}): Promise<{
  extensionTools: ITool[];
  extensionNames: string[];
}> {
  const empty = { extensionTools: [], extensionNames: [] as string[] };
  const extOpt = opts.extensions;
  const presetExt = opts.preset?.suggestedExtensions;

  // Collect extension names by category
  let toolExts = [...(extOpt?.tools ?? [])];
  let voiceExts = [...(extOpt?.voice ?? [])];
  let prodExts = [...(extOpt?.productivity ?? [])];
  const overrides = extOpt?.overrides;

  // Merge from preset (dedup)
  if (presetExt) {
    const mergeDedup = (target: string[], source: string[] | undefined) => {
      const existing = new Set(target);
      for (const name of source ?? []) {
        if (!existing.has(name)) target.push(name);
      }
    };
    mergeDedup(toolExts, presetExt.tools);
    mergeDedup(voiceExts, presetExt.voice);
    mergeDedup(prodExts, presetExt.productivity);
  }

  if (toolExts.length === 0 && voiceExts.length === 0 && prodExts.length === 0) {
    return empty;
  }

  try {
    const { resolveExtensionsByNames } = await import('../core/PresetExtensionResolver.js');

    const result = await resolveExtensionsByNames(toolExts, voiceExts, prodExts, overrides);

    if (result.missing.length > 0) {
      opts.logger.warn?.(`[wunderland] Some extensions not available: ${result.missing.join(', ')}`);
    }

    // Invoke factories and extract ITool instances
    const tools: ITool[] = [];
    const names: string[] = [];

    for (const pack of result.manifest.packs) {
      try {
        const instances = typeof pack.factory === 'function' ? pack.factory() : [];
        const toolArray = Array.isArray(instances) ? instances : [instances];
        for (const instance of toolArray) {
          if (instance && typeof instance === 'object' && 'name' in instance && typeof instance.execute === 'function') {
            tools.push(instance as ITool);
            names.push(instance.name);
          }
        }
      } catch (err) {
        opts.logger.warn?.(`[wunderland] Failed to initialize extension pack "${pack.name}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { extensionTools: tools, extensionNames: names };
  } catch (err) {
    opts.logger.warn?.('[wunderland] Failed to resolve extensions (continuing without)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

function buildSystemPrompt(agentConfig: WunderlandAgentConfig, policy: NormalizedRuntimePolicy, skillsPrompt?: string): string {
  const base = typeof agentConfig.systemPrompt === 'string' && agentConfig.systemPrompt.trim()
    ? agentConfig.systemPrompt.trim()
    : 'You are a Wunderland in-process agent runtime.';

  const parts = [
    base,
    `Execution mode: human-all (library approvals).`,
    `Permission set: ${policy.permissionSet}. Tool access profile: ${policy.toolAccessProfile}. Security tier: ${policy.securityTier}.`,
    'When you need up-to-date information, use web_search and/or browser_* tools (if available).',
    skillsPrompt || '',
  ].filter(Boolean);

  return parts.join('\n\n').trim();
}

// =============================================================================
// Public entrypoint
// =============================================================================

export async function createWunderland(opts: WunderlandOptions = {}): Promise<WunderlandApp> {
  const baseLogger = consoleLogger();
  const logger: Required<NonNullable<WunderlandOptions['logger']>> = {
    debug: opts.logger?.debug ?? baseLogger.debug,
    info: opts.logger?.info ?? baseLogger.info,
    warn: opts.logger?.warn ?? baseLogger.warn,
    error: opts.logger?.error ?? baseLogger.error,
  };

  const workingDirectory = opts.workingDirectory ? path.resolve(opts.workingDirectory) : process.cwd();
  const agentConfig = await loadAgentConfig({ agentConfig: opts.agentConfig, configPath: opts.configPath, workingDirectory });

  const policy = normalizeRuntimePolicy(agentConfig as any);
  const permissions = getPermissionsForSet(policy.permissionSet);

  const workspace: WunderlandWorkspace = {
    agentId: sanitizeAgentWorkspaceId(opts.workspace?.agentId ?? String(agentConfig.seedId || 'seed_local_agent')),
    baseDir: opts.workspace?.baseDir ?? resolveAgentWorkspaceBaseDir(),
  };

  const llm = resolveLlmConfig({ agentConfig, llm: opts.llm });
  if (!llm.canUseLLM) {
    throw new WunderlandConfigError('No usable LLM credentials configured.', [
      {
        path: 'llm',
        message: `providerId=${llm.providerId} is not configured for use.`,
        hint: llm.providerId === 'openai'
          ? 'Set OPENAI_API_KEY (or OPENROUTER_API_KEY for fallback), or pass llm.apiKey.'
          : llm.providerId === 'openrouter'
            ? 'Set OPENROUTER_API_KEY or pass llm.apiKey.'
            : llm.providerId === 'anthropic'
              ? 'Set ANTHROPIC_API_KEY or pass llm.apiKey.'
              : 'Configure the provider and retry.',
      },
    ]);
  }

  const approvalsMode: WunderlandApprovalsMode = opts.approvals?.mode ?? 'deny-side-effects';

  // Load preset (if specified) — provides default tools, skills, extensions, and personality
  let loadedPreset: AgentPreset | undefined;
  if (opts.preset) {
    try {
      const { PresetLoader } = await import('../core/PresetLoader.js');
      const loader = new PresetLoader();
      loadedPreset = loader.loadPreset(opts.preset);
      logger.debug?.(`[wunderland] Loaded preset "${opts.preset}"`, {
        skills: loadedPreset.suggestedSkills,
        extensions: loadedPreset.suggestedExtensions,
      });
    } catch (err) {
      logger.warn?.(`[wunderland] Failed to load preset "${opts.preset}" (continuing without)`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { toolMap, droppedByPolicy, availability } = await resolveToolMap({
    tools: opts.tools,
    policy,
    logger,
  });

  // Resolve named extensions → add their tools to toolMap
  const { extensionTools } = await resolveExtensionsFromOpts({
    extensions: opts.extensions,
    preset: loadedPreset,
    logger,
  });
  for (const t of extensionTools) {
    if (t?.name) toolMap.set(t.name, toToolInstance(t));
  }

  // Resolve skills → get prompt text + entries for discovery indexing
  const { skillsPrompt, skillEntries, skillNames } = await resolveSkillsFromOpts({
    skills: opts.skills,
    preset: loadedPreset,
    logger,
  });

  // Capability discovery — semantic search + graph re-ranking for tool/skill context
  const discoveryOpts: WunderlandDiscoveryConfig = { ...opts.discovery };
  if (agentConfig.discovery) {
    const d = agentConfig.discovery;
    discoveryOpts.enabled ??= d.enabled;
    discoveryOpts.embeddingProvider ??= d.embeddingProvider;
    discoveryOpts.embeddingModel ??= d.embeddingModel;
    discoveryOpts.scanManifestDirs ??= d.scanManifests;
    if (d.tier0Budget || d.tier1Budget || d.tier2Budget || d.tier1TopK || d.tier2TopK) {
      discoveryOpts.config = {
        ...(discoveryOpts.config ?? {}),
        ...(d.tier0Budget !== undefined ? { tier0TokenBudget: d.tier0Budget } : {}),
        ...(d.tier1Budget !== undefined ? { tier1TokenBudget: d.tier1Budget } : {}),
        ...(d.tier2Budget !== undefined ? { tier2TokenBudget: d.tier2Budget } : {}),
        ...(d.tier1TopK !== undefined ? { tier1TopK: d.tier1TopK } : {}),
        ...(d.tier2TopK !== undefined ? { tier2TopK: d.tier2TopK } : {}),
      };
    }
  }
  const discoveryManager = new WunderlandDiscoveryManager(discoveryOpts);
  try {
    await discoveryManager.initialize({
      toolMap,
      skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
      llmConfig: {
        providerId: llm.providerId,
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
      },
    });
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, toToolInstance(metaTool));
    }
  } catch (err) {
    logger.warn?.('[wunderland] Discovery initialization failed (continuing without)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const baseToolContext: Record<string, unknown> = {
    agentId: workspace.agentId,
    securityTier: policy.securityTier,
    permissionSet: policy.permissionSet,
    toolAccessProfile: policy.toolAccessProfile,
    executionMode: 'human-all',
    wrapToolOutputs: policy.wrapToolOutputs,
    ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
    agentWorkspace: { agentId: workspace.agentId, baseDir: workspace.baseDir },
    workingDirectory,
  };

  const systemPrompt = buildSystemPrompt(agentConfig, policy, skillsPrompt);

  const sessions = new Map<string, Array<Record<string, unknown>>>();

  const diagnostics = (): WunderlandDiagnostics => ({
    llm: {
      providerId: llm.providerId,
      model: llm.model,
      baseUrl: llm.baseUrl,
      canUseLLM: llm.canUseLLM,
      openaiFallbackEnabled: llm.openaiFallbackEnabled,
    },
    policy,
    approvals: { mode: approvalsMode },
    tools: {
      count: toolMap.size,
      names: [...toolMap.keys()].sort(),
      droppedByPolicy,
      availability,
    },
    skills: {
      count: skillNames.length,
      names: [...skillNames].sort(),
    },
    workspace: { agentId: workspace.agentId, baseDir: workspace.baseDir, workingDirectory },
    discovery: discoveryManager.getStats(),
  });

  const session = (sessionId?: string): WunderlandSession => {
    const id = sessionId && sessionId.trim() ? sessionId.trim() : randomUUID();

    const getRawHistory = () => {
      const existing = sessions.get(id);
      if (existing) return existing;
      const initial: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
      sessions.set(id, initial);
      return initial;
    };

    const messages = () => toPublicMessages(getRawHistory());

    const sendText: WunderlandSession['sendText'] = async (text, sendOpts) => {
      const started = Date.now();
      const history = getRawHistory();
      const userText = String(text ?? '');
      history.push({ role: 'user', content: userText });

      const toolCalls: ToolCallRecord[] = [];
      const toolMessagesStartIdx = history.length;

      const onToolCall = (tool: ToolInstance, args: Record<string, unknown>) => {
        toolCalls.push({
          toolName: tool.name,
          hasSideEffects: tool.hasSideEffects === true,
          args,
          approved: false,
        });
      };

      const askPermission = async (tool: ToolInstance, args: Record<string, unknown>) => {
        const isSideEffect = tool.hasSideEffects === true;
        const preview = safeJsonStringify(args, 1800);
        const req: ToolApprovalRequest = {
          sessionId: id,
          tool: {
            name: tool.name,
            description: tool.description,
            hasSideEffects: tool.hasSideEffects,
            category: tool.category,
            requiredCapabilities: tool.requiredCapabilities,
          },
          args,
          preview,
        };

        let approved = false;
        if (approvalsMode === 'auto-all') {
          approved = true;
        } else if (approvalsMode === 'deny-side-effects') {
          approved = !isSideEffect;
        } else {
          // custom
          approved = !isSideEffect;
          if (isSideEffect && typeof opts.approvals?.onRequest === 'function') {
            approved = await opts.approvals.onRequest(req);
          }
        }

        const record = [...toolCalls].reverse().find((r) => r.toolName === tool.name && r.toolResult === undefined) ?? toolCalls[toolCalls.length - 1];
        if (record) {
          record.approved = approved;
          if (!approved) {
            record.deniedReason =
              approvalsMode === 'deny-side-effects'
                ? 'denied_by_default:side_effect_tool'
                : approvalsMode === 'custom'
                  ? 'denied_by_custom_approver'
                  : 'denied';
          }
        }

        return approved;
      };

      const userId = typeof sendOpts?.userId === 'string' && sendOpts.userId.trim()
        ? sendOpts.userId.trim()
        : (typeof opts.userId === 'string' && opts.userId.trim() ? opts.userId.trim() : 'local-user');

      const toolContext: Record<string, unknown> = {
        ...baseToolContext,
        sessionId: id,
        userContext: { userId },
        permissions,
      };

      // Capability discovery — inject tiered context for this turn
      try {
        const discoveryResult = await discoveryManager.discoverForTurn(userText);
        if (discoveryResult) {
          // Remove stale discovery context from previous turns
          for (let i = history.length - 1; i >= 1; i--) {
            if (typeof history[i]?.content === 'string' && String(history[i]!.content).startsWith('[Capability Context]')) {
              history.splice(i, 1);
            }
          }
          // Build tiered context string
          const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
          if (discoveryResult.tier1.length > 0) {
            ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r) => r.summaryText).join('\n'));
          }
          if (discoveryResult.tier2.length > 0) {
            ctxParts.push(discoveryResult.tier2.map((r) => r.fullText).join('\n'));
          }
          // Insert after system prompt but before conversation history
          history.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });
        }
      } catch {
        // Non-fatal — continue without discovery context
      }

      const reply = await runToolCallingTurn({
        providerId: llm.providerId,
        apiKey: llm.apiKey,
        model: llm.model,
        messages: history,
        toolMap,
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions: false,
        askPermission,
        onToolCall,
        baseUrl: llm.baseUrl,
        fallback: llm.fallback,
      });

      // Attach tool outputs (best-effort, ordered).
      const newToolMsgs = history.slice(toolMessagesStartIdx).filter((m) => m?.role === 'tool') as any[];
      for (let i = 0; i < toolCalls.length && i < newToolMsgs.length; i += 1) {
        toolCalls[i]!.toolResult = typeof newToolMsgs[i]?.content === 'string' ? newToolMsgs[i].content : String(newToolMsgs[i]?.content ?? '');
      }

      return {
        text: reply,
        messages: toPublicMessages(history),
        toolCalls,
        meta: {
          providerId: llm.providerId,
          model: llm.model,
          sessionId: id,
          elapsedMs: Math.max(0, Date.now() - started),
        },
      };
    };

    return { id, messages, sendText };
  };

  const close = async () => {
    await discoveryManager.close();
    sessions.clear();
  };

  return { session, diagnostics, close };
}

// Convenience re-exports for library consumers (types only).
export type { WunderlandAgentConfig, WunderlandProviderId, WunderlandWorkspace } from '../api/types.js';
export { WunderlandConfigError } from '../config/errors.js';
export type { WunderlandConfigIssue } from '../config/errors.js';
