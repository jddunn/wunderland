/**
 * @fileoverview Unit tests for Skills Registry module
 * @module wunderland/skills/__tests__
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    SkillRegistry,
    parseSkillFrontmatter,
    extractMetadata,
    loadSkillFromDir,
    loadSkillsFromDir,
    filterByPlatform,
    filterByEligibility,
    checkBinaryRequirements,
} from '../skills/index.js';
import type { SkillEntry, SkillEligibilityContext } from '../skills/index.js';

// Mock fs for testing
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        promises: {
            readFile: vi.fn(),
            readdir: vi.fn(),
            stat: vi.fn(),
        },
    };
});

describe('parseSkillFrontmatter', () => {
    it('should parse valid YAML frontmatter', () => {
        const content = `---
name: test-skill
description: "A test skill"
---

# Test Skill

This is the body.`;

        const { frontmatter, body } = parseSkillFrontmatter(content);

        expect(frontmatter.name).toBe('test-skill');
        expect(frontmatter.description).toBe('A test skill');
        expect(body).toContain('# Test Skill');
        expect(body).toContain('This is the body.');
    });

    it('should handle content without frontmatter', () => {
        const content = `# No Frontmatter

Just content.`;

        const { frontmatter, body } = parseSkillFrontmatter(content);

        expect(Object.keys(frontmatter)).toHaveLength(0);
        expect(body).toBe(content);
    });

    it('should handle empty frontmatter', () => {
        const content = `---
---

Body content.`;

        const { frontmatter, body } = parseSkillFrontmatter(content);

        expect(Object.keys(frontmatter)).toHaveLength(0);
        expect(body).toBe('Body content.');
    });

    it('should parse nested metadata objects', () => {
        const content = `---
name: github
description: "GitHub skill"
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"] }
      }
  }
---

# GitHub`;

        const { frontmatter } = parseSkillFrontmatter(content);

        expect(frontmatter.name).toBe('github');
        const metadata = frontmatter.metadata as Record<string, unknown>;
        expect(metadata).toBeDefined();
    });
});

describe('extractMetadata', () => {
    it('should extract metadata from openclaw namespace', () => {
        const frontmatter = {
            metadata: {
                openclaw: {
                    emoji: '🐙',
                    requires: { bins: ['gh'] },
                },
            },
        };

        const metadata = extractMetadata(frontmatter);

        expect(metadata?.emoji).toBe('🐙');
        expect(metadata?.requires?.bins).toEqual(['gh']);
    });

    it('should extract metadata from wunderland namespace', () => {
        const frontmatter = {
            metadata: {
                wunderland: {
                    emoji: '🎩',
                    always: true,
                },
            },
        };

        const metadata = extractMetadata(frontmatter);

        expect(metadata?.emoji).toBe('🎩');
        expect(metadata?.always).toBe(true);
    });

    it('should handle empty frontmatter gracefully', () => {
        const metadata = extractMetadata({});

        // Returns partial object with default values
        expect(metadata).toBeDefined();
        expect(metadata?.always).toBe(false);
    });
});

describe('filterByPlatform', () => {
    const createEntry = (os?: string[]): SkillEntry => ({
        skill: { name: 'test', description: 'test', content: '' },
        frontmatter: {},
        metadata: os ? { os } : undefined,
    });

    it('should pass entries without OS restrictions', () => {
        const entries = [createEntry()];

        const filtered = filterByPlatform(entries, 'darwin');

        expect(filtered).toHaveLength(1);
    });

    it('should filter by darwin/macos', () => {
        const entries = [
            createEntry(['darwin']),
            createEntry(['linux']),
            createEntry(['macos']),
        ];

        const filtered = filterByPlatform(entries, 'darwin');

        expect(filtered).toHaveLength(2); // darwin and macos
    });

    it('should filter by linux', () => {
        const entries = [
            createEntry(['darwin']),
            createEntry(['linux']),
        ];

        const filtered = filterByPlatform(entries, 'linux');

        expect(filtered).toHaveLength(1);
        expect(filtered[0].skill.name).toBe('test');
    });

    it('should normalize windows platform names', () => {
        const entries = [
            createEntry(['win32']),
            createEntry(['windows']),
        ];

        const filtered = filterByPlatform(entries, 'win32');

        expect(filtered).toHaveLength(2);
    });
});

describe('filterByEligibility', () => {
    const createEntry = (requires?: { bins?: string[]; anyBins?: string[] }): SkillEntry => ({
        skill: { name: 'test', description: 'test', content: '' },
        frontmatter: {},
        metadata: requires ? { requires } : undefined,
    });

    it('should pass entries without requirements', () => {
        const entries = [createEntry()];
        const context: SkillEligibilityContext = {
            platforms: ['darwin'],
            hasBin: () => false,
            hasAnyBin: () => false,
        };

        const filtered = filterByEligibility(entries, context);

        expect(filtered).toHaveLength(1);
    });

    it('should filter by required bins', () => {
        const entries = [
            createEntry({ bins: ['gh'] }),
            createEntry({ bins: ['missing-bin'] }),
        ];
        const context: SkillEligibilityContext = {
            platforms: ['darwin'],
            hasBin: (bin) => bin === 'gh',
            hasAnyBin: () => false,
        };

        const filtered = filterByEligibility(entries, context);

        expect(filtered).toHaveLength(1);
    });

    it('should filter by anyBins', () => {
        const entries = [
            createEntry({ anyBins: ['curl', 'wget'] }),
        ];
        const context: SkillEligibilityContext = {
            platforms: ['darwin'],
            hasBin: () => false,
            hasAnyBin: (bins) => bins.includes('curl'),
        };

        const filtered = filterByEligibility(entries, context);

        expect(filtered).toHaveLength(1);
    });
});

describe('checkBinaryRequirements', () => {
    it('should return met=true when all bins available', () => {
        const entry: SkillEntry = {
            skill: { name: 'test', description: 'test', content: '' },
            frontmatter: {},
            metadata: { requires: { bins: ['gh', 'git'] } },
        };

        const result = checkBinaryRequirements(entry, () => true);

        expect(result.met).toBe(true);
        expect(result.missing).toHaveLength(0);
    });

    it('should return missing bins', () => {
        const entry: SkillEntry = {
            skill: { name: 'test', description: 'test', content: '' },
            frontmatter: {},
            metadata: { requires: { bins: ['gh', 'missing'] } },
        };

        const result = checkBinaryRequirements(entry, (bin) => bin === 'gh');

        expect(result.met).toBe(false);
        expect(result.missing).toEqual(['missing']);
    });

    it('should handle entries without requirements', () => {
        const entry: SkillEntry = {
            skill: { name: 'test', description: 'test', content: '' },
            frontmatter: {},
        };

        const result = checkBinaryRequirements(entry, () => false);

        expect(result.met).toBe(true);
        expect(result.missing).toHaveLength(0);
    });
});

describe('SkillRegistry', () => {
    let registry: SkillRegistry;

    const createEntry = (name: string): SkillEntry => ({
        skill: { name, description: `${name} skill`, content: `# ${name}` },
        frontmatter: { name },
        metadata: { emoji: '📦' },
        invocation: { userInvocable: true, disableModelInvocation: false },
    });

    beforeEach(() => {
        registry = new SkillRegistry();
    });

    describe('register/unregister', () => {
        it('should register a skill', () => {
            const entry = createEntry('test');

            const registered = registry.register(entry);

            expect(registered).toBe(true);
            expect(registry.size).toBe(1);
        });

        it('should not register duplicate', () => {
            const entry = createEntry('test');

            registry.register(entry);
            const second = registry.register(entry);

            expect(second).toBe(false);
            expect(registry.size).toBe(1);
        });

        it('should unregister a skill', () => {
            const entry = createEntry('test');
            registry.register(entry);

            const removed = registry.unregister('test');

            expect(removed).toBe(true);
            expect(registry.size).toBe(0);
        });

        it('should return false for unknown skill', () => {
            const removed = registry.unregister('unknown');

            expect(removed).toBe(false);
        });
    });

    describe('queries', () => {
        beforeEach(() => {
            registry.register(createEntry('skill-a'));
            registry.register(createEntry('skill-b'));
            registry.register(createEntry('skill-c'));
        });

        it('should get by name', () => {
            const entry = registry.getByName('skill-b');

            expect(entry?.skill.name).toBe('skill-b');
        });

        it('should return undefined for unknown name', () => {
            const entry = registry.getByName('unknown');

            expect(entry).toBeUndefined();
        });

        it('should list all', () => {
            const all = registry.listAll();

            expect(all).toHaveLength(3);
        });

        it('should check has', () => {
            expect(registry.has('skill-a')).toBe(true);
            expect(registry.has('unknown')).toBe(false);
        });
    });

    describe('buildSnapshot', () => {
        beforeEach(() => {
            registry.register(createEntry('skill-a'));
            registry.register(createEntry('skill-b'));
        });

        it('should build snapshot with all skills', () => {
            const snapshot = registry.buildSnapshot();

            expect(snapshot.skills).toHaveLength(2);
            expect(snapshot.prompt).toContain('skill-a');
            expect(snapshot.prompt).toContain('skill-b');
            expect(snapshot.version).toBeDefined();
            expect(snapshot.createdAt).toBeInstanceOf(Date);
        });

        it('should filter by name', () => {
            const snapshot = registry.buildSnapshot({ filter: ['skill-a'] });

            expect(snapshot.skills).toHaveLength(1);
            expect(snapshot.skills[0].name).toBe('skill-a');
        });
    });

    describe('buildPrompt', () => {
        it('should format skills as markdown', () => {
            registry.register(createEntry('github'));
            registry.register(createEntry('slack'));

            const entries = registry.listAll();
            const prompt = registry.buildPrompt(entries);

            expect(prompt).toContain('# Available Skills');
            expect(prompt).toContain('## 📦 github');
            expect(prompt).toContain('## 📦 slack');
        });

        it('should return empty string for no skills', () => {
            const prompt = registry.buildPrompt([]);

            expect(prompt).toBe('');
        });
    });

    describe('buildCommandSpecs', () => {
        beforeEach(() => {
            registry.register(createEntry('github'));
            registry.register(createEntry('slack'));
        });

        it('should generate command specs', () => {
            const specs = registry.buildCommandSpecs();

            expect(specs).toHaveLength(2);
            expect(specs.map((s) => s.name)).toContain('github');
            expect(specs.map((s) => s.name)).toContain('slack');
        });

        it('should avoid reserved names', () => {
            const specs = registry.buildCommandSpecs({
                reservedNames: new Set(['github']),
            });

            expect(specs.map((s) => s.name)).toContain('github-2');
            expect(specs.map((s) => s.name)).toContain('slack');
        });
    });

    describe('clear', () => {
        it('should clear all skills', () => {
            registry.register(createEntry('a'));
            registry.register(createEntry('b'));

            registry.clear();

            expect(registry.size).toBe(0);
        });
    });
});
