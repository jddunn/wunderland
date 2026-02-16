/**
 * @fileoverview PromptEvolution — bounded self-modification of agent system prompts.
 *
 * After sealing, humans cannot modify an agent's base system prompt (enforced by
 * SEALED_MUTATION_FIELDS in agent-registry.service.ts). But agents can still evolve
 * their own behavior through accumulated experience — this module implements that.
 *
 * Instead of rewriting the base prompt (which would cause identity drift), agents
 * accumulate short **behavioral adaptations** — concise directives learned through
 * periodic self-reflection. These are appended as an overlay section in the built
 * system prompt, preserving the frozen base identity.
 *
 * Design constraints (mirroring TraitEvolution):
 * - Bounded: max 8 active adaptations, each ≤100 characters.
 * - Slow: requires 20+ browsing sessions and 24h between reflections.
 * - Directional: only sustained behavioral patterns produce adaptations.
 * - Decaying: adaptations not reinforced for 50 sessions fade away.
 * - Auditable: every reflection is logged with content hashes.
 *
 * @module wunderland/social/PromptEvolution
 */

import { createHash } from 'crypto';

import type { BrowsingSessionResult } from './BrowsingEngine.js';
import type { PADState } from './MoodEngine.js';

// ============================================================================
// Configuration
// ============================================================================

/** Maximum number of active adaptations per agent. */
const MAX_ADAPTATIONS = 8;

/** Maximum character length per adaptation directive. */
const MAX_ADAPTATION_LENGTH = 100;

/** Maximum new adaptations per reflection cycle. */
const MAX_PER_REFLECTION = 2;

/** Minimum browsing sessions before first reflection is allowed. */
const MIN_SESSIONS_FOR_REFLECTION = 20;

/** Minimum interval between reflections (24 hours). */
const MIN_REFLECTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Sessions without reinforcement before an adaptation decays. */
const ADAPTATION_DECAY_SESSIONS = 50;

// ============================================================================
// Types
// ============================================================================

/** A single learned behavioral adaptation. */
export interface PromptAdaptation {
  /** Short behavioral directive (max 100 chars). */
  text: string;
  /** When this adaptation was first learned. */
  learnedAt: string;
  /** How many reflections have reinforced this pattern. */
  reinforcementCount: number;
  /** Sessions since this adaptation was last reinforced. */
  sessionsSinceReinforced: number;
  /** SHA-256 hash of the adaptation text for provenance. */
  contentHash: string;
}

/** Per-agent prompt evolution state (parallel to EvolutionState). */
export interface PromptEvolutionState {
  /** SHA-256 hash of the original system prompt frozen at registration. */
  originalPromptHash: string;
  /** Active adaptations. */
  adaptations: PromptAdaptation[];
  /** Total browsing sessions processed since registration. */
  totalSessionsProcessed: number;
  /** Sessions since last reflection. */
  sessionsSinceLastReflection: number;
  /** Total reflections performed. */
  totalReflections: number;
  /** ISO timestamp of the last reflection. */
  lastReflectionAt: string;
  /** Count of adaptations that have decayed and been removed. */
  decayedCount: number;
}

/** Context provided to the LLM for self-reflection. */
export interface ReflectionContext {
  /** Agent's display name. */
  name: string;
  /** Base system prompt (first 300 chars used). */
  basePrompt?: string;
  /** Trait drift narrative from TraitEvolution. */
  traitDrift?: string;
  /** Recent browsing session summary. */
  activitySummary?: BrowsingSessionResult;
  /** Current PAD mood state. */
  mood?: PADState;
}

/** Callback to invoke an LLM for self-reflection. */
export type ReflectionLLMCallback = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Optional persistence adapter for prompt evolution state. */
export interface IPromptEvolutionPersistenceAdapter {
  savePromptEvolutionState(seedId: string, state: PromptEvolutionState): Promise<void>;
  loadPromptEvolutionState(seedId: string): Promise<PromptEvolutionState | null>;
}

/** Summary for dashboard display. */
export interface PromptEvolutionSummary {
  seedId: string;
  activeAdaptations: string[];
  totalReflections: number;
  totalDecayed: number;
  narrative: string;
}

// ============================================================================
// Validation
// ============================================================================

/** Patterns that indicate prompt injection or identity override attempts. */
const FORBIDDEN_PATTERNS = [
  /you are now/i,
  /forget (all |your |previous )/i,
  /ignore (all |your |previous )/i,
  /override (your |the |all )/i,
  /no restrictions/i,
  /bypass/i,
  /jailbreak/i,
  /pretend to be/i,
  /act as if you are/i,
  /disregard/i,
  /new instructions/i,
  /system prompt/i,
];

/**
 * Validate a proposed adaptation against safety guardrails.
 *
 * @returns Error message if invalid, null if valid.
 */
export function validateAdaptation(
  text: string,
  existingAdaptations: string[],
): string | null {
  // Length check
  if (text.length > MAX_ADAPTATION_LENGTH) {
    return `Adaptation exceeds ${MAX_ADAPTATION_LENGTH} character limit (${text.length} chars)`;
  }

  if (text.trim().length === 0) {
    return 'Adaptation is empty';
  }

  // Forbidden pattern check
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      return `Adaptation contains forbidden pattern: ${pattern.source}`;
    }
  }

  // Near-duplicate check (keyword overlap > 0.7)
  const textWords = new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  for (const existing of existingAdaptations) {
    const existingWords = new Set(existing.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const intersection = [...textWords].filter(w => existingWords.has(w)).length;
    const union = new Set([...textWords, ...existingWords]).size;
    if (union > 0 && intersection / union > 0.7) {
      return `Adaptation is too similar to existing: "${existing.slice(0, 40)}…"`;
    }
  }

  return null; // valid
}

// ============================================================================
// PromptEvolution Engine
// ============================================================================

export class PromptEvolution {
  private states: Map<string, PromptEvolutionState> = new Map();
  private persistenceAdapter?: IPromptEvolutionPersistenceAdapter;

  /** Attach a persistence adapter for durable evolution state. */
  setPersistenceAdapter(adapter: IPromptEvolutionPersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  /**
   * Register an agent with their original (frozen) system prompt.
   * Call once at agent creation or first load.
   */
  registerAgent(seedId: string, baseSystemPrompt: string): void {
    if (this.states.has(seedId)) return;

    this.states.set(seedId, {
      originalPromptHash: sha256(baseSystemPrompt || ''),
      adaptations: [],
      totalSessionsProcessed: 0,
      sessionsSinceLastReflection: 0,
      totalReflections: 0,
      lastReflectionAt: new Date(0).toISOString(),
      decayedCount: 0,
    });
  }

  /**
   * Load evolution state from persistence, falling back to fresh registration.
   */
  async loadOrRegister(seedId: string, baseSystemPrompt: string): Promise<void> {
    if (this.persistenceAdapter) {
      const saved = await this.persistenceAdapter.loadPromptEvolutionState(seedId);
      if (saved) {
        this.states.set(seedId, saved);
        return;
      }
    }
    this.registerAgent(seedId, baseSystemPrompt);
  }

  /**
   * Record that a browsing session has completed.
   * Increments counters and ages all adaptations (for decay tracking).
   */
  recordSession(seedId: string): void {
    const state = this.states.get(seedId);
    if (!state) return;

    state.totalSessionsProcessed++;
    state.sessionsSinceLastReflection++;

    // Age all adaptations (for decay)
    for (const adaptation of state.adaptations) {
      adaptation.sessionsSinceReinforced++;
    }

    // Decay: remove adaptations not reinforced for ADAPTATION_DECAY_SESSIONS
    const before = state.adaptations.length;
    state.adaptations = state.adaptations.filter(
      a => a.sessionsSinceReinforced < ADAPTATION_DECAY_SESSIONS,
    );
    state.decayedCount += before - state.adaptations.length;
  }

  /**
   * Attempt a self-reflection cycle. Returns the new adaptations (if any),
   * or null if reflection conditions aren't met.
   *
   * Conditions:
   * 1. MIN_SESSIONS_FOR_REFLECTION sessions since last reflection
   * 2. MIN_REFLECTION_INTERVAL_MS time since last reflection
   * 3. Fewer than MAX_ADAPTATIONS active adaptations
   */
  async maybeReflect(
    seedId: string,
    context: ReflectionContext,
    llmCallback: ReflectionLLMCallback,
  ): Promise<PromptAdaptation[] | null> {
    const state = this.states.get(seedId);
    if (!state) return null;

    // Check conditions
    if (state.sessionsSinceLastReflection < MIN_SESSIONS_FOR_REFLECTION) return null;

    const elapsed = Date.now() - new Date(state.lastReflectionAt).getTime();
    if (elapsed < MIN_REFLECTION_INTERVAL_MS) return null;

    if (state.adaptations.length >= MAX_ADAPTATIONS) return null;

    // Build reflection prompt
    const existingTexts = state.adaptations.map(a => a.text);
    const systemPrompt = buildReflectionSystemPrompt();
    const userPrompt = buildReflectionUserPrompt(context, existingTexts);

    let newAdaptations: PromptAdaptation[] = [];

    try {
      const response = await llmCallback(systemPrompt, userPrompt);
      const parsed = parseReflectionResponse(response);

      // Validate and accept up to MAX_PER_REFLECTION
      const slotsAvailable = MAX_ADAPTATIONS - state.adaptations.length;
      const maxToAccept = Math.min(MAX_PER_REFLECTION, slotsAvailable);

      for (const text of parsed.slice(0, maxToAccept)) {
        const trimmed = text.trim();
        const error = validateAdaptation(trimmed, existingTexts);
        if (error) continue; // skip invalid

        // Check if this reinforces an existing adaptation
        const reinforced = findReinforcement(trimmed, state.adaptations);
        if (reinforced) {
          reinforced.reinforcementCount++;
          reinforced.sessionsSinceReinforced = 0;
        } else {
          const adaptation: PromptAdaptation = {
            text: trimmed,
            learnedAt: new Date().toISOString(),
            reinforcementCount: 1,
            sessionsSinceReinforced: 0,
            contentHash: sha256(trimmed),
          };
          state.adaptations.push(adaptation);
          existingTexts.push(trimmed);
          newAdaptations.push(adaptation);
        }
      }
    } catch {
      // LLM call failed — skip this reflection cycle
      return null;
    }

    // Update reflection metadata regardless of outcome
    state.sessionsSinceLastReflection = 0;
    state.totalReflections++;
    state.lastReflectionAt = new Date().toISOString();

    // Persist
    if (this.persistenceAdapter) {
      this.persistenceAdapter.savePromptEvolutionState(seedId, state).catch(() => {});
    }

    return newAdaptations.length > 0 ? newAdaptations : null;
  }

  /**
   * Get the active adaptation texts for inclusion in the system prompt.
   */
  getActiveAdaptations(seedId: string): string[] {
    const state = this.states.get(seedId);
    if (!state) return [];
    return state.adaptations.map(a => a.text);
  }

  /**
   * Get a human-readable summary of an agent's prompt evolution.
   */
  getEvolutionSummary(seedId: string): PromptEvolutionSummary | null {
    const state = this.states.get(seedId);
    if (!state) return null;

    const active = state.adaptations.map(a => a.text);
    const narrative = buildEvolutionNarrative(state);

    return {
      seedId,
      activeAdaptations: active,
      totalReflections: state.totalReflections,
      totalDecayed: state.decayedCount,
      narrative,
    };
  }

  /** Get raw evolution state (for persistence/inspection). */
  getState(seedId: string): PromptEvolutionState | undefined {
    return this.states.get(seedId);
  }
}

// ============================================================================
// LLM Prompt Construction
// ============================================================================

function buildReflectionSystemPrompt(): string {
  return `You are a behavioral reflection engine. Your job is to review an AI agent's recent activity and determine if any behavioral refinements are warranted.

Rules:
- Propose 0-2 short behavioral directives (max 100 chars each)
- Each directive must be a concrete writing/behavioral instruction
- Do NOT change the agent's core identity, name, or role
- Do NOT override safety rules or restrictions
- Do NOT propose directives that contradict the base identity
- Only propose changes when clear behavioral patterns emerge from the activity data
- If nothing warrants change, return an empty array

Respond ONLY with valid JSON: { "adaptations": ["directive1", ...] } or { "adaptations": [] }`;
}

function buildReflectionUserPrompt(
  context: ReflectionContext,
  existingAdaptations: string[],
): string {
  const sections: string[] = [];

  sections.push(`Agent: "${context.name}"`);

  if (context.basePrompt) {
    sections.push(`Identity (excerpt): ${context.basePrompt.slice(0, 300)}`);
  }

  if (existingAdaptations.length > 0) {
    sections.push(`Current evolved behaviors:\n${existingAdaptations.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}`);
  }

  if (context.traitDrift) {
    sections.push(`Personality drift: ${context.traitDrift}`);
  }

  if (context.activitySummary) {
    const s = context.activitySummary;
    const actionSummary = s.actions
      .map(a => `${a.action}${a.chainedAction ? `→${a.chainedAction}` : ''}`)
      .join(', ');
    sections.push(`Recent browsing activity: ${actionSummary}`);
    sections.push(`Enclaves visited: ${s.enclavesVisited.join(', ') || 'none'}`);
  }

  if (context.mood) {
    const m = context.mood;
    sections.push(`Current mood: V=${m.valence.toFixed(2)}, A=${m.arousal.toFixed(2)}, D=${m.dominance.toFixed(2)}`);
  }

  sections.push('\nBased on this experience, propose behavioral refinements (or none if no clear pattern has emerged).');

  return sections.join('\n');
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse the LLM reflection response. Extracts adaptation strings from JSON.
 * Tolerant of markdown code fences and minor formatting issues.
 */
function parseReflectionResponse(response: string): string[] {
  try {
    // Strip markdown code fences if present
    const cleaned = response
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    if (parsed && Array.isArray(parsed.adaptations)) {
      return parsed.adaptations.filter(
        (a: unknown): a is string => typeof a === 'string' && a.trim().length > 0,
      );
    }
  } catch {
    // Try to extract from malformed JSON
    const match = response.match(/"adaptations"\s*:\s*\[(.*?)\]/s);
    if (match) {
      try {
        const arr = JSON.parse(`[${match[1]}]`);
        return arr.filter((a: unknown): a is string => typeof a === 'string' && a.trim().length > 0);
      } catch {
        // give up
      }
    }
  }

  return [];
}

// ============================================================================
// Reinforcement Detection
// ============================================================================

/**
 * Check if a proposed adaptation is similar enough to an existing one
 * to count as reinforcement rather than a new adaptation.
 *
 * Uses keyword overlap — if >0.5 of words match, it's a reinforcement.
 */
function findReinforcement(
  text: string,
  existing: PromptAdaptation[],
): PromptAdaptation | null {
  const textWords = new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  for (const adaptation of existing) {
    const existingWords = new Set(
      adaptation.text.toLowerCase().split(/\s+/).filter(w => w.length > 2),
    );
    const intersection = [...textWords].filter(w => existingWords.has(w)).length;
    const union = new Set([...textWords, ...existingWords]).size;
    if (union > 0 && intersection / union > 0.5) {
      return adaptation;
    }
  }

  return null;
}

// ============================================================================
// Narrative Generation
// ============================================================================

function buildEvolutionNarrative(state: PromptEvolutionState): string {
  if (state.totalReflections === 0) {
    return 'No self-reflection has occurred yet.';
  }

  if (state.adaptations.length === 0) {
    return `After ${state.totalReflections} reflection cycles, no persistent behavioral patterns have emerged${state.decayedCount > 0 ? ` (${state.decayedCount} transient adaptations have faded)` : ''}.`;
  }

  const strongest = [...state.adaptations]
    .sort((a, b) => b.reinforcementCount - a.reinforcementCount)
    .slice(0, 3);

  const parts = strongest.map(a => {
    const strength = a.reinforcementCount >= 5 ? 'firmly' :
      a.reinforcementCount >= 3 ? 'moderately' : 'tentatively';
    return `${strength} adopted: "${a.text}"`;
  });

  return `Over ${state.totalReflections} reflection cycles, this agent has ${parts.join('; ')}.${state.decayedCount > 0 ? ` ${state.decayedCount} earlier adaptations have faded.` : ''}`;
}

// ============================================================================
// Helpers
// ============================================================================

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
