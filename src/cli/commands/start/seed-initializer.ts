/**
 * @fileoverview Seed creation, identity resolution, OTEL setup, security profile.
 * Extracted from start.ts lines 297-357.
 */

import { resolveAgentDisplayName } from '../../../runtime/agent-identity.js';
import { resolveStrictToolNames } from '../../../runtime/tool-function-names.js';
import {
  normalizeRuntimePolicy,
  getPermissionsForSet,
} from '../../security/runtime-policy.js';
import { startWunderlandOtel } from '../../observability/otel.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../../../core/index.js';

export async function initializeSeed(ctx: any): Promise<void> {
  const { cfg, globalConfig } = ctx;

  const seedId = String(cfg.seedId || 'seed_local_agent');
  const displayName = resolveAgentDisplayName({
    displayName: cfg.displayName,
    agentName: cfg.agentName,
    globalAgentName: globalConfig.agentName,
    seedId,
    fallback: 'My Agent',
  });
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
  const strictToolNames = resolveStrictToolNames((cfg as any)?.toolCalling?.strictToolNames);

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

  ctx.seedId = seedId;
  ctx.displayName = displayName;
  ctx.description = description;
  ctx.policy = policy;
  ctx.permissions = permissions;
  ctx.seed = seed;
  ctx.security = security;
  ctx.LOCAL_ONLY_CHANNELS = LOCAL_ONLY_CHANNELS;
  ctx.CLI_REQUIRED_CHANNELS = CLI_REQUIRED_CHANNELS;
  ctx.turnApprovalMode = turnApprovalMode;
  ctx.strictToolNames = strictToolNames;
}
