/**
 * @fileoverview PresetLoader - Loads preset agent configurations and templates from disk.
 * @module wunderland/core/PresetLoader
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Types
// ============================================================================

/**
 * A loaded agent preset, combining the JSON config with the PERSONA.md contents.
 */
export interface AgentPreset {
  /** Preset identifier (folder name, e.g. "research-assistant") */
  id: string;

  /** Human-readable name */
  name: string;

  /** Short description of the agent */
  description: string;

  /** HEXACO personality trait values (0-1) */
  hexacoTraits: {
    honesty: number;
    emotionality: number;
    extraversion: number;
    agreeableness: number;
    conscientiousness: number;
    openness: number;
  };

  /** Security tier preset name */
  securityTier: string;

  /** Suggested skill IDs for this agent */
  suggestedSkills: string[];

  /** Suggested channel platform IDs for this agent */
  suggestedChannels: string[];

  /** Full contents of the PERSONA.md file */
  persona: string;
}

/**
 * A loaded template configuration.
 */
export interface TemplateConfig {
  /** Template identifier (filename without .json extension) */
  id: string;

  /** All fields from the template JSON */
  [key: string]: unknown;
}

// ============================================================================
// PresetLoader
// ============================================================================

/**
 * Loads preset agent configurations and deployment templates from the
 * `presets/` directory shipped with the wunderland package.
 *
 * Presets are read synchronously via `fs.readFileSync` because they are
 * small config files loaded at startup or on-demand during CLI flows.
 *
 * @example
 * ```typescript
 * const loader = new PresetLoader();
 *
 * // List all available agent presets
 * const presets = loader.listPresets();
 * console.log(presets.map(p => p.name));
 *
 * // Load a specific preset
 * const researcher = loader.loadPreset('research-assistant');
 * console.log(researcher.persona);
 *
 * // Load a deployment template
 * const template = loader.loadTemplate('enterprise');
 * console.log(template.securityTier);
 * ```
 */
export class PresetLoader {
  private readonly presetsDir: string;

  /**
   * @param presetsDir - Override the default presets directory. When omitted,
   *   resolves to `<package-root>/presets` relative to this source file.
   */
  constructor(presetsDir?: string) {
    this.presetsDir =
      presetsDir ?? resolve(fileURLToPath(import.meta.url), '../../../presets');
  }

  // --------------------------------------------------------------------------
  // Agent Presets
  // --------------------------------------------------------------------------

  /**
   * Returns the list of all known preset IDs.
   * This is a static convenience so callers can enumerate presets without
   * instantiating the loader or touching the filesystem.
   */
  static getPresetIds(): string[] {
    return [
      'research-assistant',
      'customer-support',
      'creative-writer',
      'code-reviewer',
      'data-analyst',
      'security-auditor',
      'devops-assistant',
      'personal-assistant',
    ];
  }

  /**
   * Scans the `presets/agents/` directory and loads every agent preset.
   *
   * @returns Array of all agent presets, sorted alphabetically by ID.
   * @throws If the agents directory does not exist.
   */
  listPresets(): AgentPreset[] {
    const agentsDir = join(this.presetsDir, 'agents');

    if (!existsSync(agentsDir)) {
      throw new Error(
        `Presets agents directory not found: ${agentsDir}. ` +
          'Ensure the wunderland package includes the presets/ directory.',
      );
    }

    const entries = readdirSync(agentsDir, { withFileTypes: true });
    const presets: AgentPreset[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const configPath = join(agentsDir, entry.name, 'agent.config.json');
      if (!existsSync(configPath)) continue;

      try {
        presets.push(this._loadPresetFromDir(entry.name, agentsDir));
      } catch {
        // Skip malformed presets during listing — callers can use
        // loadPreset() directly for stricter error handling.
      }
    }

    return presets.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Loads a single agent preset by its folder name.
   *
   * @param id - Preset folder name (e.g. "research-assistant")
   * @returns The loaded AgentPreset
   * @throws If the preset directory or required files are missing.
   */
  loadPreset(id: string): AgentPreset {
    const agentsDir = join(this.presetsDir, 'agents');
    return this._loadPresetFromDir(id, agentsDir);
  }

  /**
   * Returns the absolute filesystem path to a preset's directory.
   *
   * @param id - Preset folder name
   * @returns Absolute path to the preset directory
   */
  getPresetPath(id: string): string {
    return join(this.presetsDir, 'agents', id);
  }

  // --------------------------------------------------------------------------
  // Templates
  // --------------------------------------------------------------------------

  /**
   * Scans the `presets/templates/` directory and loads every template.
   *
   * @returns Array of all template configs, sorted alphabetically by ID.
   * @throws If the templates directory does not exist.
   */
  listTemplates(): TemplateConfig[] {
    const templatesDir = join(this.presetsDir, 'templates');

    if (!existsSync(templatesDir)) {
      throw new Error(
        `Presets templates directory not found: ${templatesDir}. ` +
          'Ensure the wunderland package includes the presets/ directory.',
      );
    }

    const entries = readdirSync(templatesDir, { withFileTypes: true });
    const templates: TemplateConfig[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const id = entry.name.replace(/\.json$/, '');
      try {
        templates.push(this._loadTemplateFromFile(id, templatesDir));
      } catch {
        // Skip malformed templates during listing.
      }
    }

    return templates.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Loads a single template by name (without the `.json` extension).
   *
   * @param id - Template name (e.g. "enterprise")
   * @returns The loaded TemplateConfig
   * @throws If the template file is missing or contains invalid JSON.
   */
  loadTemplate(id: string): TemplateConfig {
    const templatesDir = join(this.presetsDir, 'templates');
    return this._loadTemplateFromFile(id, templatesDir);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Loads a preset from a named subdirectory within the agents dir.
   */
  private _loadPresetFromDir(id: string, agentsDir: string): AgentPreset {
    const presetDir = join(agentsDir, id);
    const configPath = join(presetDir, 'agent.config.json');
    const personaPath = join(presetDir, 'PERSONA.md');

    if (!existsSync(configPath)) {
      throw new Error(
        `Agent preset config not found: ${configPath}. ` +
          `Ensure the "${id}" preset directory contains an agent.config.json file.`,
      );
    }

    const rawConfig = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(rawConfig) as Record<string, unknown>;

    // PERSONA.md is optional but expected — fall back to empty string.
    let persona = '';
    if (existsSync(personaPath)) {
      persona = readFileSync(personaPath, 'utf-8');
    }

    return {
      id,
      name: config.name as string,
      description: config.description as string,
      hexacoTraits: config.hexacoTraits as AgentPreset['hexacoTraits'],
      securityTier: config.securityTier as string,
      suggestedSkills: (config.suggestedSkills as string[]) ?? [],
      suggestedChannels: (config.suggestedChannels as string[]) ?? [],
      persona,
    };
  }

  /**
   * Loads a template JSON file from the templates dir.
   */
  private _loadTemplateFromFile(id: string, templatesDir: string): TemplateConfig {
    const filePath = join(templatesDir, `${id}.json`);

    if (!existsSync(filePath)) {
      throw new Error(
        `Template config not found: ${filePath}. ` +
          `Available templates can be listed with listTemplates().`,
      );
    }

    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    return {
      id,
      ...config,
    };
  }
}
