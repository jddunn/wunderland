/**
 * @fileoverview Runtime policy helpers for Wunderland.
 *
 * Normalizes agent.config.json policy fields (tier/permissions/modes) and
 * filters tool exposure accordingly.
 *
 * This is intentionally conservative: permission sets and tool access profiles
 * are enforced even in autonomous mode. "Autonomous" only affects approvals,
 * not what the agent is allowed to do.
 */

import {
  PERMISSION_SETS,
  SECURITY_TIERS,
  type GranularPermissions,
  type PermissionSetName,
  type SecurityTierName,
} from '../security/SecurityTiers.js';
import {
  getToolAccessProfile,
  getToolCategory,
  isValidToolAccessProfile,
  type ToolCategory,
  type ToolAccessProfileName,
} from '../social/ToolAccessProfiles.js';
import type { FolderPermissionConfig } from '../security/FolderPermissions.js';
import type { ToolInstance } from './tool-calling.js';

export type ExecutionMode = 'autonomous' | 'human-all' | 'human-dangerous';

/**
 * Resolved guardrail pack overrides from `agent.config.json` `security.guardrailPacks`.
 * Each key toggles a specific guardrail extension pack on/off, overriding tier defaults.
 */
export interface GuardrailPackOverrides {
  /** Four-tier PII detection and redaction. */
  piiRedaction?: boolean;
  /** ML-based toxicity, injection, and jailbreak detection. */
  mlClassifiers?: boolean;
  /** Embedding-based topic enforcement + drift detection. */
  topicality?: boolean;
  /** OWASP Top 10 code safety scanning. */
  codeSafety?: boolean;
  /** RAG-grounded hallucination detection via NLI. */
  groundingGuard?: boolean;
}

/**
 * Fully normalized runtime policy resolved from agent config + CLI flags.
 *
 * This structure is passed to every runtime subsystem (tool filtering,
 * authorization, system prompt building, guardrails) so they all use a
 * single, consistent set of resolved values.
 */
export type NormalizedRuntimePolicy = {
  securityTier: SecurityTierName;
  permissionSet: PermissionSetName;
  toolAccessProfile: ToolAccessProfileName;
  executionMode: ExecutionMode;
  wrapToolOutputs: boolean;
  folderPermissions?: FolderPermissionConfig;
  /**
   * Per-agent guardrail pack overrides (from `security.guardrailPacks`).
   * When present, merged on top of the tier's default pack config.
   */
  guardrailPackOverrides?: GuardrailPackOverrides;
  /**
   * When `true`, all guardrail extension packs are disabled.
   * Equivalent to `--no-guardrails` CLI flag.
   */
  disableGuardrailPacks?: boolean;
  /**
   * Explicit list of pack short-names to enable (overrides tier defaults).
   * Equivalent to `--guardrails=pii,code-safety` CLI flag.
   */
  enableOnlyGuardrailPacks?: string[];
};

export function normalizeSecurityTier(raw: unknown): SecurityTierName {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v && (v in SECURITY_TIERS)) return v as SecurityTierName;
  return 'balanced';
}

export function normalizePermissionSet(
  raw: unknown,
  tier: SecurityTierName,
): PermissionSetName {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v && (v in PERMISSION_SETS)) return v as PermissionSetName;
  // Default to tier recommendation when not explicitly set.
  return SECURITY_TIERS[tier]?.permissionSet ?? 'supervised';
}

export function normalizeExecutionMode(
  raw: unknown,
  tier: SecurityTierName,
): ExecutionMode {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === 'autonomous' || v === 'human-all' || v === 'human-dangerous') return v;

  // Tier-derived default when not specified.
  if (tier === 'dangerous' || tier === 'permissive') return 'autonomous';
  if (tier === 'paranoid') return 'human-all';
  return 'human-dangerous';
}

export function normalizeToolAccessProfile(raw: unknown): ToolAccessProfileName {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v && isValidToolAccessProfile(v)) return v;
  return 'assistant';
}

export function normalizeWrapToolOutputs(raw: unknown, tier: SecurityTierName): boolean {
  // Opt-out knob. Default ON except in `dangerous`.
  if (typeof raw === 'boolean') return raw;
  return tier !== 'dangerous';
}

export function normalizeFolderPermissions(raw: unknown): FolderPermissionConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as FolderPermissionConfig;
}

/**
 * Extracts guardrail pack overrides from `security.guardrailPacks` in agent config.
 *
 * @param raw - The `security.guardrailPacks` value from agent.config.json.
 * @returns Normalized overrides, or `undefined` if none specified.
 */
export function normalizeGuardrailPackOverrides(raw: unknown): GuardrailPackOverrides | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: GuardrailPackOverrides = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'boolean') {
      (result as any)[key] = value;
      hasAny = true;
    }
  }
  return hasAny ? result : undefined;
}

/**
 * Normalizes the full runtime policy from agent config (merged with CLI overrides).
 *
 * This is the single source of truth for all runtime security decisions.
 * CLI flags like `--security-tier`, `--no-guardrails`, and `--guardrails=...`
 * should be merged into the `agentConfig` object before calling this function.
 *
 * @param agentConfig - Merged agent config object (config file + CLI overrides).
 * @returns Fully normalized runtime policy.
 */
export function normalizeRuntimePolicy(agentConfig: any): NormalizedRuntimePolicy {
  const securityTier = normalizeSecurityTier(agentConfig?.securityTier ?? agentConfig?.security?.tier);
  const permissionSet = normalizePermissionSet(agentConfig?.permissionSet ?? agentConfig?.security?.permissionSet, securityTier);
  const toolAccessProfile = normalizeToolAccessProfile(agentConfig?.toolAccessProfile);
  const executionMode = normalizeExecutionMode(agentConfig?.executionMode, securityTier);
  const wrapToolOutputs = normalizeWrapToolOutputs(agentConfig?.security?.wrapToolOutputs, securityTier);
  const folderPermissions = normalizeFolderPermissions(agentConfig?.security?.folderPermissions);
  const guardrailPackOverrides = normalizeGuardrailPackOverrides(agentConfig?.security?.guardrailPacks);

  // CLI-level guardrail flags (injected by chat.ts / start command before calling this).
  const disableGuardrailPacks = agentConfig?.disableGuardrailPacks === true;
  const enableOnlyGuardrailPacks: string[] | undefined =
    Array.isArray(agentConfig?.enableOnlyGuardrailPacks) && agentConfig.enableOnlyGuardrailPacks.length > 0
      ? agentConfig.enableOnlyGuardrailPacks
      : undefined;

  return {
    securityTier,
    permissionSet,
    toolAccessProfile,
    executionMode,
    wrapToolOutputs,
    folderPermissions,
    guardrailPackOverrides,
    disableGuardrailPacks,
    enableOnlyGuardrailPacks,
  };
}

export function getPermissionsForSet(name: PermissionSetName): GranularPermissions {
  return {
    filesystem: { ...PERMISSION_SETS[name].filesystem },
    network: { ...PERMISSION_SETS[name].network },
    system: { ...PERMISSION_SETS[name].system },
    data: { ...PERMISSION_SETS[name].data },
  };
}

function isFilesystemReadTool(toolName: string): boolean {
  return toolName === 'file_read' || toolName === 'list_directory' || toolName === 'file_search' || toolName === 'read_file' || toolName === 'file_info';
}

function isFilesystemWriteTool(toolName: string): boolean {
  return toolName === 'file_write' || toolName === 'file_append' || toolName === 'file_delete' || toolName === 'write_file';
}

function isCliExecutionTool(toolName: string): boolean {
  return toolName === 'shell_execute' || toolName === 'run_command' || toolName === 'shell_exec';
}

function isNetworkTool(tool: ToolInstance): boolean {
  const name = tool.name || '';
  if (name === 'web_search' || name === 'news_search') return true;
  if (name.startsWith('browser_')) return true;
  if (Array.isArray(tool.requiredCapabilities)) {
    return tool.requiredCapabilities.some((c) => typeof c === 'string' && c.startsWith('capability:web_'));
  }
  const cat = typeof tool.category === 'string' ? tool.category.trim().toLowerCase() : '';
  if (cat === 'search' || cat === 'research') return true;
  return false;
}

function isExternalApiSideEffectTool(tool: ToolInstance): boolean {
  // Conservative rule: if a tool is marked as having side effects and it isn't
  // clearly a local-only operation (filesystem/system/memory), treat it as an
  // external API side effect for permission-set gating.
  if (tool.hasSideEffects !== true) return false;

  const cat = typeof tool.category === 'string' ? tool.category.trim().toLowerCase() : '';
  if (!cat) return true;
  if (cat === 'filesystem' || cat === 'system' || cat === 'memory') return false;
  return true;
}

function isMemoryReadTool(toolName: string): boolean {
  return toolName === 'memory_read' || toolName === 'conversation_history';
}

function isMemoryWriteTool(toolName: string): boolean {
  return toolName === 'memory_write';
}

export function filterToolMapByPolicy(opts: {
  toolMap: Map<string, ToolInstance>;
  toolAccessProfile: ToolAccessProfileName;
  permissions: GranularPermissions;
}): { toolMap: Map<string, ToolInstance>; dropped: Array<{ tool: string; reason: string }> } {
  const profile = getToolAccessProfile(opts.toolAccessProfile);
  const out = new Map<string, ToolInstance>();
  const dropped: Array<{ tool: string; reason: string }> = [];

  function mapToolCategory(tool: ToolInstance): ToolCategory | undefined {
    // Prefer explicit tool-name mapping when known.
    const byId = getToolCategory(tool.name);
    if (byId) return byId;

    // Fall back to extension-provided category strings (best-effort).
    const c = typeof tool.category === 'string' ? tool.category.trim().toLowerCase() : '';
    if (!c) return undefined;

    if (c === 'research') return 'search';
    if (c === 'search') return 'search';
    if (c === 'media') return 'media';
    if (c === 'productivity') return 'productivity';
    if (c === 'communication' || c === 'communications') return 'communication';
    if (c === 'social') return 'social';
    if (c === 'system') return 'system';
    if (c === 'filesystem') return 'filesystem';

    return undefined;
  }

  function isAllowedByProfile(tool: ToolInstance): boolean {
    // Always apply filesystem/system overrides by tool name.
    if (isFilesystemReadTool(tool.name) || isFilesystemWriteTool(tool.name)) {
      const cat: ToolCategory = 'filesystem';
      if (profile.blockedCategories.includes(cat)) return false;
      return profile.allowedCategories.includes(cat);
    }
    if (isCliExecutionTool(tool.name)) {
      const cat: ToolCategory = 'system';
      if (profile.blockedCategories.includes(cat)) return false;
      return profile.allowedCategories.includes(cat);
    }

    const cat = mapToolCategory(tool);
    if (!cat) return profile.name === 'unrestricted';
    if (profile.blockedCategories.includes(cat)) return false;
    return profile.allowedCategories.includes(cat);
  }

  for (const [name, tool] of opts.toolMap.entries()) {
    if (!tool?.name) continue;

    if (!isAllowedByProfile(tool)) {
      dropped.push({ tool: tool.name, reason: `blocked_by_tool_access_profile:${profile.name}` });
      continue;
    }

    if (isFilesystemReadTool(tool.name) && opts.permissions.filesystem.read !== true) {
      dropped.push({ tool: tool.name, reason: 'blocked_by_permission_set:filesystem.read=false' });
      continue;
    }
    if (isFilesystemWriteTool(tool.name) && opts.permissions.filesystem.write !== true) {
      dropped.push({ tool: tool.name, reason: 'blocked_by_permission_set:filesystem.write=false' });
      continue;
    }
    if (isCliExecutionTool(tool.name) && opts.permissions.system.cliExecution !== true) {
      dropped.push({ tool: tool.name, reason: 'blocked_by_permission_set:system.cliExecution=false' });
      continue;
    }
    if (isNetworkTool(tool) && opts.permissions.network.httpRequests !== true) {
      dropped.push({ tool: tool.name, reason: 'blocked_by_permission_set:network.httpRequests=false' });
      continue;
    }
    if (isMemoryReadTool(tool.name) && opts.permissions.data.memoryRead !== true) {
      dropped.push({ tool: tool.name, reason: 'blocked_by_permission_set:data.memoryRead=false' });
      continue;
    }
    if (isMemoryWriteTool(tool.name) && opts.permissions.data.memoryWrite !== true) {
      dropped.push({ tool: tool.name, reason: 'blocked_by_permission_set:data.memoryWrite=false' });
      continue;
    }
    if (isExternalApiSideEffectTool(tool) && opts.permissions.network.externalApis !== true) {
      dropped.push({ tool: tool.name, reason: 'blocked_by_permission_set:network.externalApis=false' });
      continue;
    }

    out.set(name, tool);
  }

  return { toolMap: out, dropped };
}
