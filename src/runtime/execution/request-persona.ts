// @ts-nocheck
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../core/index.js';
import { resolveEffectiveAgentConfig } from '../config/effective-agent-config.js';
import { createConfiguredRagTools } from '../rag/runtime-tools.js';
import type { PersonaSummary } from '../config/persona-registry.js';
import type { WunderlandAgentConfig } from '../api/types.js';
import { resolveAgentDisplayName } from './agent-identity.js';
import { buildAgenticSystemPrompt, type SystemPromptOptions } from './system-prompt-builder.js';
import type { NormalizedRuntimePolicy } from './policy.js';
import type { ToolInstance } from './tool-calling.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
};

export interface RequestScopedPersonaRuntime {
  agentConfig: WunderlandAgentConfig;
  systemPrompt: string;
  activePersonaId: string;
  selectedPersona?: PersonaSummary;
  availablePersonas?: PersonaSummary[];
  displayName: string;
  seedId: string;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function extractRequestedPersonaId(parsed: Record<string, unknown>): string | undefined {
  for (const candidate of [parsed['personaId'], parsed['selectedPersonaId']]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 128);
    }
  }
  return undefined;
}

export function buildPersonaSessionKey(sessionId: string, personaId: string): string {
  return `${sessionId}::persona:${personaId}`;
}

export function createRequestScopedToolMap(
  baseToolMap: Map<string, ToolInstance>,
  agentConfig: WunderlandAgentConfig,
): Map<string, ToolInstance> {
  const toolMap = new Map(baseToolMap);

  toolMap.delete('memory_read');
  toolMap.delete('rag_query');

  for (const ragTool of createConfiguredRagTools(agentConfig)) {
    if (!ragTool?.name) continue;
    toolMap.set(ragTool.name, ragTool as unknown as ToolInstance);
  }

  return toolMap;
}

export async function resolveRequestScopedPersonaRuntime(opts: {
  rawAgentConfig: WunderlandAgentConfig;
  requestedPersonaId: string;
  workingDirectory: string;
  policy: NormalizedRuntimePolicy;
  mode: SystemPromptOptions['mode'];
  lazyTools: boolean;
  autoApproveToolCalls: boolean;
  turnApprovalMode?: string;
  skillsPrompt?: string;
  channelNames?: string[];
  logger?: LoggerLike;
  globalAgentName?: string;
  displayNameFallback?: string;
}): Promise<RequestScopedPersonaRuntime | undefined> {
  const rawAgentConfig = opts.rawAgentConfig ?? {};
  const requestedPersonaId = opts.requestedPersonaId.trim();
  if (!requestedPersonaId) return undefined;

  const overrideConfig: WunderlandAgentConfig = {
    ...rawAgentConfig,
    selectedPersonaId: requestedPersonaId,
    // Request-scoped persona switching must bypass any persisted systemPrompt,
    // otherwise the explicit config prompt will mask the selected persona.
    systemPrompt: undefined,
    personaRegistry:
      rawAgentConfig.personaRegistry && typeof rawAgentConfig.personaRegistry === 'object' && !Array.isArray(rawAgentConfig.personaRegistry)
        ? { ...rawAgentConfig.personaRegistry, selectedPersonaId: requestedPersonaId }
        : rawAgentConfig.personaRegistry,
  };

  const effectiveConfigResult = await resolveEffectiveAgentConfig({
    agentConfig: overrideConfig,
    workingDirectory: opts.workingDirectory,
    logger: opts.logger,
  });

  if (effectiveConfigResult.selectedPersona?.id !== requestedPersonaId) {
    return undefined;
  }

  const cfg = effectiveConfigResult.agentConfig;
  const seedId = String(cfg.seedId || 'seed_local_agent');
  const displayName = resolveAgentDisplayName({
    displayName: cfg.displayName,
    agentName: cfg.agentName,
    globalAgentName: opts.globalAgentName,
    seedId,
    fallback: opts.displayNameFallback ?? 'My Agent',
  });
  const description = String(cfg.bio || 'Autonomous Wunderbot');
  const p = cfg.personality || {};

  const security = {
    ...DEFAULT_SECURITY_PROFILE,
    enablePreLLMClassifier:
      (cfg as any)?.security?.preLLMClassifier
      ?? (cfg as any)?.security?.preLlmClassifier
      ?? DEFAULT_SECURITY_PROFILE.enablePreLLMClassifier,
    enableDualLLMAuditor:
      (cfg as any)?.security?.dualLLMAudit
      ?? (cfg as any)?.security?.dualLlmAuditor
      ?? DEFAULT_SECURITY_PROFILE.enableDualLLMAuditor,
    enableOutputSigning:
      (cfg as any)?.security?.outputSigning
      ?? DEFAULT_SECURITY_PROFILE.enableOutputSigning,
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

  const activePersonaId =
    typeof cfg.selectedPersonaId === 'string' && cfg.selectedPersonaId.trim()
      ? cfg.selectedPersonaId.trim()
      : seedId;

  const systemPrompt = buildAgenticSystemPrompt({
    seed,
    policy: opts.policy,
    mode: opts.mode,
    lazyTools: opts.lazyTools,
    autoApproveToolCalls: opts.autoApproveToolCalls,
    channelNames: opts.channelNames,
    skillsPrompt: opts.skillsPrompt || undefined,
    turnApprovalMode: opts.turnApprovalMode,
  });

  return {
    agentConfig: cfg,
    systemPrompt,
    activePersonaId,
    selectedPersona: effectiveConfigResult.selectedPersona,
    availablePersonas: effectiveConfigResult.availablePersonas,
    displayName,
    seedId,
  };
}
