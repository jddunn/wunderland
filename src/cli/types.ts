/**
 * @fileoverview CLI type definitions for the Wunderland CLI.
 * @module wunderland/cli/types
 */

// ── Config ──────────────────────────────────────────────────────────────────

/** Global CLI configuration persisted at ~/.wunderland/config.json */
export interface CliConfig {
  /** Agent display name (from setup wizard). */
  agentName?: string;
  /** Default LLM provider. */
  llmProvider?: string;
  /** Default model ID. */
  llmModel?: string;
  /** HEXACO preset key or 'custom'. */
  personalityPreset?: string;
  /** Custom HEXACO values (only used when preset === 'custom'). */
  customHexaco?: Record<string, number>;
  /** Active channel platforms. */
  channels?: string[];
  /** Enabled tool categories. */
  tools?: string[];
  /** Selected extensions (from extensions wizard). */
  extensions?: {
    tools?: string[];
    voice?: string[];
    productivity?: string[];
  };
  /** Selected skills (from extensions wizard). */
  skills?: string[];
  /** Security settings. */
  security?: {
    preLlmClassifier?: boolean;
    dualLlmAuditor?: boolean;
    outputSigning?: boolean;
    riskThreshold?: number;
  };
  /** Voice/TTS provider key name. */
  voiceProvider?: string;
  /** Voice/TTS model ID. */
  voiceModel?: string;
  /** Linked Rabbithole account email (if any). */
  linkedAccount?: string;
  /** Timestamp of last setup. */
  lastSetup?: string;

  /** Observability preferences (OTEL). */
  observability?: {
    /** Wizard-selected preset. */
    preset?: ObservabilityPreset;
  };
}

/** Parsed CLI arguments. */
export interface ParsedArgs {
  /** Positional arguments (command, subcommand, etc.). */
  positional: string[];
  /** Named flags (--key value or --flag). */
  flags: Record<string, string | boolean>;
}

/** Global flags available on every command. */
export interface GlobalFlags {
  help: boolean;
  version: boolean;
  quiet: boolean;
  yes: boolean;
  noColor: boolean;
  dryRun: boolean;
  tui: boolean;
  noTui: boolean;
  config?: string;
}

/** Command handler signature. */
export type CommandHandler = (
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
) => Promise<void>;

// ── Wizard ──────────────────────────────────────────────────────────────────

/** Setup wizard mode. */
export type SetupMode = 'quickstart' | 'advanced';

/** Wizard state accumulated across steps. */
export interface WizardState {
  mode: SetupMode;
  /** Observability preset (OpenTelemetry). */
  observabilityPreset: ObservabilityPreset;
  /** LLM provider keys collected. */
  apiKeys: Record<string, string>;
  /** Selected LLM provider. */
  llmProvider?: string;
  /** Selected model. */
  llmModel?: string;
  /** HEXACO preset key or 'custom'. */
  personalityPreset?: string;
  /** Custom HEXACO overrides. */
  customHexaco?: Record<string, number>;
  /** Selected channel platforms. */
  channels: string[];
  /** Channel credentials collected. */
  channelCredentials: Record<string, Record<string, string>>;
  /** Tool API keys collected. */
  toolKeys: Record<string, string>;
  /** Security toggles. */
  security: {
    preLlmClassifier: boolean;
    dualLlmAuditor: boolean;
    outputSigning: boolean;
    riskThreshold: number;
  };
  /** Voice / TTS config. */
  voice?: {
    provider: string;
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  /** STT config. */
  stt?: {
    provider: string;
    apiKey?: string;
    model?: string;
  };
  /** Agent name. */
  agentName: string;
  /** Selected extensions. */
  extensions?: {
    tools?: string[];
    voice?: string[];
    tts?: string[];
    stt?: string[];
    productivity?: string[];
  };
  /** Selected skills. */
  skills?: string[];
}

// ── Observability ──────────────────────────────────────────────────────────

export type ObservabilityPreset = 'off' | 'otel_traces_metrics' | 'otel_traces_metrics_logs';

// ── Secret Definition (from extension-secrets.json) ─────────────────────────

export interface SecretDef {
  id: string;
  label: string;
  description: string;
  envVar: string;
  docsUrl: string;
  providers: string[];
  optional: boolean;
}

// ── Doctor ───────────────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface DiagnosticCheck {
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface DiagnosticSection {
  title: string;
  checks: DiagnosticCheck[];
}
