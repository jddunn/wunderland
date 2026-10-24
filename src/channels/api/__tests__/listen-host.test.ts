/**
 * @fileoverview Unit tests for the address the agent HTTP servers listen on.
 * @module wunderland/channels/api/__tests__/listen-host.test
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_LISTEN_HOST, displayHost, isLoopbackHost, resolveListenHost } from '../listen-host.js';

describe('resolveListenHost', () => {
  it('keeps the server on 127.0.0.1 when no host is named', () => {
    expect(DEFAULT_LISTEN_HOST).toBe('127.0.0.1');
    expect(resolveListenHost(undefined)).toBe('127.0.0.1');
  });

  it('returns the named address, trimmed', () => {
    expect(resolveListenHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveListenHost(' ::1 ')).toBe('::1');
  });

  it('refuses --host given without an address instead of guessing one', () => {
    expect(() => resolveListenHost(true)).toThrow(/--host needs an address/);
    expect(() => resolveListenHost('   ')).toThrow(/--host needs an address/);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'])('%s is this machine only', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', 'example.com'])('%s lets other machines connect', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('displayHost', () => {
  it('prints a wildcard address as localhost and brackets IPv6', () => {
    expect(displayHost('0.0.0.0')).toBe('localhost');
    expect(displayHost('::')).toBe('localhost');
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
    expect(displayHost('::1')).toBe('[::1]');
    expect(displayHost('[::1]')).toBe('[::1]');
  });
});
