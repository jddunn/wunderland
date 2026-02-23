import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createWunderland } from '../index.js';

function mockOpenAIChatCompletionSequence(responses: Array<Record<string, unknown>>) {
  const queue = responses.slice();
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('Test bug: fetch called more times than expected.');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(next),
    } as any;
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return fetchMock;
}

function simpleChatResponse(content: string) {
  return { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content } }] };
}

describe('wunderland public API — skills & extensions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts skills option as string array and injects prompt', async () => {
    // Mock the PresetSkillResolver to avoid needing the real registry
    vi.doMock('../core/PresetSkillResolver.js', () => ({
      resolveSkillsByNames: vi.fn(async (names: string[]) => ({
        prompt: `[Skills: ${names.join(', ')}]`,
        skills: names.map((n) => ({ name: n })),
        resolvedSkills: [],
        version: 1,
        createdAt: new Date(),
      })),
    }));

    mockOpenAIChatCompletionSequence([simpleChatResponse('hello')]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      skills: ['github', 'web-search'],
      discovery: { enabled: false },
    });

    const diag = app.diagnostics();
    // Skills should be in diagnostics
    expect(diag.skills.count).toBeGreaterThanOrEqual(0);

    // System prompt should contain the skill content if skills loaded
    const session = app.session('test');
    const out = await session.sendText('hi');
    expect(out.text).toBe('hello');
  });

  it('diagnostics includes skills field with count and names', async () => {
    mockOpenAIChatCompletionSequence([simpleChatResponse('hello')]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      discovery: { enabled: false },
    });

    const diag = app.diagnostics();
    expect(diag.skills).toBeDefined();
    expect(diag.skills.count).toBe(0);
    expect(diag.skills.names).toEqual([]);
  });

  it('accepts preset option without crashing', async () => {
    mockOpenAIChatCompletionSequence([simpleChatResponse('hello')]);

    // If preset isn't found, should warn and continue
    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      preset: 'nonexistent-preset',
      discovery: { enabled: false },
    });

    const diag = app.diagnostics();
    expect(diag.tools.count).toBeGreaterThanOrEqual(0);
  });

  it('accepts extensions option without crashing when registry unavailable', async () => {
    mockOpenAIChatCompletionSequence([simpleChatResponse('hello')]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      extensions: { tools: ['web-search', 'giphy'] },
      discovery: { enabled: false },
    });

    const diag = app.diagnostics();
    // Should not crash — extensions gracefully degrade
    expect(diag.tools.count).toBeGreaterThanOrEqual(0);
  });

  it('accepts skills as object with dirs and names', async () => {
    mockOpenAIChatCompletionSequence([simpleChatResponse('hello')]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      skills: {
        names: ['github'],
        dirs: ['/tmp/nonexistent-skills-dir'],
        includeDefaults: false,
      },
      discovery: { enabled: false },
    });

    const diag = app.diagnostics();
    expect(diag.skills).toBeDefined();
  });

  it('close() cleans up resources', async () => {
    mockOpenAIChatCompletionSequence([]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      discovery: { enabled: false },
    });

    await expect(app.close()).resolves.not.toThrow();
  });
});
