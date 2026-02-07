/**
 * @fileoverview Tests for PresetSkillResolver — resolves preset skill suggestions into SkillSnapshots.
 * @module wunderland/core/__tests__/PresetSkillResolver.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../PresetLoader.js', () => ({
  PresetLoader: vi.fn().mockImplementation(() => ({
    loadPreset: vi.fn().mockReturnValue({
      id: 'research-assistant',
      name: 'Research Assistant',
      description: 'An agent for research tasks',
      hexacoTraits: {
        honesty: 0.8,
        emotionality: 0.4,
        extraversion: 0.5,
        agreeableness: 0.7,
        conscientiousness: 0.9,
        openness: 0.9,
      },
      securityTier: 'standard',
      suggestedSkills: ['summarize', 'github'],
      suggestedChannels: [],
      persona: '# Research Assistant Persona',
    }),
  })),
}));

vi.mock('@framers/agentos-skills-registry/catalog', () => ({
  getSkillByName: vi.fn((name: string) => {
    const known = ['summarize', 'github', 'weather', 'coding-agent'];
    return known.includes(name) ? { name, category: 'test' } : undefined;
  }),
}));

vi.mock('@framers/agentos-skills-registry', () => ({
  createCuratedSkillSnapshot: vi.fn(async (opts: { skills: string[] }) => ({
    prompt: opts.skills.map((s) => `# ${s}`).join('\n'),
    skills: opts.skills.map((s) => ({ name: s })),
    resolvedSkills: [],
    version: 1,
    createdAt: new Date(),
  })),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { resolveSkillsByNames, resolvePresetSkills } from '../PresetSkillResolver.js';
import { PresetLoader } from '../PresetLoader.js';
import { getSkillByName } from '@framers/agentos-skills-registry/catalog';
import { createCuratedSkillSnapshot } from '@framers/agentos-skills-registry';

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// resolveSkillsByNames
// ============================================================================

describe('resolveSkillsByNames', () => {
  it('should return an empty snapshot for an empty array', async () => {
    const snapshot = await resolveSkillsByNames([]);

    expect(snapshot.prompt).toBe('');
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.resolvedSkills).toEqual([]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.createdAt).toBeInstanceOf(Date);

    // Should not interact with registry at all
    expect(getSkillByName).not.toHaveBeenCalled();
    expect(createCuratedSkillSnapshot).not.toHaveBeenCalled();
  });

  it('should resolve valid skill names into a snapshot', async () => {
    const snapshot = await resolveSkillsByNames(['summarize', 'github']);

    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'summarize' }),
        expect.objectContaining({ name: 'github' }),
      ]),
    );
    expect(snapshot.prompt).toContain('# summarize');
    expect(snapshot.prompt).toContain('# github');
    expect(snapshot.version).toBe(1);
    expect(snapshot.createdAt).toBeInstanceOf(Date);

    expect(getSkillByName).toHaveBeenCalledTimes(2);
    expect(getSkillByName).toHaveBeenCalledWith('summarize');
    expect(getSkillByName).toHaveBeenCalledWith('github');
    expect(createCuratedSkillSnapshot).toHaveBeenCalledWith({
      skills: ['summarize', 'github'],
    });
  });

  it('should filter out unknown skill names and emit console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await resolveSkillsByNames(['summarize', 'nonexistent']);

    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0].name).toBe('summarize');

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown skill "nonexistent"'),
    );

    // Only valid skills passed to createCuratedSkillSnapshot
    expect(createCuratedSkillSnapshot).toHaveBeenCalledWith({
      skills: ['summarize'],
    });

    warnSpy.mockRestore();
  });

  it('should return an empty snapshot when all names are unknown', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await resolveSkillsByNames(['bogus', 'fake-skill', 'nope']);

    expect(snapshot.prompt).toBe('');
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.resolvedSkills).toEqual([]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.createdAt).toBeInstanceOf(Date);

    // Should warn for each unknown skill
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"bogus"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"fake-skill"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"nope"'));

    // Should NOT call createCuratedSkillSnapshot since no valid skills remain
    expect(createCuratedSkillSnapshot).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('should handle a mix of valid and invalid skill names', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await resolveSkillsByNames([
      'weather',
      'invalid-one',
      'coding-agent',
      'invalid-two',
    ]);

    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'weather' }),
        expect.objectContaining({ name: 'coding-agent' }),
      ]),
    );

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"invalid-one"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"invalid-two"'));

    expect(createCuratedSkillSnapshot).toHaveBeenCalledWith({
      skills: ['weather', 'coding-agent'],
    });

    warnSpy.mockRestore();
  });

  it('should return a snapshot with prompt containing skill content', async () => {
    const snapshot = await resolveSkillsByNames(['summarize', 'weather', 'github']);

    // The mock builds prompt as "# <name>" joined by newlines
    expect(snapshot.prompt).toBe('# summarize\n# weather\n# github');
    expect(snapshot.prompt).toContain('# summarize');
    expect(snapshot.prompt).toContain('# weather');
    expect(snapshot.prompt).toContain('# github');
  });

  it('should return an empty snapshot gracefully when registry import fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Make the catalog mock throw once to simulate a missing optional peer dependency.
    // Using mockImplementationOnce so the original mock factory is restored for subsequent tests.
    vi.mocked(getSkillByName).mockImplementationOnce(() => {
      throw new Error('Cannot find module @framers/agentos-skills-registry/catalog');
    });

    const snapshot = await resolveSkillsByNames(['summarize', 'github']);

    expect(snapshot.prompt).toBe('');
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.resolvedSkills).toEqual([]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.createdAt).toBeInstanceOf(Date);

    expect(warnSpy).toHaveBeenCalledWith(
      '[skills] Could not resolve curated skills:',
      expect.stringContaining('Cannot find module'),
    );

    warnSpy.mockRestore();
  });
});

// ============================================================================
// resolvePresetSkills
// ============================================================================

describe('resolvePresetSkills', () => {
  it('should load a preset and resolve its suggestedSkills', async () => {
    const snapshot = await resolvePresetSkills('research-assistant');

    // Should have constructed PresetLoader
    expect(PresetLoader).toHaveBeenCalledOnce();

    // Should have resolved the two suggested skills from the mock preset
    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'summarize' }),
        expect.objectContaining({ name: 'github' }),
      ]),
    );
    expect(snapshot.prompt).toContain('# summarize');
    expect(snapshot.prompt).toContain('# github');
  });

  it('should pass the preset suggestedSkills to resolveSkillsByNames', async () => {
    await resolvePresetSkills('research-assistant');

    // Verify loadPreset was called with the preset ID
    const loaderInstance = vi.mocked(PresetLoader).mock.results[0].value;
    expect(loaderInstance.loadPreset).toHaveBeenCalledWith('research-assistant');

    // Verify the skills from the preset were looked up in the catalog
    expect(getSkillByName).toHaveBeenCalledWith('summarize');
    expect(getSkillByName).toHaveBeenCalledWith('github');

    // Verify createCuratedSkillSnapshot received the valid skills
    expect(createCuratedSkillSnapshot).toHaveBeenCalledWith({
      skills: ['summarize', 'github'],
    });
  });

  it('should propagate errors from PresetLoader', async () => {
    // Override the mock to make loadPreset throw
    vi.mocked(PresetLoader).mockImplementationOnce(() => ({
      loadPreset: vi.fn().mockImplementation(() => {
        throw new Error(
          'Agent preset config not found: research-assistant. ' +
            'Ensure the "research-assistant" preset directory contains an agent.config.json file.',
        );
      }),
    }));

    await expect(resolvePresetSkills('nonexistent-preset')).rejects.toThrow(
      'Agent preset config not found',
    );

    // createCuratedSkillSnapshot should never be called since loadPreset threw
    expect(createCuratedSkillSnapshot).not.toHaveBeenCalled();
  });
});
