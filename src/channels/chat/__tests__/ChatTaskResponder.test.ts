// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatTaskResponder } from '../ChatTaskResponder.js';
import type { ChannelContext } from '../types.js';

function makeCtx(overrides?: Partial<ChannelContext>): ChannelContext {
  return {
    platform: 'telegram',
    chatId: 'test-chat-' + Date.now(),
    userId: '123',
    sendFileFn: vi.fn(),
    replyFn: vi.fn(),
    ...overrides,
  };
}

describe('ChatTaskResponder', () => {
  it('blocks unauthorized users', async () => {
    const replyFn = vi.fn();
    const responder = new ChatTaskResponder({
      securityTier: 'strict',
      allowedUsers: ['999'],
      conversationHistoryLimit: 10,
      dbPath: join(tmpdir(), `resp-test-${Date.now()}-1.db`),
    });
    await responder.handle('hello', makeCtx({ userId: '123', replyFn }));
    expect(replyFn).toHaveBeenCalledWith(expect.stringContaining('authorized'));
    responder.close();
  });

  it('allows authorized users and calls LLM', async () => {
    const replyFn = vi.fn();
    const llmCallFn = vi.fn().mockResolvedValue('I found the file!');
    const responder = new ChatTaskResponder({
      securityTier: 'permissive',
      allowedUsers: ['123'],
      conversationHistoryLimit: 10,
      dbPath: join(tmpdir(), `resp-test-${Date.now()}-2.db`),
      llmCallFn,
    });
    const result = await responder.handle('find pic.png', makeCtx({ userId: '123', replyFn }));
    expect(result).toBe('I found the file!');
    expect(replyFn).toHaveBeenCalledWith('I found the file!');
    expect(llmCallFn).toHaveBeenCalledTimes(1);
    responder.close();
  });

  it('allows all users when allowedUsers is empty', async () => {
    const replyFn = vi.fn();
    const llmCallFn = vi.fn().mockResolvedValue('ok');
    const responder = new ChatTaskResponder({
      securityTier: 'balanced',
      allowedUsers: [],
      conversationHistoryLimit: 10,
      dbPath: join(tmpdir(), `resp-test-${Date.now()}-3.db`),
      llmCallFn,
    });
    await responder.handle('hello', makeCtx({ userId: 'anyone', replyFn }));
    expect(llmCallFn).toHaveBeenCalledTimes(1);
    responder.close();
  });

  it('returns correct tool allowlist per tier', () => {
    const strict = new ChatTaskResponder({
      securityTier: 'strict',
      allowedUsers: [],
      conversationHistoryLimit: 10,
    });
    expect(strict.getToolAllowlist()).toContain('web_search');
    expect(strict.getToolAllowlist()).not.toContain('cli_executor');

    const balanced = new ChatTaskResponder({
      securityTier: 'balanced',
      allowedUsers: [],
      conversationHistoryLimit: 10,
    });
    expect(balanced.getToolAllowlist()).toContain('local_file_search');
    expect(balanced.getToolAllowlist()).toContain('zip_files');
    expect(balanced.getToolAllowlist()).not.toContain('cli_executor');

    const permissive = new ChatTaskResponder({
      securityTier: 'permissive',
      allowedUsers: [],
      conversationHistoryLimit: 10,
    });
    expect(permissive.getToolAllowlist()).toBeNull();

    strict.close();
    balanced.close();
    permissive.close();
  });

  it('handles LLM errors gracefully', async () => {
    const replyFn = vi.fn();
    const llmCallFn = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const responder = new ChatTaskResponder({
      securityTier: 'permissive',
      allowedUsers: [],
      conversationHistoryLimit: 10,
      dbPath: join(tmpdir(), `resp-test-${Date.now()}-4.db`),
      llmCallFn,
    });
    const result = await responder.handle('do something', makeCtx({ replyFn }));
    expect(result).toContain('Something went wrong');
    expect(replyFn).toHaveBeenCalledWith(expect.stringContaining('Something went wrong'));
    responder.close();
  });

  it('persists conversation across calls', async () => {
    const dbPath = join(tmpdir(), `resp-test-${Date.now()}-5.db`);
    const chatId = 'persist-test';
    let callCount = 0;
    const llmCallFn = vi.fn().mockImplementation((msgs) => {
      callCount++;
      return Promise.resolve(`Response ${callCount} (history: ${msgs.length} messages)`);
    });

    const responder = new ChatTaskResponder({
      securityTier: 'permissive',
      allowedUsers: [],
      conversationHistoryLimit: 50,
      dbPath,
      llmCallFn,
    });

    await responder.handle('first message', makeCtx({ chatId, replyFn: vi.fn() }));
    await responder.handle('second message', makeCtx({ chatId, replyFn: vi.fn() }));

    // Second call should have 3 messages in history (user1, assistant1, user2)
    const secondCallArgs = llmCallFn.mock.calls[1][0];
    expect(secondCallArgs.length).toBe(3);
    expect(secondCallArgs[0].content).toBe('first message');
    expect(secondCallArgs[1].content).toContain('Response 1');
    expect(secondCallArgs[2].content).toBe('second message');

    responder.close();
  });
});
