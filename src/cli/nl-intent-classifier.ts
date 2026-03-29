/**
 * @fileoverview Natural language intent classifier for CLI routing.
 *
 * Classifies free-form user input into one of five routing intents using
 * keyword heuristics. No LLM call — deterministic and instant (~0ms).
 *
 * The classifier is used by the CLI entry point to route unrecognized
 * commands through the appropriate handler (create, agency, mission,
 * chat, or help).
 *
 * @module wunderland/cli/nl-intent-classifier
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Intent categories recognized by the NL router. */
export type NLIntent = 'create' | 'agency' | 'mission' | 'chat' | 'help';

/** Human-readable label and equivalent CLI command for each intent. */
export interface IntentLabel {
  label: string;
  command: string;
}

// ── Classifier ─────────────────────────────────────────────────────────────

/**
 * Classify free-form user input into a routing intent using keyword heuristics.
 * No LLM call — deterministic and instant.
 *
 * **Priority order matters**: agency > create > mission > help > chat (default).
 *
 * - **agency**: input mentions both a collective noun (team, crew, squad, etc.)
 *   AND a creation verb (build, create, make, etc.).
 * - **create**: input mentions both a creation verb AND an agent noun
 *   (agent, bot, assistant, etc.).
 * - **mission**: input contains a research/investigation verb AND is longer
 *   than 50 characters (short inputs are more likely casual questions).
 * - **help**: input contains a question word AND ends with a question mark.
 * - **chat**: everything else.
 *
 * @param input - The raw user input string.
 * @returns The classified intent.
 */
export function classifyIntent(input: string): NLIntent {
  const lower = input.toLowerCase();

  // Team / agency creation — check BEFORE single-agent creation so
  // "Create a team: researcher, analyst" doesn't route to `create`.
  if (
    /\b(team|crew|group|squad|agency|collective|collaborate|coordinate)\b/i.test(lower) &&
    /\b(build|create|make|set\s*up|scaffold|assemble|form)\b/i.test(lower)
  ) {
    return 'agency';
  }

  // Single-agent creation intents
  if (
    /\b(build|create|make|set\s*up|scaffold|generate|deploy)\b/i.test(lower) &&
    /\b(agent|bot|assistant|wunderbot|wunder\s*bot)\b/i.test(lower)
  ) {
    return 'create';
  }

  // Mission intents — complex multi-step goals (longer input implies mission scope)
  if (
    /\b(research|investigate|analyze|compare|write\s+a\s+report|generate\s+a\s+report|find\s+and\s+summarize|monitor\s+and|scrape\s+and|collect\s+and)\b/i.test(lower) &&
    lower.length > 50
  ) {
    return 'mission';
  }

  // Help / question intents — anything that reads like a question
  if (
    /\b(what|how|why|where|which|can\s+you|do\s+you|does\s+it|is\s+there|tell\s+me|explain|show\s+me)\b/i.test(lower) &&
    /\?$/.test(input.trim())
  ) {
    return 'help';
  }

  // Default: treat as a conversational chat message
  return 'chat';
}

// ── Labels ─────────────────────────────────────────────────────────────────

/** Human-readable labels for each intent, shown in the routing message. */
export const INTENT_LABELS: Record<NLIntent, IntentLabel> = {
  create:  { label: 'create agent',    command: 'wunderland create' },
  agency:  { label: 'create agency',   command: 'wunderland agency create' },
  mission: { label: 'run mission',     command: 'wunderland mission' },
  chat:    { label: 'chat',            command: 'wunderland chat' },
  help:    { label: 'answer question', command: 'wunderland chat' },
};
