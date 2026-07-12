import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatTaskResponder } from '../ChatTaskResponder.js';
import type { GroupPolicy } from '@framers/agentos';

const responders: ChatTaskResponder[] = [];

function makeResponder(groupPolicy?: GroupPolicy): ChatTaskResponder {
  const responder = new ChatTaskResponder({
    securityTier: 'standard',
    allowedUsers: [],
    conversationHistoryLimit: 10,
    dbPath: ':memory:',
    groupPolicy,
    llmCallFn: async () => 'assistant reply',
  } as never);
  responders.push(responder);
  return responder;
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    platform: 'discord',
    chatId: 'g-1',
    userId: 'u1',
    sendFileFn: vi.fn(async () => undefined),
    replyFn: vi.fn(async () => undefined),
    ...over,
  } as never;
}

afterEach(() => {
  for (const responder of responders.splice(0)) responder.close();
});

describe('ChatTaskResponder group policy', () => {
  it('drops unmentioned group messages under mention activation, without replying', async () => {
    const responder = makeResponder({ activation: 'mention' });
    const context = ctx({
      group: { isGroup: true, supportsMentions: true, mentions: [], botUserId: 'me' },
    });

    const result = await responder.handle('hello', context);

    expect(result).toBe('');
    expect((context as never as { replyFn: ReturnType<typeof vi.fn> }).replyFn).not.toHaveBeenCalled();
  });

  it('answers group messages that mention the bot', async () => {
    const responder = makeResponder({ activation: 'mention' });
    const context = ctx({
      group: { isGroup: true, supportsMentions: true, mentions: ['me'], botUserId: 'me' },
    });

    const result = await responder.handle('hello', context);

    expect(result).toBe('assistant reply');
    expect((context as never as { replyFn: ReturnType<typeof vi.fn> }).replyFn).toHaveBeenCalledWith('assistant reply');
  });

  it('answers DMs untouched by group policy', async () => {
    const responder = makeResponder({ activation: 'mention' });
    const result = await responder.handle('hi', ctx());
    expect(result).toBe('assistant reply');
  });

  it('drops bot senders in groups even with no policy configured', async () => {
    const responder = makeResponder(undefined);
    const context = ctx({ group: { isGroup: true, senderIsBot: true } });

    const result = await responder.handle('loop?', context);

    expect(result).toBe('');
    expect((context as never as { replyFn: ReturnType<typeof vi.fn> }).replyFn).not.toHaveBeenCalled();
  });

  it('shouldEngage reports the machine-readable drop reason and marks it silent', async () => {
    const responder = makeResponder({ activation: 'owner-only', ownerIds: ['boss'] });
    const gate = await responder.shouldEngage({ userId: 'u1', isGroup: true });
    expect(gate).toEqual({ allowed: false, reason: 'owner-only', silent: true });
  });

  it('security-gate denials stay user-visible (not silent)', async () => {
    const responder = new ChatTaskResponder({
      securityTier: 'standard',
      allowedUsers: ['someone-else'],
      conversationHistoryLimit: 10,
      dbPath: ':memory:',
      llmCallFn: async () => 'assistant reply',
    } as never);
    responders.push(responder);

    const gate = await responder.shouldEngage({ userId: 'u1' });

    expect(gate.allowed).toBe(false);
    expect(gate.silent).toBeUndefined();
    expect(gate.reason).toBeTruthy();
  });
});
