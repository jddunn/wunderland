/**
 * @fileoverview `wunderland chat` — interactive terminal assistant with tool calling.
 *
 * This module is the command entry point. It handles CLI arg parsing,
 * agent bootstrap, extension loading, and then delegates the interactive
 * session to {@link ChatREPL} and rendering to {@link ChatStreamRenderer}.
 *
 * @module wunderland/cli/commands/chat
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import type { WunderlandProviderId, WunderlandAgentRagConfig } from '../../api/types.js';
import chalk from 'chalk';
import {
  accent,
  warn as wColor,
} from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../../runtime/workspace.js';
// resolveDefaultSkillsDirs is now handled by AgentBootstrap
import {
  runToolCallingTurn,
  streamToolCallingTurn,
  getGuardrailsInstance,
  type ToolInstance,
  type LLMProviderConfig,
} from '../../runtime/tool-calling.js';
import { createSchemaOnDemandTools } from '../../runtime/schema-on-demand.js';
import { ToolFailureLearner } from '../../runtime/tool-failure-learner.js';
import {
  classifyResearchDepth,
  buildResearchPrefix,
  createResearchClassifierLlmCall,
  shouldInjectResearch,
  type ResearchDepth,
} from '../../runtime/research-classifier.js';
import { startWunderlandOtel, shutdownWunderlandOtel } from '../../observability/otel.js';
import { resolveWunderlandTextLogConfig, WunderlandSessionTextLogger } from '../../observability/session-text-log.js';
// WunderlandAdaptiveExecutionRuntime is now created by AgentBootstrap
import { resolveStrictToolNames } from '../../runtime/tool-function-names.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
} from '../../runtime/policy.js';
import { isValidSecurityTier, SECURITY_TIERS } from '../../security/SecurityTiers.js';
import { isValidToolAccessProfile } from '../../social/ToolAccessProfiles.js';
import { verifySealedConfig } from '../seal-utils.js';
import { createEnvSecretResolver } from '../../security/env-secrets.js';
import { resolveAgentDisplayName } from '../../runtime/agent-identity.js';
import {
  createStepUpAuthConfigFromTier,
} from '../../core/index.js';
import {
  WunderlandDiscoveryManager,
} from '../../discovery/index.js';
import {
  resolveEffectiveAgentConfig,
} from '../../config/effective-agent-config.js';
import { AgentBootstrap } from '../../bootstrap/index.js';
import { loadConfig } from '../config/config-manager.js';
import { normalizeExtensionList } from '../extensions/aliases.js';
import { mergeExtensionOverrides } from '../extensions/settings.js';
import { createConfiguredRagTools } from '../../rag/runtime-tools.js';
import { resolveHydeFromAgentConfig } from '../../rag/hyde-integration.js';
import { buildAgenticSystemPrompt } from '../../runtime/system-prompt-builder.js';
import { buildOllamaRuntimeOptions } from '../../runtime/ollama-options.js';
import { createRequestFolderAccessTool } from '../../tools/RequestFolderAccessTool.js';
import {
  resolveWunderlandProviderId,
  resolveWunderlandTextModel,
} from '../../config/provider-defaults.js';
import {
  AgentStorageManager,
  resolveAgentStorageConfig,
  MemoryAutoIngestPipeline,
  derivePersonalityMemoryConfig,
} from '../../storage/index.js';
import type { IMemoryAutoIngestPipeline } from '../../storage/types.js';
import {
  createSpeechExtensionEnvOverrides,
  getDefaultVoiceExtensions,
} from '../../voice/speech-catalog.js';
import { createLocalMemoryReadTool } from './start/local-memory-tool.js';
import { createMemorySystem, type MemorySystem } from '../../memory/index.js';
import { injectMemoryContext } from '../../memory/index.js';
import { ContextWindowManager, MarkdownWorkingMemory } from '@framers/agentos/memory';
import type { InfiniteContextConfig } from '@framers/agentos/memory';
import {
  initCliQueryRouter,
  getCliQueryRouter,
  type CliQueryRouterOptions,
} from '../../runtime/query-router-init.js';
import type { QueryRouter, QueryResult, ConversationMessage } from '@framers/agentos/query-router';


// UI helpers extracted to chat-ui.ts
import {
  chatFrameGlyphs,
  getChatWidth,
  frameBorder,
  C,
  printChatHeader,
  toToolInstance,
} from './chat-ui.js';
import { ChatREPL, type ChannelAdapterInstance } from './ChatREPL.js';
import { ChatStreamRenderer } from './ChatStreamRenderer.js';

type QueryResultRecommendations = {
  skills: Array<{ skillId: string }>;
  tools: Array<{ toolId: string }>;
  extensions: Array<{ extensionId: string }>;
};

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdChat(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const globalConfig = await loadConfig(globals.config);

  const configPath = path.resolve(process.cwd(), 'agent.config.json');
  const sealedPath = path.resolve(process.cwd(), 'sealed.json');
  let cfg: any | null = null;

  // Observability (OTEL) is opt-in, and agent.config.json can override env.
  try {
    if (existsSync(configPath)) {
      const configRaw = await readFile(configPath, 'utf8');
      if (existsSync(sealedPath)) {
        const sealedRaw = await readFile(sealedPath, 'utf8');
        const verification = verifySealedConfig({ configRaw, sealedRaw });
        if (!verification.ok) {
          fmt.errorBlock(
            'Seal verification failed',
            `${verification.error || 'Verification failed.'}\nRun: ${chalk.white('wunderland verify-seal')}`
          );
          process.exitCode = 1;
          return;
        }
        if (!verification.signaturePresent) {
          fmt.warning('Sealed config has no signature (hash-only verification).');
        }
      }

      cfg = JSON.parse(configRaw);
      const cfgOtelEnabled = cfg?.observability?.otel?.enabled;
      if (typeof cfgOtelEnabled === 'boolean') {
        process.env['WUNDERLAND_OTEL_ENABLED'] = cfgOtelEnabled ? 'true' : 'false';
      }
      const cfgOtelLogsEnabled = cfg?.observability?.otel?.exportLogs;
      if (typeof cfgOtelLogsEnabled === 'boolean') {
        process.env['WUNDERLAND_OTEL_LOGS_ENABLED'] = cfgOtelLogsEnabled ? 'true' : 'false';
      }
    }
  } catch (err) {
    if (existsSync(sealedPath)) {
      fmt.errorBlock('Seal verification failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    // Unsealed config parse errors are non-fatal (defaults apply).
  }

  cfg = (
    await resolveEffectiveAgentConfig({
      agentConfig: (cfg ?? {}) as any,
      workingDirectory: process.cwd(),
      logger: {
        warn: (msg, meta) => console.warn(msg, meta ?? ''),
        debug: (msg, meta) => console.debug(msg, meta ?? ''),
      },
    })
  ).agentConfig;

  await startWunderlandOtel({ serviceName: 'wunderland-chat' });

  // CLI defaults: always use `developer` profile + `autonomous` permission set
  // so the agent can use CLI tools. Config values override these if explicitly set.
  // Server-hosted bots override via their own agent.config.json.
  const cliDefaults: Record<string, unknown> = {
    toolAccessProfile: 'developer',
    permissionSet: 'autonomous',
  };

  // Allow CLI flags to override security tier / tool profile
  const tierFlag =
    typeof flags['security-tier'] === 'string'
      ? String(flags['security-tier']).trim().toLowerCase()
      : '';
  const profileFlag =
    typeof flags['profile'] === 'string' ? String(flags['profile']).trim().toLowerCase() : '';

  if (tierFlag) {
    if (!isValidSecurityTier(tierFlag)) {
      fmt.errorBlock(
        'Invalid security tier',
        `"${tierFlag}" — valid: dangerous, permissive, balanced, strict, paranoid`
      );
      process.exitCode = 1;
      return;
    }
    const tierCfg = SECURITY_TIERS[tierFlag];
    cliDefaults.securityTier = tierFlag;
    cliDefaults.permissionSet = tierCfg.permissionSet;
    cliDefaults.executionMode =
      tierFlag === 'dangerous' || tierFlag === 'permissive' ? 'autonomous' : 'human-dangerous';
    cliDefaults.toolAccessProfile =
      tierFlag === 'dangerous' || tierFlag === 'permissive' ? 'developer' : 'assistant';
  }

  if (profileFlag) {
    if (!isValidToolAccessProfile(profileFlag)) {
      fmt.errorBlock(
        'Invalid tool profile',
        `"${profileFlag}" — valid: social-citizen, social-observer, social-creative, assistant, developer, unrestricted`
      );
      process.exitCode = 1;
      return;
    }
    cliDefaults.toolAccessProfile = profileFlag;
  }

  // ── Guardrail pack CLI flags ──────────────────────────────────────────────
  // --no-guardrails    → disable all guardrail extension packs
  // --guardrails=X,Y   → enable only the specified packs
  if (flags['no-guardrails'] === true) {
    cliDefaults.disableGuardrailPacks = true;
  }
  const guardrailsFlag =
    typeof flags['guardrails'] === 'string'
      ? String(flags['guardrails']).trim()
      : '';
  if (guardrailsFlag) {
    cliDefaults.enableOnlyGuardrailPacks = guardrailsFlag
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
  }

  // ── Voice pipeline CLI flags ──────────────────────────────────────────────
  //
  // These flags configure the optional local WebSocket voice pipeline server.
  // When `--voice` is set, the chat command spins up a WebSocket server
  // alongside the text REPL. Browser or telephony clients connect to the
  // WebSocket URL and exchange bidirectional audio/text streams. Each
  // inbound connection gets its own isolated agent session with independent
  // conversation history and AbortController.
  //
  //   --voice                Enable the local WebSocket voice pipeline server
  //   --voice-stt=<id>       STT provider override (e.g. deepgram, whisper-chunked)
  //   --voice-tts=<id>       TTS provider override (e.g. openai, elevenlabs)
  //   --voice-endpointing=X  Endpointing strategy: acoustic | heuristic | semantic
  //   --voice-diarization    Enable speaker diarization
  //   --voice-barge-in=X     Barge-in mode: hard-cut | soft-fade | disabled
  //   --voice-port=<n>       WebSocket server port (0 = OS-assigned)
  const voiceEnabled = flags['voice'] === true;
  const voiceStt =
    typeof flags['voice-stt'] === 'string' ? String(flags['voice-stt']).trim() : undefined;
  const voiceTts =
    typeof flags['voice-tts'] === 'string' ? String(flags['voice-tts']).trim() : undefined;
  const voiceEndpointing = (() => {
    const raw =
      typeof flags['voice-endpointing'] === 'string'
        ? String(flags['voice-endpointing']).trim()
        : '';
    if (raw === 'acoustic' || raw === 'heuristic' || raw === 'semantic') return raw;
    return undefined;
  })();
  const voiceDiarization = flags['voice-diarization'] === true;
  const voiceBargeIn = (() => {
    const raw =
      typeof flags['voice-barge-in'] === 'string' ? String(flags['voice-barge-in']).trim() : '';
    if (raw === 'hard-cut' || raw === 'soft-fade' || raw === 'disabled') return raw;
    return undefined;
  })();
  const voicePortRaw =
    typeof flags['voice-port'] === 'string' ? parseInt(String(flags['voice-port']), 10) : NaN;
  const voicePort = Number.isFinite(voicePortRaw) ? voicePortRaw : undefined;

  // ── Telephony webhook CLI flags ───────────────────────────────────────────
  //
  // These flags configure the telephony webhook HTTP server that receives
  // inbound call events from providers like Twilio, Telnyx, and Plivo.
  // The webhook server verifies request signatures, parses events, and
  // auto-generates the appropriate TwiML/XML response to open a media
  // stream WebSocket back to the voice pipeline server.
  //
  //   --telephony-provider=<name>   Telephony provider: twilio | telnyx | plivo
  //   --telephony-webhook-port=<n>  HTTP port for the webhook server (0 = OS-assigned)
  //   --telephony-webhook-host=X    Bind address for the webhook server
  //   --telephony-webhook-path=X    URL base path (default: /api/voice)
  const telephonyProvider = (() => {
    const raw =
      typeof flags['telephony-provider'] === 'string'
        ? String(flags['telephony-provider']).trim().toLowerCase()
        : '';
    if (raw === 'twilio' || raw === 'telnyx' || raw === 'plivo') return raw;
    return undefined;
  })();
  const telephonyWebhookPortRaw =
    typeof flags['telephony-webhook-port'] === 'string'
      ? parseInt(String(flags['telephony-webhook-port']), 10)
      : NaN;
  const telephonyWebhookPort = Number.isFinite(telephonyWebhookPortRaw)
    ? telephonyWebhookPortRaw
    : undefined;
  const telephonyWebhookHost =
    typeof flags['telephony-webhook-host'] === 'string'
      ? String(flags['telephony-webhook-host']).trim()
      : undefined;
  const telephonyWebhookPath =
    typeof flags['telephony-webhook-path'] === 'string'
      ? String(flags['telephony-webhook-path']).trim()
      : undefined;

  // Suppress "unused variable" lint warnings for flags resolved but not yet wired
  // to the server bootstrap — they will be consumed when telephony is fully integrated.
  void telephonyProvider;
  void telephonyWebhookPort;
  void telephonyWebhookHost;
  void telephonyWebhookPath;

  const policy = normalizeRuntimePolicy({ ...cliDefaults, ...(cfg || {}) });
  const permissions = getPermissionsForSet(policy.permissionSet);
  const turnApprovalMode = (() => {
    const raw =
      cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl)
        ? ((cfg.hitl as any).turnApprovalMode ?? (cfg.hitl as any).turnApproval)
        : undefined;
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (v === 'after-each-turn') return 'after-each-turn';
    if (v === 'after-each-round') return 'after-each-round';
    return 'off';
  })();
  const strictToolNames = resolveStrictToolNames((cfg as any)?.toolCalling?.strictToolNames);

  const providerFlag =
    typeof flags['provider'] === 'string' ? String(flags['provider']).trim() : '';
  const providerFromConfig =
    typeof cfg?.llmProvider === 'string' ? String(cfg.llmProvider).trim() : '';
  let providerId: WunderlandProviderId;
  try {
    providerId = resolveWunderlandProviderId(
      flags['ollama'] === true ? 'ollama' : providerFlag || providerFromConfig || 'openai',
    );
  } catch {
    fmt.errorBlock(
      'Unsupported LLM provider',
      `Provider "${flags['ollama'] === true ? 'ollama' : providerFlag || providerFromConfig || 'openai'}" is not supported by this CLI runtime.\nSupported: openai, openrouter, ollama, anthropic, gemini`
    );
    process.exitCode = 1;
    return;
  }

  const modelFromConfig = typeof cfg?.llmModel === 'string' ? String(cfg.llmModel).trim() : '';
  const model = resolveWunderlandTextModel({
    providerId,
    model: typeof flags['model'] === 'string' ? String(flags['model']) : modelFromConfig,
  });

  // OpenRouter fallback (OpenAI provider only)
  const openrouterApiKey = process.env['OPENROUTER_API_KEY'] || '';
  const openrouterFallback: LLMProviderConfig | undefined = openrouterApiKey
    ? {
        apiKey: openrouterApiKey,
        model: typeof flags['openrouter-model'] === 'string' ? flags['openrouter-model'] : 'auto',
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: { 'HTTP-Referer': 'https://wunderland.sh', 'X-Title': 'Wunderbot' },
      }
    : undefined;

  const ollamaBaseUrl = (() => {
    const configBaseUrl =
      typeof cfg?.ollama?.baseUrl === 'string'
        ? cfg.ollama.baseUrl.trim()
        : typeof globalConfig?.ollama?.baseUrl === 'string'
          ? globalConfig.ollama.baseUrl.trim()
          : '';
    const raw = String(process.env['OLLAMA_BASE_URL'] || '').trim() || configBaseUrl;
    const base = raw || 'http://localhost:11434';
    const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
    if (normalized.endsWith('/v1')) return normalized;
    return `${normalized}/v1`;
  })();

  const llmBaseUrl =
    providerId === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : providerId === 'ollama'
        ? ollamaBaseUrl
        : providerId === 'gemini'
          ? 'https://generativelanguage.googleapis.com/v1beta/openai'
          : undefined;
  // Resolve auth method (OAuth or API key)
  const authMethod: 'api-key' | 'oauth' =
    (cfg?.llmAuthMethod === 'oauth' || flags['oauth'] === true) && providerId === 'openai'
      ? 'oauth'
      : 'api-key';

  let llmApiKey: string;
  let oauthGetApiKey: (() => Promise<string>) | undefined;

  if (authMethod === 'oauth') {
    fmt.errorBlock(
      'Not yet supported',
      'OAuth subscription-based usage (ChatGPT Plus/Pro) is not yet available.\n' +
      'OpenAI subscription token usage requires a registered OAuth application.\n' +
      'Please use an OpenAI API key instead — get one at https://platform.openai.com/api-keys',
    );
    process.exitCode = 1;
    return;
  } else {
    llmApiKey =
      providerId === 'openrouter'
        ? openrouterApiKey
        : providerId === 'ollama'
          ? 'ollama'
          : providerId === 'openai'
            ? process.env['OPENAI_API_KEY'] || ''
            : providerId === 'anthropic'
              ? process.env['ANTHROPIC_API_KEY'] || ''
              : providerId === 'gemini'
                ? process.env['GEMINI_API_KEY'] || ''
                : process.env['OPENAI_API_KEY'] || '';
  }

  const canUseLLM =
    providerId === 'ollama'
        ? true
        : providerId === 'openrouter'
          ? !!openrouterApiKey
          : providerId === 'anthropic'
            ? !!process.env['ANTHROPIC_API_KEY']
            : providerId === 'gemini'
              ? !!process.env['GEMINI_API_KEY']
              : !!llmApiKey || !!openrouterFallback;

  if (!canUseLLM) {
    fmt.errorBlock(
      'Missing API key',
      'Configure an LLM provider in agent.config.json, set OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY, or use Ollama.'
    );
    process.exitCode = 1;
    return;
  }

  // Warn if using an API key from environment rather than agent config.
  // This prevents confusion when CTRL+C'd init still creates a working agent.
  if (
    providerId !== 'ollama' &&
    llmApiKey &&
    !providerFromConfig
  ) {
    const envVarName =
      providerId === 'openrouter'
        ? 'OPENROUTER_API_KEY'
        : providerId === 'anthropic'
          ? 'ANTHROPIC_API_KEY'
          : providerId === 'gemini'
            ? 'GEMINI_API_KEY'
            : 'OPENAI_API_KEY';
    console.log(
      `  ${wColor('!')} No LLM provider in agent.config.json — using ${accent(envVarName)} from environment`
    );
  }

  const overdriveMode = flags['overdrive'] === true;
  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const dangerouslySkipCommandSafety =
    flags['dangerously-skip-command-safety'] === true || dangerouslySkipPermissions;
  const autoApproveToolCalls =
    globals.autoApproveTools || dangerouslySkipPermissions || overdriveMode || policy.executionMode === 'autonomous';
  const enableSkills = flags['no-skills'] !== true;
  const enableQueryRouter = flags['no-query-router'] !== true;
  const lazyTools = flags['lazy-tools'] === true;
  const verbose = flags['verbose'] === true || flags['v'] === true;
  const workspaceBaseDir = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(`chat-${path.basename(process.cwd())}`);

  const toolMap = new Map<string, ToolInstance>();
  const preloadedPackages: string[] = [];
  let discoveryManager: WunderlandDiscoveryManager | null = null;
  let schemaOnDemandSecrets: Record<string, string> | undefined;
  let schemaOnDemandGetSecret: ((secretId: string) => string | undefined) | undefined;
  let schemaOnDemandOptions: Record<string, Record<string, unknown>> = {};

  // Channel adapter instances (populated during extension loading)
  const channelAdapters: ChannelAdapterInstance[] = [];

  // ── Capture startup output into a bordered panel ────────────────────────
  const startupLines: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origDebug = console.debug;
  const captureLog = (...args: unknown[]) => {
    startupLines.push(args.map(String).join(' '));
  };
  const suppressLog = () => {}; // swallow debug during startup
  console.log = captureLog as typeof console.log;
  console.info = captureLog as typeof console.info;
  console.warn = captureLog as typeof console.warn;
  console.debug = suppressLog as typeof console.debug;

  let toolExtensions: string[] = [];

  if (!lazyTools) {
    // Read extensions from agent.config.json if present
    const extensionsFromConfig = cfg?.extensions;
    const extensionOverrides = cfg?.extensionOverrides;
    const configSecrets = cfg?.secrets;
    const cfgSecrets =
      configSecrets && typeof configSecrets === 'object' && !Array.isArray(configSecrets)
        ? (configSecrets as Record<string, string>)
        : undefined;
    const getSecret = createEnvSecretResolver({ configSecrets: cfgSecrets });
    let voiceExtensions: string[] = [];
    let productivityExtensions: string[] = [];

    // Merge extension lists: agent config > global config > hardcoded defaults
    const hardcodedDefaults = {
      tools: [
        'cli-executor', 'web-search', 'web-browser', 'browser-automation',
        'content-extraction', 'credential-vault', 'giphy', 'image-search',
        'image-generation', 'video-generation', 'audio-generation',
        'vision-pipeline', 'news-search', 'weather', 'skills',
        'deep-research', 'github', 'web-scraper', 'document-export',
        'widget-generator',
      ],
      voice: getDefaultVoiceExtensions(),
      productivity: [] as string[],
    };
    const globalExts = globalConfig?.extensions;

    // Category-aware loading: if agent config defines extensionCategories,
    // expand categories to extension IDs instead of using hardcoded defaults.
    const extensionCategories = cfg?.extensionCategories as string[] | undefined;
    if (extensionCategories && extensionCategories.length > 0 && !extensionsFromConfig?.tools) {
      const { expandCategories } = await import('../extensions/categories.js');
      const categoryTools = expandCategories(extensionCategories as any);
      toolExtensions = normalizeExtensionList(categoryTools);
    } else {
      toolExtensions = normalizeExtensionList(
        extensionsFromConfig?.tools ?? globalExts?.tools ?? hardcodedDefaults.tools,
      );
    }
    voiceExtensions = normalizeExtensionList(
      extensionsFromConfig?.voice ?? globalExts?.voice ?? hardcodedDefaults.voice,
    );
    productivityExtensions = normalizeExtensionList(
      extensionsFromConfig?.productivity ?? globalExts?.productivity ?? hardcodedDefaults.productivity,
    );

    if (extensionsFromConfig) {
      fmt.note(
        `Loading ${toolExtensions.length + voiceExtensions.length + productivityExtensions.length} extensions from agent config...`
      );
    } else if (globalExts) {
      fmt.note('Loading extensions from global config...');
    } else {
      fmt.note('No extensions configured, using defaults...');
    }

    // Auto-include Telegram tool when a valid bot token is available
    if (process.env['TELEGRAM_BOT_TOKEN'] && !toolExtensions.includes('telegram')) {
      const tgToken = process.env['TELEGRAM_BOT_TOKEN'].trim();
      if (/^\d+:[A-Za-z0-9_-]{35,}$/.test(tgToken)) {
        toolExtensions.push('telegram');
      } else {
        fmt.warning(
          'TELEGRAM_BOT_TOKEN looks invalid (expected format: 123456:ABC-DEF...) — skipping Telegram extension'
        );
      }
    }

    // Auto-include Gmail extension when Google OAuth credentials are available
    if (
      !productivityExtensions.includes('email-gmail') &&
      !toolExtensions.includes('email-gmail')
    ) {
      const gClientId = (getSecret('google.clientId') || '').trim();
      const gClientSecret = (getSecret('google.clientSecret') || '').trim();
      const gRefreshToken = (getSecret('google.refreshToken') || '').trim();
      if (gClientId && gClientSecret && gRefreshToken) {
        productivityExtensions.push('email-gmail');
      }
    }

    // Auto-include Google Calendar when credentials are available
    if (
      !productivityExtensions.includes('calendar-google') &&
      !toolExtensions.includes('calendar-google')
    ) {
      const gClientId = (getSecret('google.clientId') || '').trim();
      const gClientSecret = (getSecret('google.clientSecret') || '').trim();
      const gRefreshToken = (getSecret('google.refreshToken') || '').trim();
      if (gClientId && gClientSecret && gRefreshToken) {
        productivityExtensions.push('calendar-google');
      }
    }

    // Auto-include GitHub extension when a PAT or gh CLI auth is available
    if (!toolExtensions.includes('github')) {
      const ghToken = (process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'] || '').trim();
      if (ghToken) {
        toolExtensions.push('github');
      } else {
        // Check for gh CLI auth as fallback
        try {
          const { execSync } = await import('node:child_process');
          const cliToken = execSync('gh auth token 2>/dev/null', {
            encoding: 'utf8',
            timeout: 3000,
          }).trim();
          if (cliToken) toolExtensions.push('github');
        } catch {
          /* gh not installed or not authenticated — skip */
        }
      }
    }

    // Resolve extensions using PresetExtensionResolver
    try {
      const { resolveExtensionsByNames } = await import('../../core/PresetExtensionResolver.js');
      // Merge overrides: global config < agent config (agent wins)
      const globalOverrides = (globalConfig?.extensionOverrides && typeof globalConfig.extensionOverrides === 'object')
        ? (globalConfig.extensionOverrides as Record<string, any>)
        : {};
      const agentOverrides = (extensionOverrides && typeof extensionOverrides === 'object')
        ? (extensionOverrides as Record<string, any>)
        : {};
      const configOverrides: Record<string, any> = mergeExtensionOverrides(globalOverrides, agentOverrides);

      // Apply global provider defaults into extension options
      const providerDefaults = globalConfig?.providerDefaults;
      if (providerDefaults) {
        if (providerDefaults.imageGeneration && !configOverrides['image-generation']?.options?.defaultProvider) {
          configOverrides['image-generation'] = {
            ...configOverrides['image-generation'],
            options: { ...configOverrides['image-generation']?.options, defaultProvider: providerDefaults.imageGeneration },
          };
        }
        if (providerDefaults.webSearch && !configOverrides['web-search']?.options?.defaultProvider) {
          configOverrides['web-search'] = {
            ...configOverrides['web-search'],
            options: { ...configOverrides['web-search']?.options, defaultProvider: providerDefaults.webSearch },
          };
        }
        if (providerDefaults.videoGeneration && !configOverrides['video-generation']?.options?.defaultProvider) {
          configOverrides['video-generation'] = {
            ...configOverrides['video-generation'],
            options: {
              ...configOverrides['video-generation']?.options,
              defaultProvider: providerDefaults.videoGeneration.provider,
              defaultModel: providerDefaults.videoGeneration.model,
            },
          };
        }
        if (providerDefaults.audioGeneration && !configOverrides['audio-generation']?.options?.defaultProvider) {
          configOverrides['audio-generation'] = {
            ...configOverrides['audio-generation'],
            options: {
              ...configOverrides['audio-generation']?.options,
              defaultProvider: providerDefaults.audioGeneration.provider,
              defaultModel: providerDefaults.audioGeneration.model,
            },
          };
        }
      }

      // Build filesystem roots: agent workspace + user's home directory + cwd.
      // Without explicit roots, the cli-executor defaults to [workspaceDir] only,
      // which locks the agent out of the rest of the user's filesystem.
      const homeDir = (await import('node:os')).homedir();
      const workspaceDir = path.resolve(workspaceBaseDir, workspaceAgentId);
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
              agentId: workspaceAgentId,
              baseDir: workspaceBaseDir,
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
        ...createSpeechExtensionEnvOverrides({ providerDefaults }),
        'news-search': { options: { newsApiKey: process.env['NEWSAPI_API_KEY'] } },
        // Telegram extensions: send-only mode in CLI context to avoid
        // 409 Conflict errors from competing getUpdates pollers.
        telegram: { options: { sendOnly: true } },
        'channel-telegram': { options: { sendOnly: true } },
        'calendar-google': {
          options: {
            clientId: process.env['GOOGLE_CLIENT_ID'],
            clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
            refreshToken:
              process.env['GOOGLE_REFRESH_TOKEN'] ||
              process.env['GOOGLE_CALENDAR_REFRESH_TOKEN'],
          },
        },
        'wunderbot-feeds': {
          options: {
            feeds: (cfg as any)?.feeds ?? {},
          },
        },
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
      const secrets = new Proxy<Record<string, string>>({} as any, {
        get: (_target, prop) => (typeof prop === 'string' ? getSecret(prop) : undefined),
      });

      const channelsFromConfig = Array.isArray((cfg as any)?.channels)
        ? ((cfg as any).channels as unknown[])
        : Array.isArray((cfg as any)?.suggestedChannels)
          ? ((cfg as any).suggestedChannels as unknown[])
          : [];
      const channelsToLoad = Array.from(
        new Set(channelsFromConfig.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0))
      );

      const resolved = await resolveExtensionsByNames(
        toolExtensions,
        voiceExtensions,
        productivityExtensions,
        mergedOverrides,
        { secrets: secrets as any, channels: channelsToLoad.length > 0 ? channelsToLoad : 'none' }
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
          const pack = await factory({ options, logger: console, getSecret });
          packs.push(pack);
          if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fmt.warning(`Failed to load extension pack: ${msg}`);
        }
      }

      const activationResults = await Promise.allSettled(
        packs
          .map((p: any) =>
            typeof p?.onActivate === 'function'
              ? p.onActivate({ logger: console, getSecret })
              : null
          )
          .filter(Boolean)
      );
      for (const result of activationResults) {
        if (result.status === 'rejected' && verbose) {
          const msg =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          fmt.warning(`Extension activation failed: ${msg}`);
        }
      }

      const tools: ToolInstance[] = packs
        .flatMap((p: any) =>
          (p?.descriptors || [])
            .filter((d: { kind: string }) => d?.kind === 'tool')
            .map((d: { payload: unknown }) => d.payload)
        )
        .filter(Boolean) as ToolInstance[];

      for (const tool of tools) {
        if (!tool?.name) continue;
        toolMap.set(tool.name, tool);
      }

      // Extract messaging-channel adapters for bidirectional channel listening
      const channelPayloads = packs
        .flatMap((p: any) =>
          (p?.descriptors || [])
            .filter((d: { kind: string }) => d?.kind === 'messaging-channel')
            .map((d: { payload: unknown }) => d.payload)
        )
        .filter(Boolean);
      for (const a of channelPayloads) channelAdapters.push(a as ChannelAdapterInstance);

      fmt.ok(`Loaded ${tools.length} tools from ${packs.length} extensions`);
      if (channelAdapters.length > 0) {
        const chNames = channelAdapters
          .map((a) => (a as any).displayName || (a as any).platform || 'unknown')
          .join(', ');
        fmt.ok(`Listening on ${channelAdapters.length} channel(s): ${chNames}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fmt.warning(`Extension loading failed, using empty toolset: ${msg}`);
    }
  }

  // Schema-on-demand meta tools (always available)
  for (const tool of createSchemaOnDemandTools({
    toolMap,
    runtimeDefaults: {
      workingDirectory: process.cwd(),
      headlessBrowser: true,
      dangerouslySkipCommandSafety,
      agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    },
    initialEnabledPackages: preloadedPackages,
    secrets: schemaOnDemandSecrets,
    getSecret: schemaOnDemandGetSecret,
    defaultExtensionOptions: schemaOnDemandOptions,
    logger: console,
    onToolsChanged: () => {
      discoveryManager?.reindex?.({ toolMap }).catch(() => {});
    },
  })) {
    toolMap.set(tool.name, tool);
  }

  for (const ragTool of createConfiguredRagTools(cfg ?? {})) {
    if (!ragTool?.name) continue;
    toolMap.set(ragTool.name, toToolInstance(ragTool as any));
  }

  // Enforce tool access profile + permission set.
  // CLI defaults: `developer` profile + `autonomous` perms → allows CLI tools.
  // Config-based: respects agent.config.json settings.
  {
    const filtered = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: policy.toolAccessProfile,
      permissions,
    });
    toolMap.clear();
    for (const [k, v] of filtered.toolMap.entries()) toolMap.set(k, v);
  }

  // ── Agent wallet extension (opt-in via agent.config.json wallet.enabled) ──
  if (cfg?.wallet?.enabled) {
    try {
      const { createExtensionPack: createWalletPack } = await import(
        '@framers/agentos-ext-wallet' as string
      );
      const walletPack = createWalletPack({
        options: cfg.wallet,
        secrets: cfg.secrets,
        getSecret: (k: string) => process.env[k],
        logger: { info: (m: string) => fmt.ok(m) },
      });
      for (const desc of walletPack.descriptors) {
        if (desc.kind === 'tool' && desc.payload) {
          const t = desc.payload as any;
          toolMap.set(t.name, t);
        }
      }
      await walletPack.onActivate?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fmt.warning(`Wallet extension failed to load: ${msg}`);
    }
  }

  // ── Shared bootstrap (seed, security pipeline, skills, discovery, adaptive runtime) ──
  // Delegates seed creation, security pipeline init, skills resolution,
  // discovery init, and adaptive runtime to the shared AgentBootstrap.
  // Tool loading stays CLI-specific (above) because the CLI has category-aware
  // extension loading, channel adapters, wallet extension, and global config merges.
  const cliBootstrap = await AgentBootstrap.create({
    agentConfig: cfg ?? {},
    providerId,
    apiKey: llmApiKey,
    baseUrl: llmBaseUrl,
    mode: 'chat',
    lazyTools: true, // CLI manages its own tool loading above
    autoApproveToolCalls,
    workspaceId: workspaceAgentId,
    workspaceBaseDir: workspaceBaseDir,
    workingDirectory: process.cwd(),
    dangerouslySkipCommandSafety,
    skipMemory: true, // CLI has its own storage/memory with auto-ingest, GraphRAG, etc.
    disableSkills: !enableSkills,
    skillsDirFlag: typeof flags['skills-dir'] === 'string' ? flags['skills-dir'] : undefined,
    policyDefaults: cliDefaults,
    verbose,
    logger: {
      warn: (msg: string, meta?: unknown) => console.warn(msg, meta ?? ''),
      debug: (msg: string, meta?: unknown) => console.debug(msg, meta ?? ''),
    },
  });

  const { seed, seedId, activePersonaId } = cliBootstrap;
  const displayName = resolveAgentDisplayName({
    displayName: cfg?.displayName,
    agentName: cfg?.agentName,
    globalAgentName: globalConfig.agentName,
    seedId,
    fallback: 'Wunderland CLI',
  });
  const personality = cfg?.personality || {};

  // Merge bootstrap's discovery meta tool + skills into CLI tool map
  discoveryManager = cliBootstrap.discoveryManager ?? null;
  if (discoveryManager) {
    // Re-initialize discovery with the CLI's richer tool map
    try {
      await discoveryManager.reindex?.({ toolMap });
    } catch { /* non-fatal */ }
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, {
        name: metaTool.name,
        description: metaTool.description,
        inputSchema: metaTool.inputSchema as any,
        hasSideEffects: metaTool.hasSideEffects,
        category: 'productivity',
        execute: metaTool.execute as any,
      });
    }
  }

  const adaptiveRuntime = cliBootstrap.adaptiveRuntime!;
  const skillsPrompt = cliBootstrap.skillsPrompt ?? '';
  const guardrailSummary = cliBootstrap.securityPipelineSummary ?? null;

  // ── Per-agent storage + auto-ingest pipeline ──────────────────────────────
  let agentStorageManager: AgentStorageManager | undefined;
  let autoIngestPipeline: IMemoryAutoIngestPipeline | undefined;
  try {
    const storageConfig = resolveAgentStorageConfig(seedId, cfg?.storage);
    agentStorageManager = new AgentStorageManager(storageConfig);
    await agentStorageManager.initialize();

    // Derive personality-adaptive memory config from HEXACO traits
    const personalityMemoryConfig = derivePersonalityMemoryConfig(
      {
        honesty: personality.honesty,
        emotionality: personality.emotionality,
        extraversion: personality.extraversion,
        agreeableness: personality.agreeableness,
        conscientiousness: personality.conscientiousness,
        openness: personality.openness,
      },
      cfg?.storage?.autoIngest
        ? {
            importanceThreshold: cfg.storage.autoIngest.importanceThreshold,
            maxMemoriesPerTurn: cfg.storage.autoIngest.maxPerTurn,
          }
        : undefined
    );

    // Create auto-ingest pipeline (LLM caller is a no-op placeholder until
    // we have a validated LLM config — replaced below after LLM setup)
    const pipeline = new MemoryAutoIngestPipeline({
      vectorStore: agentStorageManager.getVectorStore(),
      personalityConfig: personalityMemoryConfig,
      storageConfig,
      agentId: seedId,
      llmCaller: async (_sys, _user) => '[]', // placeholder
    });
    await pipeline.initialize();
    agentStorageManager.setAutoIngestPipeline(pipeline);
    autoIngestPipeline = pipeline;
  } catch (err) {
    // Non-fatal — chat works without storage
    console.debug(
      '[wunderland/chat] Per-agent storage init failed:',
      err instanceof Error ? err.message : err
    );
  }

  // ── Cognitive Memory (optional — when cognitiveMechanisms config present) ──
  let cognitiveMemoryManager: any;
  let cognitiveMoodProvider: (() => { valence: number; arousal: number; dominance: number }) | undefined;
  if (cfg?.memory?.cognitiveMechanisms && agentStorageManager) {
    try {
      const { initializeCognitiveMemory } = await import('../../memory/CognitiveMemoryInitializer.js');
      const result = await initializeCognitiveMemory({
        cognitiveMechanisms: cfg.memory.cognitiveMechanisms,
        vectorStore: agentStorageManager.getVectorStore(),
        traits: personality,
        agentId: seedId,
        llm: { providerId, apiKey: llmApiKey, baseUrl: llmBaseUrl },
      });
      cognitiveMemoryManager = result.manager;
      cognitiveMoodProvider = result.moodProvider;

      // Bridge: wire cognitive manager into auto-ingest pipeline
      if (autoIngestPipeline) {
        (autoIngestPipeline as any).config.cognitiveMemoryManager = cognitiveMemoryManager;
        (autoIngestPipeline as any).config.moodProvider = cognitiveMoodProvider;
      }
    } catch (err) {
      console.debug(
        '[wunderland/chat] Cognitive memory init failed (continuing without mechanisms):',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Persistent Markdown Working Memory ──────────────────────────────
  let markdownWorkingMemory: MarkdownWorkingMemory | undefined;
  try {
    const wmPath = path.join(workspaceBaseDir, 'agents', workspaceAgentId, 'working-memory.md');
    markdownWorkingMemory = new MarkdownWorkingMemory(wmPath);
    markdownWorkingMemory.ensureFile();
  } catch { /* non-fatal */ }

  // ── Memory Retrieval System ───────────────────────────────────────
  let memorySystem: MemorySystem | null = null;
  if (agentStorageManager && cfg?.memory?.enabled !== false) {
    try {
      // Lazy-load GraphRAG engine (optional)
      let graphRAG: any = undefined;
      try { graphRAG = await agentStorageManager.getGraphRAGEngine(); } catch { /* optional */ }

      memorySystem = await createMemorySystem({
        vectorStore: agentStorageManager.getVectorStore(),
        traits: personality,
        llm: { providerId, apiKey: llmApiKey, baseUrl: llmBaseUrl },
        ollama: cfg?.ollama,
        markdownMemory: markdownWorkingMemory,
        graphRAG,
        retrievalBudgetTokens: cfg?.memory?.retrievalBudgetTokens ?? 4000,
        agentId: seedId,
        cognitiveMemoryManager,
        moodProvider: cognitiveMoodProvider,
      });
    } catch {
      // Non-fatal — chat works without memory retrieval
    }
  }

  if (!toolMap.has('memory_read') && agentStorageManager) {
    const openaiKey = process.env['OPENAI_API_KEY'];
    if (openaiKey) {
      try {
        const localMemoryTool = createLocalMemoryReadTool({
          vectorStore: agentStorageManager.getVectorStore(),
          openaiApiKey: openaiKey,
          embeddingModel: cfg?.discovery?.embeddingModel || 'text-embedding-3-small',
          hyde: {
            ...resolveHydeFromAgentConfig(cfg?.rag),
            llm:
              canUseLLM && llmApiKey && model
                ? {
                    apiKey: llmApiKey,
                    model,
                    baseUrl: llmBaseUrl,
                    extraHeaders:
                      providerId === 'openrouter'
                        ? {
                            'HTTP-Referer': 'https://wunderland.sh',
                            'X-Title': 'Wunderbot',
                          }
                        : undefined,
                  }
                : undefined,
          },
        });
        const filtered = filterToolMapByPolicy({
          toolMap: new Map([[localMemoryTool.name, toToolInstance(localMemoryTool as any)]]),
          toolAccessProfile: policy.toolAccessProfile,
          permissions,
        });
        const localTool = filtered.toolMap.get(localMemoryTool.name);
        if (localTool) {
          toolMap.set(localMemoryTool.name, localTool);
          discoveryManager?.reindex?.({ toolMap }).catch(() => {});
          if (verbose) {
            fmt.note('Local memory_read tool enabled (SqlVectorStore)');
          }
        }
      } catch {
        // Storage not ready — skip silently
      }
    }
  }

  // ── QueryRouter (intelligent tiered retrieval, non-blocking init) ────────
  //
  // Kicks off QueryRouter initialisation in the background. The router
  // classifies each user message by complexity tier and retrieves relevant
  // documentation context before the LLM call. This enhances — but does not
  // replace — the existing RAG tools and capability discovery layers.
  //
  // When the agent's config has unified retrieval settings (rag.hybrid,
  // rag.raptor, rag.hyde, rag.memoryIntegration), the router is upgraded
  // with a UnifiedRetriever that orchestrates all sources in parallel via
  // plan-based retrieval.
  //
  // When --no-query-router is set, or init fails (missing key, empty corpus),
  // the chat falls back gracefully to the existing behaviour.
  let queryRouterPromise: Promise<QueryRouter | null> | null = null;
  if (enableQueryRouter) {
    // Resolve the per-agent workspace directory for BM25/RAPTOR persistence.
    const agentDir = path.resolve(
      (await import('node:os')).homedir(),
      '.wunderland',
      'agents',
      seedId,
    );

    const qrOpts: CliQueryRouterOptions = {
      apiKey: llmApiKey || undefined,
      baseUrl: llmBaseUrl || undefined,
      embeddingApiKey: process.env['OPENAI_API_KEY'] || llmApiKey || undefined,
      embeddingBaseUrl:
        process.env['OPENAI_API_KEY'] ? undefined : (llmBaseUrl || undefined),
      model: model || undefined,
      extraCorpusPaths: typeof cfg?.queryRouter?.corpusPaths === 'object' && Array.isArray(cfg.queryRouter.corpusPaths)
        ? (cfg.queryRouter.corpusPaths as string[])
        : undefined,
      maxTier: typeof cfg?.queryRouter?.maxTier === 'number' ? cfg.queryRouter.maxTier : undefined,
      verbose,
      logger: { log: console.log, warn: console.warn, error: console.error, debug: console.debug },
      // ── Unified retrieval wiring from agent.config.json ──
      ragConfig: cfg?.rag as WunderlandAgentRagConfig | undefined,
      memorySystem,
      vectorStore: agentStorageManager?.getVectorStore(),
      agentDir,
      llmCaller: canUseLLM && llmApiKey && model
        ? async (prompt: string) => {
            const { default: OpenAI } = await import('openai');
            const client = new OpenAI({
              apiKey: llmApiKey,
              baseURL: llmBaseUrl || undefined,
            });
            const resp = await client.chat.completions.create({
              model,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 512,
            });
            return resp.choices?.[0]?.message?.content ?? '';
          }
        : undefined,
    };
    // Fire and forget — we await lazily when the first user message arrives.
    queryRouterPromise = initCliQueryRouter(qrOpts);
  }

  // ── Tool failure learner (saves lessons to RAG from tool errors) ─────────
  const toolFailureLearner = new ToolFailureLearner({
    autoIngestPipeline: autoIngestPipeline ?? undefined,
    conversationId: `cli-${seedId}`,
    verbose,
  });

  // ── Infinite context window manager ────────────────────────────────────────
  let contextWindowManager: ContextWindowManager | undefined;
  {
    const infiniteCtx: Partial<InfiniteContextConfig> = {
      enabled: cfg?.memory?.infiniteContext?.enabled ?? true,
      strategy: cfg?.memory?.infiniteContext?.strategy ?? 'sliding',
      compactionThreshold: cfg?.memory?.infiniteContext?.compactionThreshold ?? 0.75,
      preserveRecentTurns: cfg?.memory?.infiniteContext?.preserveRecentTurns ?? 20,
      transparencyLevel: cfg?.memory?.infiniteContext?.transparencyLevel ?? 'summary',
    };

    if (infiniteCtx.enabled) {
      try {
        contextWindowManager = new ContextWindowManager({
          maxContextTokens: cfg?.memory?.maxContextTokens ?? 128_000,
          infiniteContext: infiniteCtx,
          llmInvoker: async (prompt: string) => {
            // Reuse the existing LLM setup (placeholder until LLM is configured below).
            return prompt.slice(0, 200) + '...';
          },
        });
      } catch {
        // Non-fatal — chat works without infinite context
      }
    }
  }

  // Detect authenticated integrations to inform the agent
  const authenticatedIntegrations: string[] = [];
  if (toolExtensions.includes('github')) authenticatedIntegrations.push('github');
  if (toolExtensions.includes('telegram')) authenticatedIntegrations.push('telegram');

  const systemPrompt = buildAgenticSystemPrompt({
    seed,
    policy,
    mode: 'chat',
    lazyTools,
    autoApproveToolCalls,
    channelNames:
      channelAdapters.length > 0
        ? channelAdapters.map((a) => (a as any).displayName || (a as any).platform)
        : undefined,
    skillsPrompt: skillsPrompt || undefined,
    turnApprovalMode,
    authenticatedIntegrations:
      authenticatedIntegrations.length > 0 ? authenticatedIntegrations : undefined,
  });

  const sessionId = `wunderland-cli-${Date.now()}`;
  const toolContext = {
    gmiId: sessionId,
    sessionId,
    personaId: activePersonaId,
    userContext: { userId: process.env['USER'] || 'local-user' },
    agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    interactiveSession: true,
    strictToolNames,
    ...(typeof globals.config === 'string' && globals.config.trim()
      ? { wunderlandConfigDir: globals.config.trim() }
      : null),
    ...(cfg
      ? {
          permissionSet: policy.permissionSet,
          securityTier: policy.securityTier,
          executionMode: policy.executionMode,
          toolAccessProfile: policy.toolAccessProfile,
          wrapToolOutputs: policy.wrapToolOutputs,
          turnApprovalMode,
        }
      : null),
    ...(cfg && policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
  };
  const localUserId = String((toolContext as any)?.userContext?.userId ?? 'local-user');
  const tenantId =
    typeof (cfg as any)?.organizationId === 'string' && String((cfg as any).organizationId).trim()
      ? String((cfg as any).organizationId).trim()
      : undefined;
  const sessionTextLogger = new WunderlandSessionTextLogger(
    resolveWunderlandTextLogConfig({
      agentConfig: cfg,
      workingDirectory: process.cwd(),
      workspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
      defaultAgentId: workspaceAgentId,
      configBacked: !!cfg,
    }),
  );

  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

  // ── Restore previous conversation history from per-agent storage ────────
  // Uses a stable conversationId per agent so history persists across sessions.
  const conversationId = `cli-${seedId}`;
  let memoryAdapter: import('../../storage/types.js').IAgentMemoryAdapter | undefined;
  try {
    if (agentStorageManager) {
      memoryAdapter = agentStorageManager.getMemoryAdapter();
      const previousTurns = await memoryAdapter.retrieveConversationTurns(conversationId, {
        limit: 100,
      });
      if (previousTurns.length > 0) {
        let restoredCount = 0;
        for (const turn of previousTurns) {
          if ((turn.role === 'user' || turn.role === 'assistant') && turn.content) {
            messages.push({ role: turn.role, content: turn.content });
            restoredCount++;
          }
        }
        if (restoredCount > 0) {
          console.log(
            `  ${chalk.hex('#666')(`Restored ${restoredCount} messages from previous session.`)}`
          );
        }
      }
    }
  } catch {
    // Non-fatal — chat works without history
  }

  // ── Restore console and render captured startup output in a panel ──────
  console.log = origLog;
  console.info = origInfo;
  console.warn = origWarn;
  console.debug = origDebug;
  if (verbose && startupLines.length > 0) {
    const { stripAnsi } = await import('../ui/ansi-utils.js');
    const filtered = startupLines.filter((l) => stripAnsi(l).trim().length > 0);
    if (filtered.length > 0) {
      await fmt.panel({ title: 'Startup', content: filtered.join('\n'), style: 'info' });
    }
  }

  printChatHeader({
    agentName: displayName,
    provider: providerId,
    model,
    tools: toolMap.size,
    skills: enableSkills,
    fallback: providerId === 'openai' && !!openrouterFallback,
    lazyTools,
    autoApprove: autoApproveToolCalls,
    turnApproval: turnApprovalMode,
    securityTier: policy.securityTier || 'permissive',
    toolProfile: policy.toolAccessProfile || 'developer',
    cliExecution: permissions.system?.cliExecution !== false,
    guardrailPacks: guardrailSummary
      ? guardrailSummary.active.length > 0
        ? `${guardrailSummary.active.join(', ')} (${guardrailSummary.active.length}/${guardrailSummary.total})`
        : 'none'
      : 'unavailable',
  });

  // ── Stream renderer (terminal output for tool calls, progress, replies) ──
  const streamRenderer = new ChatStreamRenderer({ verbose });

  // ── Voice pipeline server (optional, --voice flag) ───────────────────────
  //
  // When --voice is set, spin up a local WebSocket server wired to the voice
  // pipeline orchestrator. The server URL is printed so the caller can connect
  // a voice client (browser WebSocket or telephony media stream).
  //
  // Each inbound WebSocket connection receives a fresh agent session via the
  // factory callback below. The session implements `sendText()` as an async
  // generator that streams LLM tokens via `streamToolCallingTurn`, and
  // `abort()` which cancels the in-flight HTTP request on barge-in.
  //
  // Failure is non-fatal — if pipeline creation or server startup throws
  // (e.g. missing API key), chat continues in text-only mode.
  if (voiceEnabled) {
    try {
      const [{ createStreamingPipeline }, { startVoiceServer }] = await Promise.all([
        import('../../voice/streaming-pipeline.js'),
        import('../../voice/ws-server.js'),
      ]);
      const pipeline = await createStreamingPipeline({
        stt: voiceStt,
        tts: voiceTts,
        endpointing: voiceEndpointing,
        diarization: voiceDiarization,
        bargeIn: voiceBargeIn,
        port: voicePort,
      });
      const voiceServer = await startVoiceServer(
        pipeline,
        () => {
          // Each WebSocket connection gets its own session ID, conversation
          // history, and AbortController. This ensures concurrent voice
          // calls do not share state.
          const voiceSessionId = `voice-${seedId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const voiceMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
          let aborted = false;
          /**
           * AbortController for the in-flight streaming LLM request.
           * Created fresh on each `sendText()` call and nulled in the
           * `finally` block. The `abort()` method below signals this
           * controller to cancel the HTTP stream on barge-in.
           */
          let streamController: AbortController | null = null;

          return {
            async *sendText(text: string): AsyncIterable<string> {
              // Reset abort state for the new utterance and create a fresh
              // AbortController so the signal is not pre-aborted from a
              // previous barge-in.
              aborted = false;
              streamController = new AbortController();
              voiceMessages.push({ role: 'user', content: text });

              const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
                scope: {
                  sessionId: voiceSessionId,
                  userId: localUserId,
                  personaId: activePersonaId,
                  tenantId,
                },
              });

              const voiceToolContext = {
                ...toolContext,
                gmiId: voiceSessionId,
                sessionId: voiceSessionId,
                interactiveSession: false,
                toolFailureMode: adaptiveDecision.toolFailureMode,
                adaptiveExecution: {
                  degraded: adaptiveDecision.degraded,
                  reason: adaptiveDecision.reason,
                  actions: adaptiveDecision.actions,
                  kpi: adaptiveDecision.kpi ?? undefined,
                },
              };

              let reply = '';
              let fallbackTriggered = false;
              let turnFailed = false;
              let toolCallCount = 0;

              try {
                // Use the streaming variant to yield tokens incrementally
                // as they arrive from the LLM, enabling real-time TTS
                // playback instead of waiting for the full response.
                const tokenStream = streamToolCallingTurn({
                  providerId,
                  apiKey: llmApiKey,
                  model,
                  messages: voiceMessages,
                  toolMap,
                  toolContext: voiceToolContext,
                  maxRounds: 8,
                  dangerouslySkipPermissions,
                  stepUpAuthConfig: createStepUpAuthConfigFromTier(policy.securityTier ?? 'balanced'),
                  strictToolNames,
                  askPermission,
                  toolFailureMode: adaptiveDecision.toolFailureMode,
                  baseUrl: llmBaseUrl,
                  ollamaOptions: buildOllamaRuntimeOptions(cfg?.ollama),
                  fallback: providerId === 'openai' ? openrouterFallback : undefined,
                  getApiKey: oauthGetApiKey,
                  signal: streamController.signal,
                  onFallback: () => {
                    fallbackTriggered = true;
                  },
                  onToolCall: () => {
                    toolCallCount += 1;
                  },
                });

                // Yield each token immediately as it arrives from the LLM.
                // The voice pipeline orchestrator feeds these directly into
                // the TTS session for real-time audio synthesis.
                let iterResult = await tokenStream.next();
                while (!iterResult.done) {
                  if (aborted) break;
                  reply += iterResult.value;
                  yield iterResult.value;
                  iterResult = await tokenStream.next();
                }
                // If the generator returned a full reply (after all rounds),
                // use it as the canonical reply text.
                if (iterResult.done && iterResult.value) {
                  reply = iterResult.value;
                }
              } catch (error) {
                // Abort errors during barge-in are expected — not a failure.
                if (error instanceof DOMException && error.name === 'AbortError') {
                  // Barge-in cancelled the stream; reply is whatever was
                  // accumulated so far.
                } else {
                  turnFailed = true;
                  throw error;
                }
              } finally {
                streamController = null;
                try {
                  await adaptiveRuntime.recordTurnOutcome({
                    scope: {
                      sessionId: voiceSessionId,
                      userId: localUserId,
                      personaId: activePersonaId,
                      tenantId,
                    },
                    degraded: adaptiveDecision.degraded || fallbackTriggered,
                    replyText: reply,
                    didFail: turnFailed,
                    toolCallCount,
                  });
                } catch {
                  // Voice transport should continue even if telemetry write fails.
                }
              }

              // Push the final reply into conversation history. Note: the
              // streaming variant already pushes into messages internally,
              // but only if the stream completed naturally. If aborted
              // mid-stream, we record the partial reply here.
              if (reply && !voiceMessages.some(
                (m) => m.role === 'assistant' && m.content === reply,
              )) {
                voiceMessages.push({ role: 'assistant', content: reply });
              }
            },
            abort() {
              // Mark as aborted so the sendText generator's inner loop
              // exits on its next iteration check.
              aborted = true;
              // Cancel the in-flight streaming LLM HTTP request immediately.
              // The abort signal propagates through streamToolCallingTurn ->
              // streamingOpenaiChatWithTools -> streamingChatCompletionsRequest
              // -> fetch(), tearing down the TCP connection and stopping token
              // generation at the provider. This saves both latency and tokens
              // when the user barges in mid-response.
              streamController?.abort();
            },
          };
        },
        { port: voicePort },
      );
      fmt.note(`Voice pipeline WebSocket server: ${voiceServer.url}`);
      // Ensure clean shutdown on process exit.
      process.once('SIGINT', () => void voiceServer.close());
      process.once('SIGTERM', () => void voiceServer.close());
    } catch (err) {
      fmt.warning(`Voice pipeline unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── ChatREPL — interactive session loop and slash commands ──
  const repl = new ChatREPL({
    toolMap,
    channelAdapters,
    autoApproveToolCalls,
    verbose,
    enableQueryRouter,
    renderer: streamRenderer,
    messages,
    conversationId,
    contextWindowManager: contextWindowManager as any,
    discoveryManager: discoveryManager as any,
    memoryAdapter,
    getCliQueryRouter: () => getCliQueryRouter() as any,
    applyResearchPrefix,
    runChatTurn,
  });

  // Expose the REPL's permission prompts to the rest of the setup code.
  const askPermission = repl.askPermission.bind(repl);
  const askCheckpoint =
    turnApprovalMode === 'off'
      ? undefined
      : repl.askCheckpoint.bind(repl);

  // ── Runtime folder access request tool ──
  if (!dangerouslySkipPermissions) {
    // Extract ShellService from a CLI executor tool so we can propagate folder grants
    const cliTool = toolMap.get('list_directory') || toolMap.get('file_read') || toolMap.get('file_write');
    const cliShellService: any = cliTool ? (cliTool as any).shellService : undefined;

    const folderAccessTool = createRequestFolderAccessTool({
      guardrails: getGuardrailsInstance(),
      agentId: seedId,
      onFolderGranted: (resolvedPath, operation) => {
        if (cliShellService && typeof cliShellService.addReadRoot === 'function') {
          cliShellService.addReadRoot(resolvedPath);
          if (operation === 'write' && typeof cliShellService.addWriteRoot === 'function') {
            cliShellService.addWriteRoot(resolvedPath);
          }
        }
      },
      requestPermission: async (req) => {
        return repl.askFolderPermission(req);
      },
    });
    toolMap.set('request_folder_access', folderAccessTool as any);
  }

  // ── Chat turn helper (shared by stdin and channel inputs) ──
  async function runChatTurn(
    input: string,
    replyTarget?: { adapter: ChannelAdapterInstance; conversationId: string }
  ): Promise<void> {
    messages.push({ role: 'user', content: input });

    // Retrieve and inject memory context
    if (memorySystem) {
      await injectMemoryContext(messages as any, memorySystem, input).catch(() => {});
    }

    // Track message in context window manager
    contextWindowManager?.addMessage('user', input);

    // Compact context window if approaching capacity
    if (contextWindowManager?.enabled) {
      try {
        const systemTokens = Math.ceil((systemPrompt?.length ?? 0) / 4);
        const compacted = await contextWindowManager.beforeTurn(systemTokens, 2000);
        if (compacted && compacted.length < messages.length) {
          // Replace messages with compacted version (keep system prompt)
          messages.splice(1);
          for (const cm of compacted) {
            if (cm.role !== 'system' || !cm.compacted) {
              messages.push({ role: cm.role, content: cm.content });
            } else {
              // Inject compaction summary as system message
              messages.splice(1, 0, { role: 'system', content: cm.content });
            }
          }
          {
            const stats = contextWindowManager.getStats();
            streamRenderer.renderCompactionStats(stats);
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // QueryRouter — intelligent tiered retrieval pre-processing
    //
    // Before the LLM generates a response, classify the user message and
    // retrieve relevant documentation context via the QueryRouter pipeline.
    // The retrieved context is injected as a system message so the LLM can
    // ground its answer in the knowledge corpus.
    try {
      const qr = queryRouterPromise ? await queryRouterPromise : null;
      if (qr) {
        const routeStart = Date.now();

        // Build lightweight conversation history for the classifier
        const convHistory: ConversationMessage[] = [];
        for (let i = Math.max(1, messages.length - 10); i < messages.length - 1; i++) {
          const m = messages[i];
          if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
            convHistory.push({ role: m.role as 'user' | 'assistant', content: m.content as string });
          }
        }

        const routerResult: QueryResult = await qr.route(input, convHistory);
        const routeDuration = Date.now() - routeStart;

        streamRenderer.renderQueryRouterDiag(routerResult as any, routeDuration);

        // Inject retrieved context when the router found relevant sources
        if (
          routerResult.classification.tier > 0 &&
          routerResult.sources.length > 0
        ) {
          // Remove any previous QueryRouter context injection
          for (let i = messages.length - 1; i >= 1; i--) {
            if (
              typeof messages[i]?.content === 'string' &&
              String(messages[i]!.content).startsWith('[QueryRouter Context]')
            ) {
              messages.splice(i, 1);
            }
          }

          const contextBlock = routerResult.sources
            .map(
              (s: { heading: string; path: string; relevanceScore: number; matchType: string }) =>
                `## ${s.heading} (${s.path})\nRelevance: ${s.relevanceScore.toFixed(2)} | Match: ${s.matchType}`,
            )
            .join('\n\n');

          const contextParts = ['[QueryRouter Context]'];
          contextParts.push(
            `The following documentation context was retrieved for this query (tier ${routerResult.classification.tier}, strategy: ${routerResult.classification.strategy}):`,
          );
          contextParts.push(contextBlock);

          // If the router produced a grounded answer, include it as
          // suggested context the LLM can draw from (not a direct reply).
          if (routerResult.answer) {
            contextParts.push(
              '\nGrounded answer from documentation retrieval (use as reference, not verbatim):',
            );
            contextParts.push(routerResult.answer);
          }

          // Inject after the system prompt (position 1)
          messages.splice(1, 0, {
            role: 'system',
            content: contextParts.join('\n'),
          });
        }

        // Surface capability recommendations to the LLM context when present
        const recs = (routerResult as QueryResult & { recommendations?: QueryResultRecommendations }).recommendations;
        if (recs) {
          if (recs.skills.length || recs.tools.length || recs.extensions.length) {
            const capParts = [
              ...recs.skills.map((s: { skillId: string }) => `skill:${s.skillId}`),
              ...recs.tools.map((t: { toolId: string }) => `tool:${t.toolId}`),
              ...recs.extensions.map((e: { extensionId: string }) => `ext:${e.extensionId}`),
            ];

            // Remove any previous recommendation injection
            for (let i = messages.length - 1; i >= 1; i--) {
              if (
                typeof messages[i]?.content === 'string' &&
                String(messages[i]!.content).startsWith('[Recommended Capabilities]')
              ) {
                messages.splice(i, 1);
              }
            }

            messages.splice(1, 0, {
              role: 'system',
              content: `[Recommended Capabilities]\nThe following capabilities were identified as relevant for this query: ${capParts.join(', ')}`,
            });
          }
        }
      }
    } catch {
      // Non-fatal — QueryRouter failure does not block the chat turn
    }

    // Capability discovery — inject tiered context for this turn
    try {
      const discoveryResult = await discoveryManager?.discoverForTurn(input);
      if (discoveryResult) {
        for (let i = messages.length - 1; i >= 1; i--) {
          if (
            typeof messages[i]?.content === 'string' &&
            String(messages[i]!.content).startsWith('[Capability Context]')
          ) {
            messages.splice(i, 1);
          }
        }
        const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
        if (discoveryResult.tier1.length > 0) {
          ctxParts.push(
            'Relevant capabilities:\n' +
              discoveryResult.tier1
                .map((result: { summaryText: string }) => result.summaryText)
                .join('\n')
          );
        }
        if (discoveryResult.tier2.length > 0) {
          ctxParts.push(
            discoveryResult.tier2.map((result: { fullText: string }) => result.fullText).join('\n')
          );
        }
        messages.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });
      }
    } catch {
      // Non-fatal
    }

    const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
      scope: {
        sessionId,
        userId: localUserId,
        personaId: activePersonaId,
        tenantId,
      },
    });
    (toolContext as any).toolFailureMode = adaptiveDecision.toolFailureMode;
    (toolContext as any).adaptiveExecution = {
      degraded: adaptiveDecision.degraded,
      reason: adaptiveDecision.reason,
      actions: adaptiveDecision.actions,
      kpi: adaptiveDecision.kpi ?? undefined,
    };

    let reply = '';
    let turnFailed = false;
    let fallbackTriggered = false;
    let toolCallCount = 0;
    let turnError: unknown;
    try {
      reply = await runToolCallingTurn({
        providerId,
        apiKey: llmApiKey,
        model,
        messages,
        toolMap,
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions,
        stepUpAuthConfig: createStepUpAuthConfigFromTier(policy.securityTier ?? 'balanced'),
        strictToolNames,
        askPermission,
        askCheckpoint,
        toolFailureMode: adaptiveDecision.toolFailureMode,
        baseUrl: llmBaseUrl,
        ollamaOptions: buildOllamaRuntimeOptions(cfg?.ollama),
        fallback: providerId === 'openai' ? openrouterFallback : undefined,
        getApiKey: oauthGetApiKey,
        onFallback: (_err, provider) => {
          fallbackTriggered = true;
          streamRenderer.renderFallbackNotice(provider);
        },
        onToolCall: (tool: ToolInstance, args: Record<string, unknown>) => {
          toolCallCount += 1;
          streamRenderer.renderToolCall(tool, args);
        },
        onToolResult: (info) => {
          if (!info.success && info.error) {
            toolFailureLearner.recordFailure({
              toolName: info.toolName,
              args: info.args,
              error: info.error,
              timestamp: new Date().toISOString(),
            });
          }
        },
        onToolProgress: (info) => {
          streamRenderer.renderToolProgress(info);
        },
      });
    } catch (error) {
      turnFailed = true;
      turnError = error;
      throw error;
    } finally {
      try {
        await adaptiveRuntime.recordTurnOutcome({
          scope: {
            sessionId,
            userId: localUserId,
            personaId: activePersonaId,
            tenantId,
          },
          degraded: adaptiveDecision.degraded || fallbackTriggered,
          replyText: reply,
          didFail: turnFailed,
          toolCallCount,
        });
      } catch (error) {
        console.warn('[wunderland/chat] Failed to record adaptive outcome', error);
      }

      // Flush tool failure lessons to RAG even if the turn produced no reply
      // or the tool-calling loop threw after recording failures.
      toolFailureLearner.flush().catch(() => {});

      await sessionTextLogger.logTurn({
        meta: {
          agentId: workspaceAgentId,
          seedId,
          displayName,
          providerId: String(providerId),
          model,
          personaId: activePersonaId,
        },
        sessionId,
        userText: input,
        reply,
        error: turnError,
        toolCallCount,
        durationMs: 0,
        fallbackTriggered,
      });
    }

    if (reply) {
      // Render the assistant reply (handles widget extraction, file saving,
      // browser launch, and terminal display via ChatStreamRenderer).
      await streamRenderer.renderAssistantReply(reply);

      // If this turn originated from a messaging channel, send the reply back
      if (replyTarget) {
        try {
          await replyTarget.adapter.sendMessage(replyTarget.conversationId, {
            blocks: [{ type: 'text', text: reply }],
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(
            `  ${frameBorder(chatFrameGlyphs().v)} ${wColor('!')} Channel reply failed: ${errMsg}`
          );
        }
      }

      // Track assistant reply in context window manager
      if (reply) contextWindowManager?.addMessage('assistant', reply);

      // Auto-ingest: extract and store memories from this turn (non-blocking)
      if (autoIngestPipeline) {
        autoIngestPipeline.processConversationTurn(conversationId, input, reply).catch(() => {});
      }

      // Persist conversation turns to per-agent storage (non-blocking)
      if (memoryAdapter) {
        const now = Date.now();
        Promise.all([
          memoryAdapter.storeConversationTurn(conversationId, {
            agentId: seedId,
            role: 'user',
            content: input,
            timestamp: now - 1,
          }),
          memoryAdapter.storeConversationTurn(conversationId, {
            agentId: seedId,
            role: 'assistant',
            content: reply,
            timestamp: now,
            model,
          }),
        ]).catch(() => {});
      }
    }
  }

  // ── Research classifier config ──
  const researchClassifierEnabled = cfg?.research?.autoClassify !== false;
  const researchMinDepth: ResearchDepth = (cfg?.research?.minDepthToInject as ResearchDepth) || 'quick';
  const classifierLlmCall = createResearchClassifierLlmCall({
    providerId,
    apiKey: llmApiKey,
    baseUrl: llmBaseUrl,
  });

  /**
   * Handle /research and /deep prefixes — wraps the query with explicit
   * instructions to use deep_research tool at the specified depth.
   *
   * Also runs the LLM-as-judge classifier for auto-detection when no
   * explicit prefix is given.
   */
  async function applyResearchPrefix(input: string): Promise<string> {
    // Explicit /research or /deep prefix — skip classifier
    const researchMatch = input.match(/^\/(research|deep)\s+(.+)/is);
    if (researchMatch) {
      const depth = researchMatch[1].toLowerCase() === 'deep' ? 'deep' : 'moderate';
      const query = researchMatch[2].trim();
      streamRenderer.renderExplicitResearch(depth, query);
      const prefix = buildResearchPrefix(depth as ResearchDepth);
      return prefix ? `${prefix}\n\n${query}` : query;
    }

    // Auto-classify with LLM-as-judge (if enabled)
    if (!researchClassifierEnabled) return input;

    const classification = await classifyResearchDepth(input, {
      enabled: true,
      llmCall: classifierLlmCall,
    });

    if (shouldInjectResearch(classification.depth, researchMinDepth)) {
      streamRenderer.renderResearchClassification(
        classification.depth,
        classification.reasoning,
        classification.latencyMs,
      );
      const prefix = buildResearchPrefix(classification.depth);
      return prefix ? `${prefix}\n\n${input}` : input;
    }

    return input;
  }

  // ── Enter the interactive REPL loop ──
  await repl.start();

  // ── Graceful shutdown ──
  repl.stop();
  await discoveryManager?.close();
  await adaptiveRuntime.close();
  if (agentStorageManager) await agentStorageManager.shutdown().catch(() => {});
  await cliBootstrap.shutdown().catch(() => {});
  await shutdownWunderlandOtel();

  // Session ended banner
  const cw = getChatWidth();
  const iw = cw - 2;
  const endDivL = Math.max(0, Math.floor((iw - 18) / 2));
  const endDivR = Math.max(0, iw - 18 - endDivL);
  console.log('');
  const g = glyphs();
  console.log(
    `  ${frameBorder(g.hr.repeat(endDivL))} ${chalk.hex(C.muted)('Session ended.')} ${frameBorder(g.hr.repeat(endDivR))}`
  );
  console.log('');

  // Force exit — lingering timers/handles from extensions or LLM clients can
  // keep the event loop alive indefinitely after the chat session ends.
  process.exit(0);
}
