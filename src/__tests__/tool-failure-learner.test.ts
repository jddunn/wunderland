// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';

import { ToolFailureLearner } from '../runtime-new/tools/tool-failure-learner.js';

describe('ToolFailureLearner', () => {
  it('keeps distinct failure patterns for the same tool', async () => {
    const pipeline = {
      initialize: vi.fn(),
      processConversationTurn: vi.fn().mockResolvedValue({
        factsExtracted: 0,
        factsStored: 0,
        factsSkipped: 0,
      }),
    };
    const learner = new ToolFailureLearner({
      autoIngestPipeline: pipeline as any,
      conversationId: 'conv-1',
    });

    learner.recordFailure({
      toolName: 'browser_navigate',
      args: { url: 'https://www.ebay.com' },
      error: '403 blocked by cloudflare',
      timestamp: new Date().toISOString(),
    });
    learner.recordFailure({
      toolName: 'browser_navigate',
      args: { url: 'https://www.ebay.com' },
      error: 'returned empty content',
      timestamp: new Date().toISOString(),
    });

    await expect(learner.flush()).resolves.toBe(2);
    expect(pipeline.processConversationTurn).toHaveBeenCalledWith(
      'conv-1',
      '[System: Recording tool usage lessons for future reference]',
      expect.stringContaining('blocks headless browsers'),
    );
    expect(
      vi.mocked(pipeline.processConversationTurn).mock.calls[0]?.[2],
    ).toContain('returned empty content');
  });

  it('retries queued lessons after a flush failure instead of dropping them', async () => {
    const failingPipeline = {
      initialize: vi.fn(),
      processConversationTurn: vi.fn().mockRejectedValue(new Error('embedding unavailable')),
    };
    const workingPipeline = {
      initialize: vi.fn(),
      processConversationTurn: vi.fn().mockResolvedValue({
        factsExtracted: 0,
        factsStored: 0,
        factsSkipped: 0,
      }),
    };
    const learner = new ToolFailureLearner({
      autoIngestPipeline: failingPipeline as any,
      conversationId: 'conv-2',
    });

    learner.recordFailure({
      toolName: 'browser_navigate',
      args: { url: 'https://www.amazon.com' },
      error: 'captcha page returned',
      timestamp: new Date().toISOString(),
    });

    await expect(learner.flush()).resolves.toBe(0);
    learner.setPipeline(workingPipeline as any);
    await expect(learner.flush()).resolves.toBe(1);
    expect(workingPipeline.processConversationTurn).toHaveBeenCalledTimes(1);
  });
});
