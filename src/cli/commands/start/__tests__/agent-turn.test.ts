import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tool-calling core so we assert what runAgentTurn assembles + how it
// gates tools, without invoking a real LLM.
const runToolCallingTurn = vi.fn();
vi.mock('../../../../runtime/tools/tool-calling.js', () => ({
  runToolCallingTurn: (opts: any) => runToolCallingTurn(opts),
  buildToolDefs: () => [],
  safeJsonStringify: (v: unknown) => JSON.stringify(v),
}));

import { runAgentTurn } from '../agent-turn.js';

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    seedId: 'seed-1',
    activePersonaId: 'default',
    providerId: 'openai',
    llmApiKey: 'k',
    model: 'gpt-x',
    systemPrompt: 'SYS',
    toolMap: new Map(),
    canUseLLM: true,
    dangerouslySkipPermissions: false,
    autoApproveToolCalls: false,
    sessions: new Map<string, Array<Record<string, unknown>>>(),
    broadcastAgentEvent: vi.fn(),
    ...over,
  } as any;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('runAgentTurn', () => {
  beforeEach(() => {
    runToolCallingTurn.mockReset();
    runToolCallingTurn.mockResolvedValue('the reply');
  });

  it('assembles a persona-suffixed session, appends the user message, and calls the turn core', async () => {
    const deps = makeDeps();
    const result = await runAgentTurn(deps, {
      sessionId: 'webhook:gh',
      message: 'hello from webhook',
      source: 'webhook:gh',
    });

    expect(result.reply).toBe('the reply');
    expect(runToolCallingTurn).toHaveBeenCalledOnce();
    const opts = runToolCallingTurn.mock.calls[0][0];
    // system prompt seeded + user message appended
    expect(opts.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(opts.messages.at(-1)).toEqual({ role: 'user', content: 'hello from webhook' });

    // persisted under the persona-suffixed key the /chat reader uses
    const key = 'webhook:gh::persona:default';
    expect(deps.sessions.has(key)).toBe(true);
  });

  it('autonomous approval: read-only tools approved, side-effect tools denied (no hang, no silent side effects)', async () => {
    const deps = makeDeps();
    await runAgentTurn(deps, { sessionId: 's', message: 'm', source: 'cron:1' });
    const ask = runToolCallingTurn.mock.calls[0][0].askPermission;

    await expect(ask({ name: 'read', hasSideEffects: false }, {})).resolves.toBe(true);
    await expect(ask({ name: 'write', hasSideEffects: true }, {})).resolves.toBe(false);
  });

  it('dangerouslySkipPermissions / autoApprove lets side-effect tools run', async () => {
    for (const flag of ['dangerouslySkipPermissions', 'autoApproveToolCalls']) {
      const deps = makeDeps({ [flag]: true });
      await runAgentTurn(deps, { sessionId: 's', message: 'm', source: 'cron:1' });
      const ask = runToolCallingTurn.mock.calls.at(-1)![0].askPermission;
      await expect(ask({ name: 'write', hasSideEffects: true }, {})).resolves.toBe(true);
    }
  });

  it('serializes concurrent turns on the same session (no lost history)', async () => {
    const deps = makeDeps();
    let active = 0;
    let maxConcurrent = 0;
    runToolCallingTurn.mockImplementation(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await tick(20);
      active -= 1;
      return 'r';
    });

    await Promise.all([
      runAgentTurn(deps, { sessionId: 's', message: 'a', source: 'x' }),
      runAgentTurn(deps, { sessionId: 's', message: 'b', source: 'x' }),
    ]);

    expect(maxConcurrent).toBe(1);
    // both user messages present in order, single system seed
    const msgs = deps.sessions.get('s::persona:default')!;
    const userTexts = msgs.filter((m: any) => m.role === 'user').map((m: any) => m.content);
    expect(userTexts).toEqual(['a', 'b']);
  });

  it('failed turn is reported, not thrown', async () => {
    const deps = makeDeps();
    runToolCallingTurn.mockRejectedValue(new Error('llm down'));
    const result = await runAgentTurn(deps, { sessionId: 's', message: 'm', source: 'x' });
    expect(result.failed).toBe(true);
    expect(result.reply).toBe('');
  });
});
