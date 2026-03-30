import { afterEach, describe, expect, it, vi } from 'vitest';

import cmdCompletions from '../commands/completions.js';

describe('CLI completions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes HITL flags in generated bash completions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdCompletions(['bash'], {}, {} as any);

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('--llm-judge');
    expect(output).toContain('--no-guardrail-override');
  });
});
