import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesystemState: {
  prompt: string;
  entries: Array<{
    skill?: { name?: string; description?: string; content?: string };
    frontmatter?: Record<string, unknown>;
  }>;
} = {
  prompt: '',
  entries: [],
};

const resolveSkillsByNames = vi.fn();
const loadSkillsByNames = vi.fn();
const getSkillEntries = vi.fn();

vi.mock('../../skills/index.js', () => ({
  SkillRegistry: class MockSkillRegistry {
    async loadFromDirs(): Promise<number> {
      return filesystemState.entries.length;
    }

    buildSnapshot(): { prompt: string } {
      return { prompt: filesystemState.prompt };
    }

    listAll(): typeof filesystemState.entries {
      return filesystemState.entries;
    }
  },
}));

vi.mock('../PresetSkillResolver.js', () => ({
  resolveSkillsByNames,
}));

vi.mock('@framers/agentos-skills-registry/catalog', () => ({
  loadSkillsByNames,
  getSkillEntries,
}));

import { resolveSkillContext } from '../resolve-skill-context.js';

describe('resolveSkillContext', () => {
  beforeEach(() => {
    filesystemState.prompt = '';
    filesystemState.entries = [];
    resolveSkillsByNames.mockReset();
    loadSkillsByNames.mockReset();
    getSkillEntries.mockReset();
  });

  it('hydrates curated discovery entries with real loaded skill content', async () => {
    resolveSkillsByNames.mockResolvedValue({
      prompt: '# Curated Skills\n\nGitHub skill prompt',
      skills: [{ name: 'github', primaryEnv: 'GITHUB_TOKEN' }],
    });
    loadSkillsByNames.mockResolvedValue([
      {
        name: 'github',
        description: 'Manage GitHub workflows.',
        content: 'Use gh for issues and PRs.',
        frontmatter: {
          category: 'developer-tools',
          tags: ['github', 'git'],
          requires_secrets: ['github.token'],
          requires_tools: ['filesystem'],
        },
      },
    ]);

    const result = await resolveSkillContext({
      curatedSkills: ['github'],
      warningPrefix: '[test]',
    });

    expect(resolveSkillsByNames).toHaveBeenCalledWith(['github']);
    expect(loadSkillsByNames).toHaveBeenCalledWith(['github']);
    expect(result.skillsPrompt).toContain('GitHub skill prompt');
    expect(result.skillEntries).toEqual([
      {
        name: 'github',
        description: 'Manage GitHub workflows.',
        content: 'Use gh for issues and PRs.',
        category: 'developer-tools',
        tags: ['github', 'git'],
        requiredSecrets: ['github.token'],
        requiredTools: ['filesystem'],
      },
    ]);
    expect(result.skillNames).toEqual(['github']);
  });

  it('keeps filesystem skill content when a curated skill has the same name', async () => {
    filesystemState.prompt = '# Filesystem Skills\n\nLocal github helper';
    filesystemState.entries = [
      {
        skill: {
          name: 'github',
          description: 'Local GitHub helper.',
          content: 'Local skill body.',
        },
        frontmatter: {
          category: 'workspace',
          tags: ['local'],
        },
      },
    ];
    resolveSkillsByNames.mockResolvedValue({
      prompt: '# Curated Skills\n\nCurated github helper',
      skills: [{ name: 'github' }],
    });
    loadSkillsByNames.mockResolvedValue([
      {
        name: 'github',
        description: 'Curated GitHub helper.',
        content: 'Curated skill body.',
        frontmatter: {
          category: 'developer-tools',
          tags: ['github'],
        },
      },
    ]);

    const result = await resolveSkillContext({
      filesystemDirs: ['/tmp/skills'],
      curatedSkills: ['github'],
      warningPrefix: '[test]',
    });

    expect(result.skillsPrompt).toContain('Local github helper');
    expect(result.skillsPrompt).toContain('Curated github helper');
    expect(result.skillEntries).toEqual([
      {
        name: 'github',
        description: 'Local GitHub helper.',
        content: 'Local skill body.',
        category: 'workspace',
        tags: ['local'],
        requiredSecrets: undefined,
        requiredTools: undefined,
      },
    ]);
    expect(result.skillNames).toEqual(['github']);
  });
});
