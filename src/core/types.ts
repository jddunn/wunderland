/**
 * @fileoverview Core types for Wunderland - Adaptive AI Agent Framework
 * @module wunderland/core/types
 */

// Re-export AgentOS types for convenience.
//
// NOTE: `@framers/agentos` does not export these from its root barrel in some builds.
// Import from the concrete subpath so consumers can rely on this re-export.
export type {
  IPersonaDefinition,
  PersonaMoodAdaptationConfig,
} from '@framers/agentos/cognitive_substrate/personas/IPersonaDefinition';

// ============================================================================
// HEXACO Personality Model
// ============================================================================

/**
 * HEXACO personality traits - a six-factor model of personality structure.
 * Each trait ranges from 0.0 to 1.0.
 *
 * @see https://hexaco.org/
 */
export interface HEXACOTraits {
  /**
   * Honesty-Humility: Sincerity, fairness, greed-avoidance, modesty.
   * High scores indicate genuineness and lack of desire to manipulate.
   */
  honesty_humility: number;

  /**
   * Emotionality: Fearfulness, anxiety, dependence, sentimentality.
   * High scores indicate stronger emotional reactions and need for support.
   */
  emotionality: number;

  /**
   * Extraversion: Social self-esteem, social boldness, sociability, liveliness.
   * High scores indicate outgoing, energetic, talkative behavior.
   */
  extraversion: number;

  /**
   * Agreeableness: Forgiveness, gentleness, flexibility, patience.
   * High scores indicate cooperative, trusting, helpful tendencies.
   */
  agreeableness: number;

  /**
   * Conscientiousness: Organization, diligence, perfectionism, prudence.
   * High scores indicate careful, disciplined, achievement-oriented behavior.
   */
  conscientiousness: number;

  /**
   * Openness to Experience: Aesthetic appreciation, inquisitiveness, creativity, unconventionality.
   * High scores indicate imaginative, curious, open-minded tendencies.
   */
  openness: number;
}

/**
 * Default HEXACO traits for a balanced agent persona.
 */
export const DEFAULT_HEXACO_TRAITS: HEXACOTraits = {
  honesty_humility: 0.8,
  emotionality: 0.5,
  extraversion: 0.6,
  agreeableness: 0.7,
  conscientiousness: 0.8,
  openness: 0.7,
};

// ============================================================================
// Security Profile
// ============================================================================

/**
 * Security profile for a Wunderland Seed agent.
 */
export interface SecurityProfile {
  /** Enable pre-LLM input classification */
  enablePreLLMClassifier: boolean;

  /** Enable dual-LLM audit for outputs */
  enableDualLLMAuditor: boolean;

  /** Enable HMAC signing of outputs */
  enableOutputSigning: boolean;

  /** Secret key for HMAC signing (should be securely stored) */
  signingSecretEnvVar?: string;

  /** Custom injection patterns to detect */
  customInjectionPatterns?: string[];

  /** Risk threshold for flagging (0.0 - 1.0) */
  riskThreshold?: number;
}

/**
 * Default security profile with all layers enabled.
 */
export const DEFAULT_SECURITY_PROFILE: SecurityProfile = {
  enablePreLLMClassifier: true,
  enableDualLLMAuditor: true,
  enableOutputSigning: true,
  riskThreshold: 0.7,
};

// ============================================================================
// Inference Hierarchy
// ============================================================================

/**
 * Model target specification for inference routing.
 */
export interface ModelTarget {
  /** LLM provider ID (e.g., 'ollama', 'openai') */
  providerId: string;

  /** Model ID within the provider */
  modelId: string;

  /** Role in the inference hierarchy */
  role: 'router' | 'primary' | 'auditor' | 'fallback';

  /** Maximum tokens for this model */
  maxTokens?: number;

  /** Temperature for generation */
  temperature?: number;
}

/**
 * Configuration for hierarchical inference routing.
 */
export interface InferenceHierarchyConfig {
  /** Fast model for routing decisions and auditing */
  routerModel: ModelTarget;

  /** Primary model for complex reasoning */
  primaryModel: ModelTarget;

  /** Model for security auditing (can be same as router) */
  auditorModel: ModelTarget;

  /** Fallback chain if primary fails */
  fallbackChain?: ModelTarget[];
}

/**
 * Default inference hierarchy — OpenAI cloud models.
 * Router/auditor use gpt-4.1-mini (fast + cheap).
 * Primary defaults to gpt-4.1 (workhorse); NewsroomAgency applies weighted
 * selection (80% gpt-4.1, 20% gpt-4.5) at post-generation time.
 */
export const DEFAULT_INFERENCE_HIERARCHY: InferenceHierarchyConfig = {
  routerModel: {
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    role: 'router',
    maxTokens: 512,
    temperature: 0.1,
  },
  primaryModel: {
    providerId: 'openai',
    modelId: 'gpt-4.1',
    role: 'primary',
    maxTokens: 4096,
    temperature: 0.7,
  },
  auditorModel: {
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    role: 'auditor',
    maxTokens: 256,
    temperature: 0.0,
  },
};

// ============================================================================
// Step-Up Authorization
// ============================================================================

/**
 * Tool risk tiers for step-up authorization.
 */
export enum ToolRiskTier {
  /** Execute without approval - read-only, logging operations */
  TIER_1_AUTONOMOUS = 1,

  /** Execute but queue for async human review */
  TIER_2_ASYNC_REVIEW = 2,

  /** Require synchronous human approval before execution */
  TIER_3_SYNC_HITL = 3,
}

/**
 * Trigger conditions for escalating tool risk tier.
 */
export interface EscalationTrigger {
  /** Condition type */
  condition:
    | 'high_value_threshold'
    | 'sensitive_data_detected'
    | 'external_api_call'
    | 'irreversible_action'
    | 'custom';

  /** Tier to escalate to */
  escalateTo: ToolRiskTier;

  /** Additional parameters for the condition */
  parameters?: Record<string, unknown>;

  /** Custom condition function name (for 'custom' type) */
  customConditionFn?: string;
}

/**
 * Contextual overrides that can lower the risk tier.
 */
export interface ContextualOverride {
  /** Context condition */
  context: 'user_verified' | 'session_trusted' | 'emergency_mode' | 'admin_override';

  /** Override tier (undefined = no override) */
  overrideTier?: ToolRiskTier;
}

/**
 * Configuration for step-up authorization.
 */
export interface StepUpAuthorizationConfig {
  /** Default tier for unclassified tools */
  defaultTier: ToolRiskTier;

  /** Tool ID to tier mappings */
  toolTierOverrides?: Record<string, ToolRiskTier>;

  /** Category to tier mappings */
  categoryTierOverrides?: Record<string, ToolRiskTier>;

  /** Escalation triggers */
  escalationTriggers?: EscalationTrigger[];

  /** Contextual overrides */
  contextualOverrides?: ContextualOverride[];

  /** Timeout for HITL approval requests (ms) */
  approvalTimeoutMs?: number;

  /**
   * When true, auto-approve ALL tool calls regardless of tier, category,
   * side effects, capabilities, or escalation triggers. Everything executes
   * as Tier 1 (autonomous) with no human intervention.
   *
   * Use with `--dangerously-skip-permissions` or `--yes` CLI flags.
   */
  autoApproveAll?: boolean;
}

/**
 * Default step-up authorization config.
 * Uses tiered authorization: read-only = Tier 1, data/API/comms = Tier 2,
 * financial/system = Tier 3 (requires HITL).
 */
export const DEFAULT_STEP_UP_AUTH_CONFIG: StepUpAuthorizationConfig = {
  // Read-only tools are always treated as Tier 1. This default tier is the
  // fallback for *side-effecting* tools that don't match any explicit override.
  // Safer default: require synchronous human approval for unknown side effects.
  defaultTier: ToolRiskTier.TIER_3_SYNC_HITL,
  categoryTierOverrides: {
    data_modification: ToolRiskTier.TIER_2_ASYNC_REVIEW,
    external_api: ToolRiskTier.TIER_2_ASYNC_REVIEW,
    financial: ToolRiskTier.TIER_3_SYNC_HITL,
    communication: ToolRiskTier.TIER_2_ASYNC_REVIEW,
    system: ToolRiskTier.TIER_3_SYNC_HITL,
  },
  escalationTriggers: [
    {
      condition: 'high_value_threshold',
      escalateTo: ToolRiskTier.TIER_3_SYNC_HITL,
      parameters: { thresholdUSD: 100 },
    },
    {
      condition: 'sensitive_data_detected',
      escalateTo: ToolRiskTier.TIER_3_SYNC_HITL,
    },
    {
      condition: 'irreversible_action',
      escalateTo: ToolRiskTier.TIER_3_SYNC_HITL,
    },
  ],
  approvalTimeoutMs: 300000, // 5 minutes
};

/**
 * Fully autonomous step-up authorization config.
 * Auto-approves ALL tool calls: skills, side effects, capabilities,
 * destructive commands, build commands, and every other tool type.
 * No escalation triggers, no tier gates, no HITL.
 *
 * Used when `--dangerously-skip-permissions` or `--yes` is passed.
 */
export const FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG: StepUpAuthorizationConfig = {
  defaultTier: ToolRiskTier.TIER_1_AUTONOMOUS,
  autoApproveAll: true,
  categoryTierOverrides: {},
  escalationTriggers: [],
  contextualOverrides: [],
};

// ============================================================================
// Wunderland Seed Configuration
// ============================================================================

/**
 * Full configuration for a Wunderland Seed agent.
 */
export interface WunderlandSeedConfig {
  /** Unique seed identifier */
  seedId: string;

  /** Human-readable name */
  name: string;

  /** Description of the agent's purpose */
  description: string;

  /** HEXACO personality traits */
  hexacoTraits: HEXACOTraits;

  /** Security profile configuration */
  securityProfile: SecurityProfile;

  /**
   * Named security tier preset. When set, overrides individual security
   * profile flags with the tier's defaults.
   *
   * @see {@link SecurityTierName} from `wunderland/security/SecurityTiers`
   */
  securityTier?: 'dangerous' | 'permissive' | 'balanced' | 'strict' | 'paranoid';

  /** Inference hierarchy configuration */
  inferenceHierarchy: InferenceHierarchyConfig;

  /** Step-up authorization configuration */
  stepUpAuthConfig: StepUpAuthorizationConfig;

  /** Channel bindings (which channels this seed operates on) */
  channelBindings?: ChannelBinding[];

  /** Base system prompt (can be extended by HEXACO mapping) */
  baseSystemPrompt?: string;

  /** Evolved behavioral adaptations managed by PromptEvolution (runtime-only, not user-settable) */
  evolvedAdaptations?: string[];

  /** Tool IDs this seed is allowed to use */
  allowedToolIds?: string[];

  /** Capabilities this seed has access to */
  allowedCapabilities?: string[];

  /** Named tool access profile for this seed. Defaults to 'social-citizen' in public mode. */
  toolAccessProfile?: 'social-citizen' | 'social-observer' | 'social-creative' | 'assistant' | 'unrestricted';

  /** Per-agent overrides on top of the tool access profile. */
  toolAccessOverrides?: {
    /** Additional tool IDs to allow beyond the profile */
    additionalAllowed?: string[];
    /** Additional tool IDs to block, even if the profile allows them */
    additionalBlocked?: string[];
  };

  /** Suggested skill IDs for this agent (from preset or user selection) */
  suggestedSkills?: string[];

  /** Suggested extensions for this agent (from preset or user selection) */
  suggestedExtensions?: {
    /** Tool extension names (e.g., "web-search", "web-browser") */
    tools?: string[];
    /** Voice provider extension names (e.g., "voice-twilio") */
    voice?: string[];
    /** Productivity extension names (e.g., "calendar-google") */
    productivity?: string[];
  };

  /** Per-extension overrides (enabled, priority, options) */
  extensionOverrides?: Record<
    string,
    {
      /** Whether this extension is enabled */
      enabled?: boolean;
      /** Priority/weight for this extension (higher = preferred) */
      priority?: number;
      /** Extension-specific options */
      options?: Record<string, unknown>;
    }
  >;
}

/**
 * Channel binding configuration.
 */
export interface ChannelBinding {
  /** Channel platform */
  platform:
    | 'telegram'
    | 'whatsapp'
    | 'discord'
    | 'slack'
    | 'webchat'
    | 'signal'
    | 'imessage'
    | 'google-chat'
    | 'teams'
    | 'matrix'
    | 'zalo'
    | 'email'
    | 'sms'
    | (string & {});

  /** Channel/workspace ID */
  channelId: string;

  /** Whether this binding is active */
  isActive: boolean;

  /** Platform-specific configuration */
  platformConfig?: Record<string, unknown>;
}

// ============================================================================
// Intent Chain & Audit Trail
// ============================================================================

/**
 * Entry in the intent chain audit trail.
 */
export interface IntentChainEntry {
  /** Unique step identifier */
  stepId: string;

  /** Timestamp of this step */
  timestamp: Date;

  /** Action performed */
  action: string;

  /** Hash of the input to this step */
  inputHash: string;

  /** Hash of the output from this step */
  outputHash: string;

  /** Model used for this step */
  modelUsed: string;

  /** Security flags raised during this step */
  securityFlags: string[];

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Signed agent output with cryptographic verification.
 */
export interface SignedAgentOutput {
  /** Unique output identifier */
  outputId: string;

  /** Seed ID that generated this output */
  seedId: string;

  /** Timestamp of generation */
  timestamp: Date;

  /** The actual content/response */
  content: unknown;

  /** Full intent chain audit trail */
  intentChain: IntentChainEntry[];

  /** HMAC-SHA256 signature */
  signature: string;

  /** Verification hash for integrity checking */
  verificationHash: string;
}

// ============================================================================
// Routing Decision
// ============================================================================

/**
 * Result of inference routing decision.
 */
export interface RoutingDecision {
  /** Target model for this request */
  targetModel: ModelTarget;

  /** Reason for routing decision */
  routingReason: string;

  /** Classified complexity */
  complexity: 'simple' | 'moderate' | 'complex';

  /** Estimated cost */
  estimatedCost: number;

  /** Whether audit is required */
  requiresAudit: boolean;

  /** Classification confidence (0-1) */
  confidence: number;
}

// ============================================================================
// Authorization Result
// ============================================================================

/**
 * Result of step-up authorization check.
 */
export interface AuthorizationResult {
  /** Whether the action is authorized */
  authorized: boolean;

  /** Effective risk tier */
  tier: ToolRiskTier;

  /** Whether audit is required */
  auditRequired: boolean;

  /** Human decision (if Tier 3) */
  humanDecision?: {
    approved: boolean;
    decidedBy: string;
    decidedAt: Date;
    reason?: string;
  };

  /** Denial reason (if not authorized) */
  denialReason?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for HEXACOTraits.
 */
export function isValidHEXACOTraits(traits: unknown): traits is HEXACOTraits {
  if (typeof traits !== 'object' || traits === null) return false;
  const t = traits as Record<string, unknown>;
  const requiredKeys = [
    'honesty_humility',
    'emotionality',
    'extraversion',
    'agreeableness',
    'conscientiousness',
    'openness',
  ];
  return requiredKeys.every(
    (key) => typeof t[key] === 'number' && t[key] >= 0 && t[key] <= 1
  );
}

/**
 * Validates and clamps HEXACO traits to valid range.
 */
export function normalizeHEXACOTraits(traits: Partial<HEXACOTraits>): HEXACOTraits {
  const clamp = (v: number | undefined, def: number) =>
    Math.max(0, Math.min(1, v ?? def));

  return {
    honesty_humility: clamp(traits.honesty_humility, DEFAULT_HEXACO_TRAITS.honesty_humility),
    emotionality: clamp(traits.emotionality, DEFAULT_HEXACO_TRAITS.emotionality),
    extraversion: clamp(traits.extraversion, DEFAULT_HEXACO_TRAITS.extraversion),
    agreeableness: clamp(traits.agreeableness, DEFAULT_HEXACO_TRAITS.agreeableness),
    conscientiousness: clamp(traits.conscientiousness, DEFAULT_HEXACO_TRAITS.conscientiousness),
    openness: clamp(traits.openness, DEFAULT_HEXACO_TRAITS.openness),
  };
}
