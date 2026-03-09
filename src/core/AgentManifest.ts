/**
 * @fileoverview Agent Manifest — serializable agent configuration for export/import.
 * @module wunderland/core/AgentManifest
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { WunderlandAgentConfig } from '../api/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Serializable agent manifest format.
 * Can be exported to / imported from `agent.manifest.json`.
 */
export interface AgentManifest {
  /** Format version for forward compatibility */
  manifestVersion: 1;

  /** Timestamp of export (ISO 8601) */
  exportedAt: string;

  /** Source preset ID, if created from a preset */
  presetId?: string;

  /** Core identity */
  seedId: string;
  name: string;
  description: string;

  /** HEXACO personality traits (shorthand keys matching agent.config.json) */
  hexacoTraits: {
    honesty: number;
    emotionality: number;
    extraversion: number;
    agreeableness: number;
    conscientiousness: number;
    openness: number;
  };

  /** Named security tier */
  securityTier?: string;

  /** Explicit security profile */
  security?: {
    preLLMClassifier: boolean;
    dualLLMAudit: boolean;
    outputSigning: boolean;
    riskThreshold?: number;
  };

  /** Skills to auto-load */
  skills: string[];

  /** Channel platform IDs */
  channels: string[];

  /** Persona text (from PERSONA.md) */
  persona?: string;

  /** Custom system prompt */
  systemPrompt?: string;
  /** Default selected AgentOS persona ID */
  selectedPersonaId?: string;
  /** Optional LLM defaults */
  llmProvider?: string;
  llmModel?: string;
  llmAuthMethod?: 'api-key' | 'oauth';
  /** Optional extension configuration */
  extensions?: WunderlandAgentConfig['extensions'];
  extensionOverrides?: WunderlandAgentConfig['extensionOverrides'];
  /** Optional discovery and RAG configuration */
  discovery?: WunderlandAgentConfig['discovery'];
  rag?: WunderlandAgentConfig['rag'];
  /** Optional AgentOS persona registry configuration */
  personaRegistry?: WunderlandAgentConfig['personaRegistry'];

  /** Integrity hash from sealed.json (if sealed) */
  configHash?: string;

  /** Whether the agent was sealed at export time */
  sealed?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

// ============================================================================
// Export
// ============================================================================

/**
 * Export an agent directory to an AgentManifest.
 *
 * @param dir - Path to agent directory (must contain agent.config.json)
 * @returns The assembled manifest
 * @throws If agent.config.json is missing
 */
export function exportAgent(dir: string): AgentManifest {
  const configPath = join(dir, 'agent.config.json');
  if (!existsSync(configPath)) {
    throw new Error(`agent.config.json not found in ${dir}`);
  }

  const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

  // Read optional PERSONA.md
  const personaPath = join(dir, 'PERSONA.md');
  const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf-8') : undefined;

  // Read optional sealed.json
  const sealedPath = join(dir, 'sealed.json');
  let configHash: string | undefined;
  let sealed = false;
  if (existsSync(sealedPath)) {
    try {
      const sealedData = JSON.parse(readFileSync(sealedPath, 'utf-8')) as Record<string, unknown>;
      configHash = sealedData.configHash as string | undefined;
      sealed = true;
    } catch {
      // Malformed sealed.json — skip
    }
  }

  const p = (cfg.personality ?? {}) as Record<string, number>;

  const manifest: AgentManifest = {
    manifestVersion: 1,
    exportedAt: new Date().toISOString(),
    presetId: typeof cfg.presetId === 'string' ? cfg.presetId : undefined,
    seedId: String(cfg.seedId ?? ''),
    name: String(cfg.displayName ?? ''),
    description: String(cfg.bio ?? ''),
    hexacoTraits: {
      honesty: p.honesty ?? 0.7,
      emotionality: p.emotionality ?? 0.5,
      extraversion: p.extraversion ?? 0.6,
      agreeableness: p.agreeableness ?? 0.65,
      conscientiousness: p.conscientiousness ?? 0.8,
      openness: p.openness ?? 0.75,
    },
    securityTier: (cfg.security as Record<string, unknown>)?.tier as string | undefined,
    security: cfg.security as AgentManifest['security'],
    skills: Array.isArray(cfg.skills) ? (cfg.skills as string[]) : [],
    channels: Array.isArray(cfg.channels)
      ? (cfg.channels as string[])
      : Array.isArray(cfg.suggestedChannels)
        ? (cfg.suggestedChannels as string[])
        : [],
    persona,
    systemPrompt: typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : undefined,
    selectedPersonaId: typeof cfg.selectedPersonaId === 'string' ? cfg.selectedPersonaId : undefined,
    llmProvider: typeof cfg.llmProvider === 'string' ? cfg.llmProvider : undefined,
    llmModel: typeof cfg.llmModel === 'string' ? cfg.llmModel : undefined,
    llmAuthMethod: cfg.llmAuthMethod === 'oauth' || cfg.llmAuthMethod === 'api-key' ? cfg.llmAuthMethod : undefined,
    extensions: isPlainObject(cfg.extensions) ? cloneJson(cfg.extensions as AgentManifest['extensions']) : undefined,
    extensionOverrides: isPlainObject(cfg.extensionOverrides)
      ? cloneJson(cfg.extensionOverrides as AgentManifest['extensionOverrides'])
      : undefined,
    discovery: isPlainObject(cfg.discovery) ? cloneJson(cfg.discovery as AgentManifest['discovery']) : undefined,
    rag: isPlainObject(cfg.rag) ? cloneJson(cfg.rag as AgentManifest['rag']) : undefined,
    personaRegistry: isPlainObject(cfg.personaRegistry)
      ? cloneJson(cfg.personaRegistry as AgentManifest['personaRegistry'])
      : undefined,
    configHash,
    sealed,
  };

  return manifest;
}

// ============================================================================
// Import
// ============================================================================

/**
 * Import an AgentManifest into a target directory.
 * Creates agent.config.json and optionally PERSONA.md.
 *
 * @param manifest - The manifest to import
 * @param targetDir - Directory to write files to (created if missing)
 */
export function importAgent(manifest: AgentManifest, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });

  // Build agent.config.json from manifest
  const config: Record<string, unknown> = {
    seedId: manifest.seedId,
    displayName: manifest.name,
    bio: manifest.description,
    personality: manifest.hexacoTraits,
    systemPrompt: manifest.systemPrompt ?? 'You are an autonomous agent in the Wunderland network.',
    security: manifest.security ?? { preLLMClassifier: true, dualLLMAudit: true, outputSigning: true },
    skills: manifest.skills,
    suggestedChannels: manifest.channels,
    presetId: manifest.presetId,
    selectedPersonaId: manifest.selectedPersonaId,
    llmProvider: manifest.llmProvider,
    llmModel: manifest.llmModel,
    llmAuthMethod: manifest.llmAuthMethod,
    extensions: cloneJson(manifest.extensions),
    extensionOverrides: cloneJson(manifest.extensionOverrides),
    discovery: cloneJson(manifest.discovery),
    rag: cloneJson(manifest.rag),
    personaRegistry: cloneJson(manifest.personaRegistry),
    skillsDir: './skills',
  };

  if (manifest.securityTier && config.security) {
    (config.security as Record<string, unknown>).tier = manifest.securityTier;
  }

  writeFileSync(
    join(targetDir, 'agent.config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );

  // Write PERSONA.md if present
  if (manifest.persona) {
    writeFileSync(join(targetDir, 'PERSONA.md'), manifest.persona, 'utf-8');
  }

  // Create skills directory
  const skillsDir = join(targetDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Type guard: checks that data is a valid AgentManifest.
 */
export function validateManifest(data: unknown): data is AgentManifest {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;

  if (d.manifestVersion !== 1) return false;
  if (typeof d.seedId !== 'string') return false;
  if (typeof d.name !== 'string') return false;
  if (typeof d.description !== 'string') return false;
  if (typeof d.hexacoTraits !== 'object' || d.hexacoTraits === null) return false;
  if (!Array.isArray(d.skills)) return false;
  if (!Array.isArray(d.channels)) return false;
  if ('selectedPersonaId' in d && d.selectedPersonaId !== undefined && typeof d.selectedPersonaId !== 'string') return false;
  if ('llmProvider' in d && d.llmProvider !== undefined && typeof d.llmProvider !== 'string') return false;
  if ('llmModel' in d && d.llmModel !== undefined && typeof d.llmModel !== 'string') return false;
  if ('llmAuthMethod' in d && d.llmAuthMethod !== undefined && d.llmAuthMethod !== 'api-key' && d.llmAuthMethod !== 'oauth') return false;
  if ('extensions' in d && d.extensions !== undefined && !isPlainObject(d.extensions)) return false;
  if ('extensionOverrides' in d && d.extensionOverrides !== undefined && !isPlainObject(d.extensionOverrides)) return false;
  if ('discovery' in d && d.discovery !== undefined && !isPlainObject(d.discovery)) return false;
  if ('rag' in d && d.rag !== undefined && !isPlainObject(d.rag)) return false;
  if ('personaRegistry' in d && d.personaRegistry !== undefined && !isPlainObject(d.personaRegistry)) return false;

  return true;
}
