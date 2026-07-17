import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../keyed-mutex.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes tasks sharing a key (no interleave)', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const task = (label: string, hold: number) =>
      mutex.runExclusive('s', async () => {
        log.push(`${label}:start`);
        await tick(hold);
        log.push(`${label}:end`);
      });

    // Start B before A finishes; B must wait for A to fully complete.
    const a = task('A', 30);
    const b = task('B', 0);
    await Promise.all([a, b]);

    expect(log).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const slow = mutex.runExclusive('x', async () => {
      await tick(40);
      order.push('x');
    });
    const fast = mutex.runExclusive('y', async () => {
      order.push('y');
    });
    await Promise.all([slow, fast]);

    // y (different key) finishes first despite starting second.
    expect(order).toEqual(['y', 'x']);
  });

  it('returns the task result', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('k', async () => 42)).resolves.toBe(42);
  });

  it('a throwing task releases the lock (next task still runs)', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('k', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // Lock must have been released despite the throw.
    await expect(mutex.runExclusive('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('does not leak a chain entry once a key drains', async () => {
    const mutex = new KeyedMutex();
    await mutex.runExclusive('k', async () => undefined);
    expect(mutex.activeKeyCount()).toBe(0);
  });
});
