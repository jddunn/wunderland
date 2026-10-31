/**
 * @fileoverview Regression tests: the intent chain is an audit trail, so nothing
 * a caller holds can rewrite what the tracker recorded.
 * @module wunderland/security/__tests__/IntentChainTracker
 */

import { describe, it, expect } from 'vitest';
import { IntentChainTracker } from '../SignedOutputVerifier.js';

const STEP = {
  action: 'USER_INPUT',
  inputHash: 'in',
  outputHash: 'out',
  modelUsed: 'test-model',
};

describe('IntentChainTracker', () => {
  it('keeps its own copy of the flags and metadata a caller passes in', () => {
    const tracker = new IntentChainTracker();
    const securityFlags = ['FLAGGED'];
    const metadata = { nested: { reviewer: 'first' } };

    tracker.addEntry({ ...STEP, securityFlags, metadata });
    securityFlags.length = 0;
    metadata.nested.reviewer = 'rewritten';

    const [entry] = tracker.getEntries();
    expect(entry.securityFlags).toEqual(['FLAGGED']);
    expect(entry.metadata).toEqual({ nested: { reviewer: 'first' } });
    expect(tracker.hasSecurityFlags()).toBe(true);
  });

  it('does not let the entry addEntry returns rewrite the chain', () => {
    const tracker = new IntentChainTracker();
    const returned = tracker.addEntry({ ...STEP, securityFlags: ['FLAGGED'], metadata: { step: 1 } });

    returned.action = 'REWRITTEN';
    returned.securityFlags.pop();
    returned.metadata!.step = 2;
    returned.timestamp.setTime(0);

    const [entry] = tracker.getEntries();
    expect(entry.action).toBe('USER_INPUT');
    expect(entry.securityFlags).toEqual(['FLAGGED']);
    expect(entry.metadata).toEqual({ step: 1 });
    expect(entry.timestamp.getTime()).toBeGreaterThan(0);
  });

  it('does not let what getEntries returns rewrite the chain', () => {
    const tracker = new IntentChainTracker();
    tracker.addEntry({ ...STEP, securityFlags: ['FLAGGED'], metadata: { nested: { step: 1 } } });

    const read = tracker.getEntries() as ReturnType<IntentChainTracker['getLastEntries']>;
    read[0].action = 'REWRITTEN';
    read[0].securityFlags.pop();
    (read[0].metadata!.nested as { step: number }).step = 2;
    read[0].timestamp.setTime(0);
    read.pop();

    const [entry, ...rest] = tracker.getEntries();
    expect(rest).toEqual([]);
    expect(entry.action).toBe('USER_INPUT');
    expect(entry.securityFlags).toEqual(['FLAGGED']);
    expect(entry.metadata).toEqual({ nested: { step: 1 } });
    expect(entry.timestamp.getTime()).toBeGreaterThan(0);
  });

  it('does not let what getLastEntries returns rewrite the chain', () => {
    const tracker = new IntentChainTracker();
    tracker.addEntry({ ...STEP, securityFlags: ['FLAGGED'] });

    tracker.getLastEntries(1)[0].securityFlags.pop();

    expect(tracker.getAllSecurityFlags()).toEqual(['FLAGGED']);
  });

  it('copies a __proto__ key in parsed metadata as data', () => {
    const tracker = new IntentChainTracker();
    const metadata = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    tracker.addEntry({ ...STEP, securityFlags: [], metadata });

    const stored = tracker.getEntries()[0].metadata!;
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.keys(stored)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts circular metadata', () => {
    const tracker = new IntentChainTracker();
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;

    expect(() => tracker.addEntry({ ...STEP, securityFlags: [], metadata })).not.toThrow();
    const stored = tracker.getEntries()[0].metadata!;
    expect(stored.self).toBe(stored);
  });
});
