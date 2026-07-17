/**
 * @fileoverview Per-key async mutex — serializes tasks that share a key while
 * letting different keys run concurrently.
 * @module wunderland/runtime/execution/keyed-mutex
 *
 * Used to serialize agent turns on the same session: `deps.sessions` is a plain
 * Map with no concurrency control, so two turns on one session (two webhook
 * hits, or a webhook coinciding with a `/chat` request or a cron tick) would
 * interleave read-modify-write on the shared history array and corrupt it. Turns
 * on DIFFERENT sessions still run in parallel.
 *
 * Implementation is a per-key promise chain: each `runExclusive` appends its
 * task to the key's tail and awaits the prior tail. The chain entry is removed
 * once it drains, so idle keys hold no memory.
 */

export class KeyedMutex {
  /** key -> promise resolving when the last-queued task for that key settles. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `task` with exclusive access for `key`. Tasks on the same key run one
   * at a time, in call order; the lock is released even if `task` throws.
   */
  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // This task becomes the new tail; the next caller waits on `gate`.
    const tail = prior.then(() => gate);
    this.tails.set(key, tail);

    // Wait for all prior work on this key to finish before running.
    await prior;

    try {
      return await task();
    } finally {
      release();
      // Drop the chain entry once this was the final queued task for the key,
      // so idle keys don't accumulate. If a newer task queued behind us, the
      // map already points at that newer tail — leave it.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** Number of keys with in-flight or queued work (test/observability). */
  activeKeyCount(): number {
    return this.tails.size;
  }
}
