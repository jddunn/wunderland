import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { ChatConversationStore } from '../ChatConversationStore.js';

const DB_PATH = join(tmpdir(), `chat-store-test-${Date.now()}.db`);

afterAll(() => { try { unlinkSync(DB_PATH); } catch {} });

describe('ChatConversationStore', () => {
  const store = new ChatConversationStore(DB_PATH, 5);

  it('stores and retrieves messages', async () => {
    await store.addMessage({ chatId: 'c1', platform: 'telegram', role: 'user', content: 'hello' });
    await store.addMessage({ chatId: 'c1', platform: 'telegram', role: 'assistant', content: 'hi there' });
    const history = await store.getHistory('c1');
    expect(history.length).toBe(2);
    expect(history[0].content).toBe('hello');
    expect(history[1].content).toBe('hi there');
  });

  it('trims history to limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.addMessage({ chatId: 'c2', platform: 'telegram', role: 'user', content: `msg-${i}` });
    }
    const history = await store.getHistory('c2');
    expect(history.length).toBe(5);
    expect(history[0].content).toBe('msg-5');
  });

  it('isolates conversations by chatId', async () => {
    await store.addMessage({ chatId: 'c3', platform: 'whatsapp', role: 'user', content: 'separate' });
    const h1 = await store.getHistory('c1');
    const h3 = await store.getHistory('c3');
    expect(h1.every(m => m.chat_id === 'c1')).toBe(true);
    expect(h3.length).toBe(1);
  });

  it('stores tool_calls metadata', async () => {
    await store.addMessage({
      chatId: 'c4',
      platform: 'telegram',
      role: 'assistant',
      content: 'Found the file',
      toolCalls: JSON.stringify([{ name: 'local_file_search', args: { query: 'pic.png' } }]),
    });
    const history = await store.getHistory('c4');
    expect(history[0].tool_calls).toContain('local_file_search');
  });
});
