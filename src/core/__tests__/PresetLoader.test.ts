/**
 * @fileoverview Tests for PresetLoader — loads preset agent configs and templates from disk.
 * @module wunderland/core/__tests__/PresetLoader.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { PresetLoader } from '../PresetLoader.js';
import type { AgentPreset, TemplateConfig } from '../PresetLoader.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_PRESETS_DIR = '/fake/presets';

function makeDirent(name: string, opts: { isDir?: boolean; isFile?: boolean } = {}) {
  return {
    name,
    isDirectory: () => opts.isDir ?? false,
    isFile: () => opts.isFile ?? false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: '',
    path: '',
  };
}

const SAMPLE_CONFIG = {
  name: 'Research Assistant',
  description: 'A scholarly research agent',
  hexacoTraits: {
    honesty: 0.9,
    emotionality: 0.4,
    extraversion: 0.5,
    agreeableness: 0.7,
    conscientiousness: 0.85,
    openness: 0.95,
  },
  securityTier: 'standard',
  suggestedSkills: ['web-search', 'summarize'],
  suggestedChannels: ['webchat', 'slack'],
};

const SAMPLE_PERSONA = '# Research Assistant\n\nYou are a meticulous researcher.';

// ── getPresetIds (static) ───────────────────────────────────────────────────

describe('PresetLoader.getPresetIds (static)', () => {
  it('should return 8 known preset IDs', () => {
    const ids = PresetLoader.getPresetIds();
    expect(ids).toHaveLength(8);
  });

  it('should include research-assistant', () => {
    const ids = PresetLoader.getPresetIds();
    expect(ids).toContain('research-assistant');
  });

  it('should include personal-assistant', () => {
    const ids = PresetLoader.getPresetIds();
    expect(ids).toContain('personal-assistant');
  });
});

// ── loadPreset ──────────────────────────────────────────────────────────────

describe('PresetLoader.loadPreset', () => {
  let loader: PresetLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    loader = new PresetLoader(TEST_PRESETS_DIR);
  });

  it('should throw when agent.config.json not found', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => loader.loadPreset('nonexistent')).toThrow(
      /Agent preset config not found/,
    );
  });

  it('should read agent.config.json and PERSONA.md', () => {
    const configPath = join(TEST_PRESETS_DIR, 'agents', 'research-assistant', 'agent.config.json');
    const personaPath = join(TEST_PRESETS_DIR, 'agents', 'research-assistant', 'PERSONA.md');

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === configPath || p === personaPath) return true;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (p === configPath) return JSON.stringify(SAMPLE_CONFIG);
      if (p === personaPath) return SAMPLE_PERSONA;
      throw new Error(`Unexpected read: ${p}`);
    });

    const preset = loader.loadPreset('research-assistant');

    expect(vi.mocked(readFileSync)).toHaveBeenCalledWith(configPath, 'utf-8');
    expect(vi.mocked(readFileSync)).toHaveBeenCalledWith(personaPath, 'utf-8');
    expect(preset.persona).toBe(SAMPLE_PERSONA);
  });

  it('should return AgentPreset with correct fields', () => {
    const configPath = join(TEST_PRESETS_DIR, 'agents', 'research-assistant', 'agent.config.json');
    const personaPath = join(TEST_PRESETS_DIR, 'agents', 'research-assistant', 'PERSONA.md');

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === configPath || p === personaPath) return true;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (p === configPath) return JSON.stringify(SAMPLE_CONFIG);
      if (p === personaPath) return SAMPLE_PERSONA;
      throw new Error(`Unexpected read: ${p}`);
    });

    const preset = loader.loadPreset('research-assistant');

    expect(preset.id).toBe('research-assistant');
    expect(preset.name).toBe('Research Assistant');
    expect(preset.description).toBe('A scholarly research agent');
    expect(preset.hexacoTraits.honesty).toBe(0.9);
    expect(preset.hexacoTraits.openness).toBe(0.95);
    expect(preset.securityTier).toBe('standard');
    expect(preset.suggestedSkills).toEqual(['web-search', 'summarize']);
    expect(preset.suggestedChannels).toEqual(['webchat', 'slack']);
    expect(preset.persona).toBe(SAMPLE_PERSONA);
  });

  it('should fall back to empty persona if PERSONA.md is missing', () => {
    const configPath = join(TEST_PRESETS_DIR, 'agents', 'research-assistant', 'agent.config.json');
    const personaPath = join(TEST_PRESETS_DIR, 'agents', 'research-assistant', 'PERSONA.md');

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === configPath) return true;
      if (p === personaPath) return false;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (p === configPath) return JSON.stringify(SAMPLE_CONFIG);
      throw new Error(`Unexpected read: ${p}`);
    });

    const preset = loader.loadPreset('research-assistant');

    expect(preset.persona).toBe('');
  });

  it('should set suggestedSkills from config, defaulting to []', () => {
    const configPath = join(TEST_PRESETS_DIR, 'agents', 'minimal', 'agent.config.json');
    const personaPath = join(TEST_PRESETS_DIR, 'agents', 'minimal', 'PERSONA.md');

    const configWithoutSkills = { ...SAMPLE_CONFIG };
    delete (configWithoutSkills as Record<string, unknown>).suggestedSkills;

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === configPath) return true;
      if (p === personaPath) return false;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (p === configPath) return JSON.stringify(configWithoutSkills);
      throw new Error(`Unexpected read: ${p}`);
    });

    const preset = loader.loadPreset('minimal');
    expect(preset.suggestedSkills).toEqual([]);
  });
});

// ── listPresets ──────────────────────────────────────────────────────────────

describe('PresetLoader.listPresets', () => {
  let loader: PresetLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    loader = new PresetLoader(TEST_PRESETS_DIR);
  });

  it('should throw when agents directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => loader.listPresets()).toThrow(
      /Presets agents directory not found/,
    );
  });

  it('should return sorted array of presets', () => {
    const agentsDir = join(TEST_PRESETS_DIR, 'agents');

    vi.mocked(existsSync).mockImplementation((p) => {
      // agents dir exists
      if (p === agentsDir) return true;
      // config files exist for both presets
      if (String(p).endsWith('agent.config.json')) return true;
      // persona files don't exist
      return false;
    });

    vi.mocked(readdirSync).mockReturnValue([
      makeDirent('data-analyst', { isDir: true }),
      makeDirent('code-reviewer', { isDir: true }),
    ] as any);

    const configA = { ...SAMPLE_CONFIG, name: 'Code Reviewer', description: 'Reviews code' };
    const configB = { ...SAMPLE_CONFIG, name: 'Data Analyst', description: 'Analyzes data' };

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (String(p).includes('code-reviewer')) return JSON.stringify(configA);
      if (String(p).includes('data-analyst')) return JSON.stringify(configB);
      throw new Error(`Unexpected read: ${p}`);
    });

    const presets = loader.listPresets();

    expect(presets).toHaveLength(2);
    // Should be sorted alphabetically by id
    expect(presets[0].id).toBe('code-reviewer');
    expect(presets[1].id).toBe('data-analyst');
  });

  it('should skip non-directory entries', () => {
    const agentsDir = join(TEST_PRESETS_DIR, 'agents');

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === agentsDir) return true;
      if (String(p).endsWith('agent.config.json')) return true;
      return false;
    });

    vi.mocked(readdirSync).mockReturnValue([
      makeDirent('README.md', { isFile: true }),
      makeDirent('research-assistant', { isDir: true }),
    ] as any);

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (String(p).includes('research-assistant')) return JSON.stringify(SAMPLE_CONFIG);
      throw new Error(`Unexpected read: ${p}`);
    });

    const presets = loader.listPresets();

    expect(presets).toHaveLength(1);
    expect(presets[0].id).toBe('research-assistant');
  });

  it('should skip directories without agent.config.json', () => {
    const agentsDir = join(TEST_PRESETS_DIR, 'agents');

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === agentsDir) return true;
      // Only the valid preset has a config
      if (String(p).includes('valid-agent') && String(p).endsWith('agent.config.json')) return true;
      return false;
    });

    vi.mocked(readdirSync).mockReturnValue([
      makeDirent('valid-agent', { isDir: true }),
      makeDirent('broken-agent', { isDir: true }),
    ] as any);

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (String(p).includes('valid-agent')) return JSON.stringify(SAMPLE_CONFIG);
      throw new Error(`Unexpected read: ${p}`);
    });

    const presets = loader.listPresets();

    expect(presets).toHaveLength(1);
    expect(presets[0].id).toBe('valid-agent');
  });
});

// ── getPresetPath ───────────────────────────────────────────────────────────

describe('PresetLoader.getPresetPath', () => {
  it('should return correct path', () => {
    const loader = new PresetLoader(TEST_PRESETS_DIR);
    const result = loader.getPresetPath('research-assistant');
    expect(result).toBe(join(TEST_PRESETS_DIR, 'agents', 'research-assistant'));
  });
});

// ── loadTemplate ────────────────────────────────────────────────────────────

describe('PresetLoader.loadTemplate', () => {
  let loader: PresetLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    loader = new PresetLoader(TEST_PRESETS_DIR);
  });

  it('should throw when template file not found', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => loader.loadTemplate('nonexistent')).toThrow(
      /Template config not found/,
    );
  });

  it('should return TemplateConfig with id field', () => {
    const filePath = join(TEST_PRESETS_DIR, 'templates', 'enterprise.json');

    vi.mocked(existsSync).mockImplementation((p) => p === filePath);

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (p === filePath) return JSON.stringify({ securityTier: 'enterprise', maxAgents: 100 });
      throw new Error(`Unexpected read: ${p}`);
    });

    const template = loader.loadTemplate('enterprise');

    expect(template.id).toBe('enterprise');
  });

  it('should parse JSON content correctly', () => {
    const filePath = join(TEST_PRESETS_DIR, 'templates', 'enterprise.json');
    const templateData = {
      securityTier: 'enterprise',
      maxAgents: 100,
      features: ['audit-log', 'sso'],
    };

    vi.mocked(existsSync).mockImplementation((p) => p === filePath);

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (p === filePath) return JSON.stringify(templateData);
      throw new Error(`Unexpected read: ${p}`);
    });

    const template = loader.loadTemplate('enterprise');

    expect(template.id).toBe('enterprise');
    expect(template.securityTier).toBe('enterprise');
    expect(template.maxAgents).toBe(100);
    expect(template.features).toEqual(['audit-log', 'sso']);
  });
});

// ── listTemplates ───────────────────────────────────────────────────────────

describe('PresetLoader.listTemplates', () => {
  let loader: PresetLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    loader = new PresetLoader(TEST_PRESETS_DIR);
  });

  it('should throw when templates directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => loader.listTemplates()).toThrow(
      /Presets templates directory not found/,
    );
  });

  it('should return sorted templates', () => {
    const templatesDir = join(TEST_PRESETS_DIR, 'templates');

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === templatesDir) return true;
      if (String(p).endsWith('.json')) return true;
      return false;
    });

    vi.mocked(readdirSync).mockReturnValue([
      makeDirent('startup.json', { isFile: true }),
      makeDirent('enterprise.json', { isFile: true }),
    ] as any);

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (String(p).includes('enterprise')) return JSON.stringify({ tier: 'enterprise' });
      if (String(p).includes('startup')) return JSON.stringify({ tier: 'startup' });
      throw new Error(`Unexpected read: ${p}`);
    });

    const templates = loader.listTemplates();

    expect(templates).toHaveLength(2);
    // Sorted alphabetically by id
    expect(templates[0].id).toBe('enterprise');
    expect(templates[1].id).toBe('startup');
  });

  it('should skip non-JSON files', () => {
    const templatesDir = join(TEST_PRESETS_DIR, 'templates');

    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === templatesDir) return true;
      if (String(p).endsWith('.json')) return true;
      return false;
    });

    vi.mocked(readdirSync).mockReturnValue([
      makeDirent('README.md', { isFile: true }),
      makeDirent('.gitkeep', { isFile: true }),
      makeDirent('enterprise.json', { isFile: true }),
    ] as any);

    vi.mocked(readFileSync).mockImplementation((p, _encoding) => {
      if (String(p).includes('enterprise')) return JSON.stringify({ tier: 'enterprise' });
      throw new Error(`Unexpected read: ${p}`);
    });

    const templates = loader.listTemplates();

    expect(templates).toHaveLength(1);
    expect(templates[0].id).toBe('enterprise');
  });
});
