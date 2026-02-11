/**
 * @fileoverview LLM-powered extraction from natural language agent descriptions.
 * @module wunderland/ai/NaturalLanguageAgentBuilder
 *
 * Extracts structured agent configuration from natural language descriptions:
 * - Preset selection
 * - Skills, extensions, channels
 * - Personality traits (HEXACO)
 * - Security & permission levels
 */

import type { SecurityTierName } from '../security/SecurityTiers.js';
import type { PermissionSetName } from '../security/SecurityTiers.js';

// ============================================================================
// Types
// ============================================================================

/**
 * LLM invoker function signature.
 * Takes a prompt and returns the LLM's text response.
 */
export type LLMInvoker = (prompt: string) => Promise<string>;

/**
 * Tool access profile names (from ToolAccessProfiles.ts).
 */
export type ToolAccessProfileName =
  | 'social-citizen'
  | 'social-observer'
  | 'social-creative'
  | 'assistant'
  | 'unrestricted';

/**
 * Execution mode for agent tool calling.
 */
export type ExecutionMode = 'autonomous' | 'human-all' | 'human-dangerous';

/**
 * Extracted agent configuration from natural language.
 */
export interface ExtractedAgentConfig {
  // Identity
  seedId?: string;
  displayName?: string;
  bio?: string;
  systemPrompt?: string;

  // Personality (HEXACO traits, 0-1 scale)
  personality?: {
    honesty: number;
    emotionality: number;
    extraversion: number;
    agreeableness: number;
    conscientiousness: number;
    openness: number;
  };

  // Capabilities
  preset?: string;
  skills?: string[];
  extensions?: {
    tools?: string[];
    voice?: string[];
    productivity?: string[];
  };
  channels?: string[];

  // Security
  securityTier?: SecurityTierName;
  permissionSet?: PermissionSetName;
  toolAccessProfile?: ToolAccessProfileName;
  executionMode?: ExecutionMode;

  // Voice
  voiceConfig?: {
    provider?: string;
    voiceId?: string;
  };

  // Confidence scores (0-1) for each field
  confidence?: Record<string, number>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * System prompt for LLM extraction.
 * Lists all available options and defines the expected JSON schema.
 */
const EXTRACTION_PROMPT = `You are an AI configuration expert. Extract structured agent configuration from the user's natural language description.

**Available presets:**
- research-assistant: Thorough researcher with analytical focus
- customer-support: Patient, empathetic support specialist
- creative-writer: Imaginative storyteller and content creator
- code-reviewer: Precise, detail-oriented code analyst
- data-analyst: Systematic data interpreter and visualizer
- security-auditor: Vigilant security-focused analyst
- devops-assistant: Infrastructure and deployment specialist
- personal-assistant: Friendly, organized daily helper

**Available skills (18 curated):**
web-search, weather, summarize, github, coding-agent, git, slack-helper, discord-helper, notion, obsidian, trello, apple-notes, apple-reminders, healthcheck, spotify-player, whisper-transcribe, 1password, image-gen

**Available tools:**
web-search, web-browser, cli-executor, giphy, image-search, voice-synthesis, news-search

**Available channels (20 platforms):**
telegram, whatsapp, discord, slack, webchat, signal, imessage, google-chat, teams, matrix, zalo, email, sms, nostr, twitch, line, feishu, mattermost, nextcloud-talk, tlon

**Security tiers:**
- dangerous: All protections OFF (testing only)
- permissive: Lightweight input screening (dev environments)
- balanced: Recommended default (production)
- strict: All layers enabled, external actions gated
- paranoid: Maximum security, HITL for all actions

**Permission sets:**
- unrestricted: All permissions (admin/testing)
- autonomous: Read/write files, CLI, memory (production autonomous)
- supervised: Read files only, no CLI (production supervised)
- read-only: Read files/memory only, no writes (research/analysis)
- minimal: No filesystem, web-only (minimal privileges)

**Tool access profiles:**
- social-citizen: Full social participation (post/comment/vote)
- social-observer: Read-only (browse/search)
- social-creative: Citizen + voice/image generation
- assistant: Private assistant mode (search/media/memory/productivity)
- unrestricted: Full access (admin only)

**Execution modes:**
- autonomous: Auto-execute all tool calls
- human-dangerous: Require approval for dangerous actions
- human-all: Require approval for all actions

**IMPORTANT INSTRUCTIONS:**
1. Respond ONLY with valid JSON matching the schema below
2. Set confidence scores (0-1) for each extracted field
3. Use null for fields you cannot confidently extract
4. Extract HEXACO personality traits (0-1 scale) from description if mentioned, otherwise infer reasonable defaults
5. Suggest appropriate preset, skills, extensions, and channels based on description
6. Choose security tier and permissions appropriate for the use case

**JSON Schema:**
{
  "displayName": "string or null",
  "bio": "string or null",
  "systemPrompt": "string or null",
  "personality": {
    "honesty": 0.0-1.0,
    "emotionality": 0.0-1.0,
    "extraversion": 0.0-1.0,
    "agreeableness": 0.0-1.0,
    "conscientiousness": 0.0-1.0,
    "openness": 0.0-1.0
  },
  "preset": "preset-name or null",
  "skills": ["skill1", "skill2"] or null,
  "extensions": {
    "tools": ["tool1"] or null,
    "voice": [] or null,
    "productivity": [] or null
  },
  "channels": ["channel1"] or null,
  "securityTier": "balanced" or other tier,
  "permissionSet": "supervised" or other set,
  "toolAccessProfile": "assistant" or other profile,
  "executionMode": "human-dangerous" or other mode,
  "voiceConfig": { "provider": "openai", "voiceId": "nova" } or null,
  "confidence": {
    "displayName": 0.0-1.0,
    "preset": 0.0-1.0,
    "skills": 0.0-1.0,
    ...
  }
}

**User description:** {{DESCRIPTION}}`;

// ============================================================================
// Functions
// ============================================================================

/**
 * Extract agent configuration from natural language description.
 * Requires API key setup (validates before calling LLM).
 *
 * @param description - Natural language description of the desired agent
 * @param llmInvoker - Function that invokes the LLM with a prompt
 * @param existingConfig - Existing configuration to merge with (for updates)
 * @param hostingMode - Whether this is for managed or self-hosted deployment
 * @returns Extracted configuration with confidence scores
 *
 * @throws {Error} If description is empty or LLM call fails
 *
 * @example
 * ```typescript
 * const config = await extractAgentConfig(
 *   "I need a research bot that searches the web and summarizes articles",
 *   async (prompt) => await openai.complete(prompt),
 *   undefined,
 *   'self_hosted'
 * );
 * console.log(config.preset); // "research-assistant"
 * console.log(config.extensions?.tools); // ["web-search", "web-browser", "news-search"]
 * console.log(config.confidence?.preset); // 0.95
 * ```
 */
export async function extractAgentConfig(
  description: string,
  llmInvoker: LLMInvoker,
  existingConfig?: Partial<ExtractedAgentConfig>,
  hostingMode?: 'managed' | 'self_hosted',
): Promise<ExtractedAgentConfig> {
  // Validate inputs
  if (!description.trim()) {
    throw new Error('Description cannot be empty');
  }

  // Build prompt
  let finalPrompt = EXTRACTION_PROMPT.replace('{{DESCRIPTION}}', description);

  // Add context for existing config (update mode)
  if (existingConfig) {
    finalPrompt += `\n\n**Existing config (merge changes with this):**\n${JSON.stringify(existingConfig, null, 2)}`;
  }

  // Add hosting mode restrictions
  if (hostingMode === 'managed') {
    finalPrompt += `\n\n**IMPORTANT: This is for a managed runtime. DO NOT suggest:**
- cli-executor tool or any filesystem tools
- github, git, 1password, obsidian, apple-notes, apple-reminders skills
- Anything requiring filesystem/CLI access
- Use stricter security tiers (balanced or strict)`;
  }

  try {
    // Call LLM
    const response = await llmInvoker(finalPrompt);

    // Parse JSON response (robust to code fences / leading text)
    const extracted = parseJsonFromLLMResponse<ExtractedAgentConfig>(response);

    // Validate preset if specified
    const validPresets = [
      'research-assistant',
      'customer-support',
      'creative-writer',
      'code-reviewer',
      'data-analyst',
      'security-auditor',
      'devops-assistant',
      'personal-assistant',
    ];
    if (extracted.preset && !validPresets.includes(extracted.preset)) {
      console.warn(`Invalid preset "${extracted.preset}", ignoring`);
      delete extracted.preset;
    }

    // Validate security tier
    const validTiers: SecurityTierName[] = ['dangerous', 'permissive', 'balanced', 'strict', 'paranoid'];
    if (extracted.securityTier && !validTiers.includes(extracted.securityTier)) {
      console.warn(`Invalid security tier "${extracted.securityTier}", defaulting to balanced`);
      extracted.securityTier = 'balanced';
    }

    // Validate permission set
    const validPermissionSets: PermissionSetName[] = [
      'unrestricted',
      'autonomous',
      'supervised',
      'read-only',
      'minimal',
    ];
    if (extracted.permissionSet && !validPermissionSets.includes(extracted.permissionSet)) {
      console.warn(`Invalid permission set "${extracted.permissionSet}", defaulting to supervised`);
      extracted.permissionSet = 'supervised';
    }

    // Validate tool access profile
    const validProfiles: ToolAccessProfileName[] = [
      'social-citizen',
      'social-observer',
      'social-creative',
      'assistant',
      'unrestricted',
    ];
    if (extracted.toolAccessProfile && !validProfiles.includes(extracted.toolAccessProfile)) {
      console.warn(`Invalid tool access profile "${extracted.toolAccessProfile}", defaulting to assistant`);
      extracted.toolAccessProfile = 'assistant';
    }

    // Generate seedId from displayName if not provided
    if (extracted.displayName && !extracted.seedId) {
      extracted.seedId = `seed_${extracted.displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .slice(0, 24)}`;
    }

    // Set defaults for missing critical fields
    if (!extracted.securityTier) {
      extracted.securityTier = 'balanced';
    }
    if (!extracted.permissionSet) {
      extracted.permissionSet = 'supervised';
    }
    if (!extracted.toolAccessProfile) {
      extracted.toolAccessProfile = 'assistant';
    }
    if (!extracted.executionMode) {
      extracted.executionMode = 'human-dangerous';
    }

    return extracted;
  } catch (err) {
    throw new Error(`Failed to extract config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseJsonFromLLMResponse<T>(raw: string): T {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('LLM returned an empty response');

  // 1) Direct JSON
  try {
    return JSON.parse(text) as T;
  } catch {
    // continue
  }

  // 2) ```json fenced blocks
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    try {
      return JSON.parse(fenced) as T;
    } catch {
      // continue
    }
  }

  // 3) Best-effort: first {...} span
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // fall through
    }
  }

  throw new Error('LLM did not return valid JSON');
}

/**
 * Validate API key before allowing agent creation.
 * Prevents user from going through full wizard only to fail at the end.
 *
 * @param provider - LLM provider name (e.g., "openai", "anthropic", "ollama")
 * @param apiKey - API key to validate (optional for ollama)
 * @returns True if API key format is valid
 *
 * @example
 * ```typescript
 * if (!validateApiKeySetup('openai', process.env.OPENAI_API_KEY)) {
 *   throw new Error('OPENAI_API_KEY required for natural language agent creation');
 * }
 * ```
 */
export function validateApiKeySetup(provider: string, apiKey?: string): boolean {
  if (!apiKey || apiKey.trim().length === 0) {
    return false;
  }

  // Basic format validation
  switch (provider.toLowerCase()) {
    case 'openai':
      return apiKey.startsWith('sk-');
    case 'anthropic':
      return apiKey.startsWith('sk-ant-');
    case 'ollama':
      return true; // No key needed for local Ollama
    case 'google':
    case 'gemini':
      return apiKey.length > 20; // Generic check for Google AI
    case 'groq':
      return apiKey.startsWith('gsk_');
    case 'together':
    case 'deepseek':
    case 'mistral':
      return apiKey.length > 10; // Basic check
    default:
      return apiKey.length > 10; // Generic fallback
  }
}
