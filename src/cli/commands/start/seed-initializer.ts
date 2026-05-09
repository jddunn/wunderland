// @ts-nocheck
/**
 * @fileoverview Seed creation, identity resolution, OTEL setup, security profile.
 * Extracted from start.ts lines 297-357.
 */

import { resolveAgentDisplayName } from '../../../runtime/identity/agent-identity.js';
import { resolveStrictToolNames } from '../../../runtime/tools/tool-function-names.js';
import {
  normalizeRuntimePolicy,
  getPermissionsForSet,
} from '../../../runtime/tools/policy.js';
import { startWunderlandOtel } from '../../../platform/observability/otel.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../../../core/index.js';

export async function initializeSeed(ctx: any): Promise<void> {
  const { cfg, globalConfig, flags } = ctx;

  // ── Inject CLI guardrail flags into the config before policy normalization ──
  // --no-guardrails → disableGuardrailPacks
  // --guardrails=pii,code-safety → enableOnlyGuardrailPacks
  if (flags?.['no-guardrails'] === true) {
    cfg.disableGuardrailPacks = true;
  }
  const guardrailsFlag = typeof flags?.['guardrails'] === 'string'
    ? String(flags['guardrails']).trim()
    : '';
  if (guardrailsFlag) {
    cfg.enableOnlyGuardrailPacks = guardrailsFlag.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  if (flags?.['no-guardrail-override'] === true) {
    cfg.hitl = {
      ...(cfg.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl) ? cfg.hitl : {}),
      guardrailOverride: false,
    };
  }

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

  // ── Content Security Pipeline (optional) ──────────────────────────────────
  // Creates the WunderlandSecurityPipeline from the resolved tier + config
  // overrides. Fail-safe: if creation fails, agent runs without content guardrails.
  let guardrailSummary: { active: string[]; total: number } | null = null;
  try {
    const { initializeSecurityPipeline } = await import('../../../runtime/tool-helpers.js');
    guardrailSummary = await initializeSecurityPipeline({
      securityTier: policy.securityTier,
      guardrailPackOverrides: policy.guardrailPackOverrides,
      disableGuardrailPacks: policy.disableGuardrailPacks,
      enableOnlyPacks: policy.enableOnlyGuardrailPacks,
      seedId,
    });
  } catch (err: any) {
    console.warn(
      '[wunderland] Security pipeline not available, running without content guardrails:',
      err?.message ?? err,
    );
  }

  // Log active guardrail packs for operator visibility.
  if (guardrailSummary) {
    const { active, total } = guardrailSummary;
    if (active.length > 0) {
      console.log(
        `[wunderland] Security tier: ${policy.securityTier}`,
      );
      console.log(
        `[wunderland] Guardrail packs: ${active.join(', ')} (${active.length} of ${total} active)`,
      );
    } else {
      console.log(
        `[wunderland] Security tier: ${policy.securityTier} (no guardrail packs active)`,
      );
    }
  } else {
    console.log(
      `[wunderland] Security tier: ${policy.securityTier} (content guardrails unavailable)`,
    );
  }

  ctx.seedId = seedId;
  ctx.displayName = displayName;
  ctx.description = description;
  ctx.policy = policy;
  ctx.permissions = permissions;
  ctx.seed = seed;
  ctx.security = security;
  ctx.guardrailSummary = guardrailSummary;
  ctx.LOCAL_ONLY_CHANNELS = LOCAL_ONLY_CHANNELS;
  ctx.CLI_REQUIRED_CHANNELS = CLI_REQUIRED_CHANNELS;
  ctx.turnApprovalMode = turnApprovalMode;
  ctx.strictToolNames = strictToolNames;
}
