/**
 * @fileoverview Comprehensive tests for Wunderland security hardening modules
 * @module wunderland/__tests__/security-hardening.test
 *
 * Covers:
 *   1. safe-merge   — prototype pollution prevention
 *   2. ssrf-guard   — SSRF IP/host blocking
 *   3. PreLLMClassifier — prompt size DoS prevention
 *   4. ToolLoopDetector — infinite tool loop detection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    safeDeepMerge,
    safeDeepMergeSilent,
    stripDangerousKeys,
    isSafeKey,
} from '../utils/safe-merge.js';
import {
    isPrivateIPv4,
    isPrivateIPv6,
    isPrivateIP,
    isBlockedHost,
    validateURL,
    validateWebSocketURL,
} from '../utils/ssrf-guard.js';
import { PreLLMClassifier } from '../security/PreLLMClassifier.js';
import { ToolLoopDetector } from '../security/ToolLoopDetector.js';

// =============================================================================
// 1. safe-merge
// =============================================================================

describe('safe-merge', () => {
    // -------------------------------------------------------------------------
    // isSafeKey
    // -------------------------------------------------------------------------
    describe('isSafeKey', () => {
        it('should return false for __proto__', () => {
            expect(isSafeKey('__proto__')).toBe(false);
        });

        it('should return false for constructor', () => {
            expect(isSafeKey('constructor')).toBe(false);
        });

        it('should return false for prototype', () => {
            expect(isSafeKey('prototype')).toBe(false);
        });

        it('should return true for normal keys', () => {
            expect(isSafeKey('name')).toBe(true);
            expect(isSafeKey('value')).toBe(true);
            expect(isSafeKey('nested')).toBe(true);
            expect(isSafeKey('')).toBe(true);
            expect(isSafeKey('0')).toBe(true);
        });

        it('should return true for keys that look similar but are not dangerous', () => {
            expect(isSafeKey('__proto')).toBe(true);
            expect(isSafeKey('proto__')).toBe(true);
            expect(isSafeKey('constructors')).toBe(true);
            expect(isSafeKey('prototyped')).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // safeDeepMerge
    // -------------------------------------------------------------------------
    describe('safeDeepMerge', () => {
        it('should throw on __proto__ key in source', () => {
            const target = { a: 1 };
            // We must use Object.create to sneak __proto__ as an own key
            const source = JSON.parse('{"__proto__": {"admin": true}}');
            expect(() => safeDeepMerge(target, source)).toThrow(
                /rejecting prototype-polluting key "__proto__"/
            );
        });

        it('should throw on constructor key in source', () => {
            const target = {};
            const source = JSON.parse('{"constructor": {"prototype": {"evil": true}}}');
            expect(() => safeDeepMerge(target, source)).toThrow(
                /rejecting prototype-polluting key "constructor"/
            );
        });

        it('should throw on prototype key in source', () => {
            const target = {};
            const source = JSON.parse('{"prototype": {"hack": true}}');
            expect(() => safeDeepMerge(target, source)).toThrow(
                /rejecting prototype-polluting key "prototype"/
            );
        });

        it('should throw on dangerous keys nested deep in source', () => {
            const target = { a: { b: { c: 1 } } };
            const source = JSON.parse('{"a": {"b": {"__proto__": {"x": 1}}}}');
            expect(() => safeDeepMerge(target, source)).toThrow(
                /rejecting prototype-polluting key "__proto__"/
            );
        });

        it('should merge flat objects correctly', () => {
            const result = safeDeepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
            expect(result).toEqual({ a: 1, b: 3, c: 4 });
        });

        it('should deep merge nested objects', () => {
            const target = { nested: { a: 1, b: 2 }, top: 'hello' };
            const source = { nested: { b: 3, c: 4 }, extra: true };
            const result = safeDeepMerge(target, source);
            expect(result).toEqual({
                nested: { a: 1, b: 3, c: 4 },
                top: 'hello',
                extra: true,
            });
        });

        it('should replace arrays wholesale (not merge element-by-element)', () => {
            const target = { items: [1, 2, 3] };
            const source = { items: [4, 5] };
            const result = safeDeepMerge(target, source);
            expect(result.items).toEqual([4, 5]);
        });

        it('should override primitives with objects and vice versa', () => {
            const result1 = safeDeepMerge({ a: 'string' }, { a: { nested: true } });
            expect(result1.a).toEqual({ nested: true });

            const result2 = safeDeepMerge(
                { a: { nested: true } } as Record<string, unknown>,
                { a: 42 } as Record<string, unknown>
            );
            expect(result2.a).toBe(42);
        });

        it('should not mutate target or source', () => {
            const target = { a: 1, nested: { b: 2 } };
            const source = { nested: { c: 3 } };
            const targetCopy = JSON.parse(JSON.stringify(target));
            const sourceCopy = JSON.parse(JSON.stringify(source));

            safeDeepMerge(target, source);

            expect(target).toEqual(targetCopy);
            expect(source).toEqual(sourceCopy);
        });

        it('should handle empty source', () => {
            const target = { a: 1, b: 2 };
            const result = safeDeepMerge(target, {});
            expect(result).toEqual({ a: 1, b: 2 });
        });

        it('should handle empty target', () => {
            const source = { a: 1, b: 2 };
            const result = safeDeepMerge({}, source);
            expect(result).toEqual({ a: 1, b: 2 });
        });

        it('should handle both empty', () => {
            const result = safeDeepMerge({}, {});
            expect(result).toEqual({});
        });
    });

    // -------------------------------------------------------------------------
    // safeDeepMergeSilent
    // -------------------------------------------------------------------------
    describe('safeDeepMergeSilent', () => {
        it('should silently drop __proto__ key instead of throwing', () => {
            const target = { a: 1 };
            const source = JSON.parse('{"__proto__": {"admin": true}, "b": 2}');
            const result = safeDeepMergeSilent(target, source);
            expect(result).toEqual({ a: 1, b: 2 });
            // Verify prototype was NOT polluted
            expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
        });

        it('should silently drop constructor key', () => {
            const source = JSON.parse('{"constructor": {"evil": true}, "safe": "value"}');
            const result = safeDeepMergeSilent({}, source);
            expect(result).toEqual({ safe: 'value' });
        });

        it('should silently drop prototype key', () => {
            const source = JSON.parse('{"prototype": {"evil": true}, "ok": 1}');
            const result = safeDeepMergeSilent({}, source);
            expect(result).toEqual({ ok: 1 });
        });

        it('should silently drop nested dangerous keys', () => {
            const target = { nested: { x: 1 } };
            const source = JSON.parse('{"nested": {"__proto__": {"bad": true}, "y": 2}}');
            const result = safeDeepMergeSilent(target, source);
            expect(result).toEqual({ nested: { x: 1, y: 2 } });
        });

        it('should merge normal keys correctly (same as safeDeepMerge)', () => {
            const result = safeDeepMergeSilent(
                { a: 1, nested: { b: 2 } },
                { nested: { c: 3 }, d: 4 }
            );
            expect(result).toEqual({ a: 1, nested: { b: 2, c: 3 }, d: 4 });
        });
    });

    // -------------------------------------------------------------------------
    // stripDangerousKeys
    // -------------------------------------------------------------------------
    describe('stripDangerousKeys', () => {
        it('should remove __proto__ at top level', () => {
            const obj = JSON.parse('{"__proto__": {"admin": true}, "name": "test"}');
            const result = stripDangerousKeys(obj);
            expect(result).toEqual({ name: 'test' });
        });

        it('should remove constructor at top level', () => {
            const obj = JSON.parse('{"constructor": {}, "a": 1}');
            const result = stripDangerousKeys(obj);
            expect(result).toEqual({ a: 1 });
        });

        it('should remove prototype at top level', () => {
            const obj = JSON.parse('{"prototype": {}, "b": 2}');
            const result = stripDangerousKeys(obj);
            expect(result).toEqual({ b: 2 });
        });

        it('should remove dangerous keys nested multiple levels deep', () => {
            const obj = JSON.parse(
                '{"level1": {"level2": {"__proto__": {"bad": true}, "safe": "ok"}, "constructor": "evil"}, "top": 1}'
            );
            const result = stripDangerousKeys(obj);
            expect(result).toEqual({
                level1: { level2: { safe: 'ok' } },
                top: 1,
            });
        });

        it('should not mutate the original object', () => {
            const obj = JSON.parse('{"__proto__": {"admin": true}, "name": "test"}');
            const objCopy = JSON.parse(JSON.stringify(obj));
            stripDangerousKeys(obj);
            expect(obj).toEqual(objCopy);
        });

        it('should return an identical copy when no dangerous keys exist', () => {
            const obj = { a: 1, b: { c: 2, d: { e: 3 } } };
            const result = stripDangerousKeys(obj);
            expect(result).toEqual(obj);
        });

        it('should handle object with only dangerous keys', () => {
            const obj = JSON.parse('{"__proto__": 1, "constructor": 2, "prototype": 3}');
            const result = stripDangerousKeys(obj);
            expect(result).toEqual({});
        });

        it('should preserve non-plain-object values (arrays, primitives)', () => {
            const obj = { arr: [1, 2, 3], num: 42, str: 'hello', bool: true, nil: null };
            const result = stripDangerousKeys(obj);
            expect(result).toEqual(obj);
        });
    });
});

// =============================================================================
// 2. ssrf-guard
// =============================================================================

describe('ssrf-guard', () => {
    // -------------------------------------------------------------------------
    // isPrivateIPv4
    // -------------------------------------------------------------------------
    describe('isPrivateIPv4', () => {
        it('should detect 10.x.x.x addresses (RFC 1918)', () => {
            expect(isPrivateIPv4('10.0.0.0')).toBe(true);
            expect(isPrivateIPv4('10.0.0.1')).toBe(true);
            expect(isPrivateIPv4('10.255.255.255')).toBe(true);
            expect(isPrivateIPv4('10.1.2.3')).toBe(true);
        });

        it('should detect 172.16-31.x.x addresses (RFC 1918)', () => {
            expect(isPrivateIPv4('172.16.0.0')).toBe(true);
            expect(isPrivateIPv4('172.16.0.1')).toBe(true);
            expect(isPrivateIPv4('172.31.255.255')).toBe(true);
            expect(isPrivateIPv4('172.20.10.5')).toBe(true);
        });

        it('should detect 192.168.x.x addresses (RFC 1918)', () => {
            expect(isPrivateIPv4('192.168.0.0')).toBe(true);
            expect(isPrivateIPv4('192.168.0.1')).toBe(true);
            expect(isPrivateIPv4('192.168.1.1')).toBe(true);
            expect(isPrivateIPv4('192.168.255.255')).toBe(true);
        });

        it('should detect 127.x.x.x loopback addresses', () => {
            expect(isPrivateIPv4('127.0.0.1')).toBe(true);
            expect(isPrivateIPv4('127.0.0.0')).toBe(true);
            expect(isPrivateIPv4('127.255.255.255')).toBe(true);
        });

        it('should detect 169.254.x.x link-local addresses', () => {
            expect(isPrivateIPv4('169.254.0.0')).toBe(true);
            expect(isPrivateIPv4('169.254.169.254')).toBe(true);
            expect(isPrivateIPv4('169.254.255.255')).toBe(true);
        });

        it('should detect 0.0.0.0 current network address', () => {
            expect(isPrivateIPv4('0.0.0.0')).toBe(true);
            expect(isPrivateIPv4('0.0.0.1')).toBe(true);
        });

        it('should detect 100.64.x.x carrier-grade NAT (RFC 6598)', () => {
            expect(isPrivateIPv4('100.64.0.0')).toBe(true);
            expect(isPrivateIPv4('100.127.255.255')).toBe(true);
        });

        it('should detect 255.255.255.255 broadcast', () => {
            expect(isPrivateIPv4('255.255.255.255')).toBe(true);
        });

        it('should detect multicast (224.0.0.0/4) and reserved (240.0.0.0/4) ranges', () => {
            expect(isPrivateIPv4('224.0.0.1')).toBe(true);
            expect(isPrivateIPv4('239.255.255.255')).toBe(true);
            expect(isPrivateIPv4('240.0.0.0')).toBe(true);
            expect(isPrivateIPv4('250.1.2.3')).toBe(true);
        });

        it('should allow public IPs', () => {
            expect(isPrivateIPv4('8.8.8.8')).toBe(false);
            expect(isPrivateIPv4('1.1.1.1')).toBe(false);
            expect(isPrivateIPv4('93.184.216.34')).toBe(false);
            expect(isPrivateIPv4('203.0.114.1')).toBe(false); // just outside documentation range
            expect(isPrivateIPv4('172.32.0.0')).toBe(false); // just outside 172.16-31
            expect(isPrivateIPv4('192.169.0.1')).toBe(false); // just outside 192.168
        });

        it('should return false for non-IPv4 strings', () => {
            expect(isPrivateIPv4('not-an-ip')).toBe(false);
            expect(isPrivateIPv4('::1')).toBe(false);
            expect(isPrivateIPv4('')).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // isPrivateIPv6
    // -------------------------------------------------------------------------
    describe('isPrivateIPv6', () => {
        it('should detect loopback (::1)', () => {
            expect(isPrivateIPv6('::1')).toBe(true);
        });

        it('should detect link-local (fe80:)', () => {
            expect(isPrivateIPv6('fe80::1')).toBe(true);
            expect(isPrivateIPv6('fe80::abcd:1234')).toBe(true);
        });

        it('should detect unique-local (fc00: and fd)', () => {
            expect(isPrivateIPv6('fc00::1')).toBe(true);
            expect(isPrivateIPv6('fd00::1')).toBe(true);
            expect(isPrivateIPv6('fdab::1234')).toBe(true);
        });

        it('should detect IPv4-mapped loopback (::ffff:127.x)', () => {
            expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
        });

        it('should detect IPv4-mapped private ranges', () => {
            expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
            expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true);
            expect(isPrivateIPv6('::ffff:172.16.0.1')).toBe(true);
            expect(isPrivateIPv6('::ffff:169.254.1.1')).toBe(true);
        });

        it('should return false for non-IPv6 strings', () => {
            expect(isPrivateIPv6('10.0.0.1')).toBe(false);
            expect(isPrivateIPv6('not-an-ip')).toBe(false);
            expect(isPrivateIPv6('')).toBe(false);
        });

        it('should return false for public IPv6 addresses', () => {
            expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false); // Google DNS
        });
    });

    // -------------------------------------------------------------------------
    // isPrivateIP
    // -------------------------------------------------------------------------
    describe('isPrivateIP', () => {
        it('should detect private IPv4', () => {
            expect(isPrivateIP('10.0.0.1')).toBe(true);
            expect(isPrivateIP('192.168.1.1')).toBe(true);
        });

        it('should detect private IPv6', () => {
            expect(isPrivateIP('::1')).toBe(true);
            expect(isPrivateIP('fe80::1')).toBe(true);
        });

        it('should allow public IPv4', () => {
            expect(isPrivateIP('8.8.8.8')).toBe(false);
        });

        it('should allow public IPv6', () => {
            expect(isPrivateIP('2001:4860:4860::8888')).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // isBlockedHost
    // -------------------------------------------------------------------------
    describe('isBlockedHost', () => {
        it('should block cloud metadata endpoint IP (169.254.169.254)', () => {
            expect(isBlockedHost('169.254.169.254')).toBe(true);
        });

        it('should block GCP metadata hostname', () => {
            expect(isBlockedHost('metadata.google.internal')).toBe(true);
        });

        it('should block metadata.google.com', () => {
            expect(isBlockedHost('metadata.google.com')).toBe(true);
        });

        it('should block Azure metadata hostname', () => {
            expect(isBlockedHost('metadata.azure.internal')).toBe(true);
        });

        it('should block localhost variants', () => {
            expect(isBlockedHost('localhost')).toBe(true);
            expect(isBlockedHost('localhost.localdomain')).toBe(true);
            expect(isBlockedHost('ip6-localhost')).toBe(true);
            expect(isBlockedHost('ip6-loopback')).toBe(true);
        });

        it('should block literal private IPs', () => {
            expect(isBlockedHost('10.0.0.1')).toBe(true);
            expect(isBlockedHost('192.168.0.1')).toBe(true);
            expect(isBlockedHost('127.0.0.1')).toBe(true);
        });

        it('should block .local, .internal, .localhost, .intranet suffixes', () => {
            expect(isBlockedHost('my-service.local')).toBe(true);
            expect(isBlockedHost('database.internal')).toBe(true);
            expect(isBlockedHost('something.localhost')).toBe(true);
            expect(isBlockedHost('wiki.intranet')).toBe(true);
        });

        it('should block IPv6 bracket notation', () => {
            expect(isBlockedHost('[::1]')).toBe(true);
            expect(isBlockedHost('[fe80::1]')).toBe(true);
        });

        it('should be case-insensitive', () => {
            expect(isBlockedHost('LOCALHOST')).toBe(true);
            expect(isBlockedHost('Metadata.Google.Internal')).toBe(true);
        });

        it('should allow public hostnames', () => {
            expect(isBlockedHost('example.com')).toBe(false);
            expect(isBlockedHost('api.github.com')).toBe(false);
            expect(isBlockedHost('8.8.8.8')).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // validateURL
    // -------------------------------------------------------------------------
    describe('validateURL', () => {
        it('should allow https URLs to public hosts', () => {
            const result = validateURL('https://api.example.com/data');
            expect(result.safe).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it('should allow http URLs to public hosts by default', () => {
            const result = validateURL('http://api.example.com/data');
            expect(result.safe).toBe(true);
        });

        it('should reject URLs to private IPs', () => {
            const result = validateURL('http://10.0.0.1/admin');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Blocked host');
        });

        it('should reject URLs to 169.254.169.254 (metadata endpoint)', () => {
            const result = validateURL('http://169.254.169.254/latest/meta-data');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Blocked host');
        });

        it('should reject URLs to localhost', () => {
            const result = validateURL('http://localhost:8080/admin');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Blocked host');
        });

        it('should reject URLs to blocked hostnames (metadata.google.internal)', () => {
            const result = validateURL('http://metadata.google.internal/computeMetadata/v1');
            expect(result.safe).toBe(false);
        });

        it('should reject invalid URLs', () => {
            const result = validateURL('not a url');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Invalid URL');
        });

        it('should reject blocked protocols (e.g., ftp:)', () => {
            const result = validateURL('ftp://example.com/file');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Blocked protocol');
        });

        it('should respect allowHTTP=false option', () => {
            const result = validateURL('http://example.com/data', { allowHTTP: false });
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Blocked protocol');
        });

        it('should respect additionalBlockedHosts option', () => {
            const result = validateURL('https://evil.com/data', {
                additionalBlockedHosts: ['evil.com'],
            });
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('custom blocklist');
        });

        it('should reject URLs to .internal suffix hostnames', () => {
            const result = validateURL('https://secret.internal/api');
            expect(result.safe).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // validateWebSocketURL
    // -------------------------------------------------------------------------
    describe('validateWebSocketURL', () => {
        it('should allow wss:// to public hosts', () => {
            const result = validateWebSocketURL('wss://api.example.com/ws');
            expect(result.safe).toBe(true);
        });

        it('should allow ws:// to localhost (loopback dev)', () => {
            const result = validateWebSocketURL('ws://localhost:3000/ws');
            expect(result.safe).toBe(true);
        });

        it('should allow ws:// to 127.0.0.1', () => {
            const result = validateWebSocketURL('ws://127.0.0.1:3000/ws');
            expect(result.safe).toBe(true);
        });

        it('should allow ws:// to ::1 (IPv6 loopback)', () => {
            const result = validateWebSocketURL('ws://[::1]:3000/ws');
            expect(result.safe).toBe(true);
        });

        it('should block ws:// (plaintext) to non-loopback hosts', () => {
            const result = validateWebSocketURL('ws://api.example.com/ws');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Plaintext ws://');
            expect(result.reason).toContain('wss://');
        });

        it('should block ws:// to private IPs that are not loopback', () => {
            const result = validateWebSocketURL('ws://10.0.0.1:8080/ws');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Plaintext ws://');
        });

        it('should block ws:// to 192.168.x.x', () => {
            const result = validateWebSocketURL('ws://192.168.1.1:8080/ws');
            expect(result.safe).toBe(false);
        });

        it('should block wss:// to private IPs (non-loopback)', () => {
            const result = validateWebSocketURL('wss://10.0.0.1/ws');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Blocked WebSocket host');
        });

        it('should allow wss:// to loopback for local development', () => {
            const result = validateWebSocketURL('wss://localhost:3000/ws');
            expect(result.safe).toBe(true);
        });

        it('should reject non-WebSocket URLs', () => {
            const result = validateWebSocketURL('http://example.com');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Not a WebSocket URL');
        });

        it('should reject invalid WebSocket URLs', () => {
            const result = validateWebSocketURL('not a url');
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('Invalid WebSocket URL');
        });

        it('should block wss:// to .internal suffix hosts', () => {
            const result = validateWebSocketURL('wss://secret.internal/ws');
            expect(result.safe).toBe(false);
        });
    });
});

// =============================================================================
// 3. PreLLMClassifier — prompt size DoS
// =============================================================================

describe('PreLLMClassifier prompt size DoS', () => {
    let classifier: PreLLMClassifier;

    function makePayload(text: string) {
        return {
            context: { userId: 'test-user', sessionId: 'test-session' },
            input: {
                userId: 'test-user',
                sessionId: 'test-session',
                textInput: text,
            },
        };
    }

    beforeEach(() => {
        classifier = new PreLLMClassifier();
    });

    it('should have a default max prompt size of 2 MiB', () => {
        expect(PreLLMClassifier.DEFAULT_MAX_PROMPT_SIZE_BYTES).toBe(2_097_152);
    });

    it('should allow inputs under 2 MB to pass through normally', async () => {
        const normalText = 'What is the weather today?';
        const result = await classifier.evaluateInput(makePayload(normalText));
        // Safe input returns null (no guardrail action)
        expect(result).toBeNull();
    });

    it('should allow a moderately large input (100 KB) through', async () => {
        const text = 'a'.repeat(100_000);
        const result = await classifier.evaluateInput(makePayload(text));
        // Even if some baseline risk is detected, it should NOT be blocked for size
        if (result !== null) {
            expect(result.reasonCode).not.toBe('PROMPT_TOO_LARGE');
        }
    });

    it('should block inputs over 2 MB with PROMPT_TOO_LARGE reason code', async () => {
        // Create a string that exceeds 2 MiB (use ASCII so 1 byte per char)
        const hugeText = 'x'.repeat(2_097_153);
        const result = await classifier.evaluateInput(makePayload(hugeText));

        expect(result).not.toBeNull();
        expect(result!.action).toBe('block');
        expect(result!.reasonCode).toBe('PROMPT_TOO_LARGE');
        expect(result!.reason).toContain('exceeds maximum');
        expect(result!.metadata).toBeDefined();
        expect(result!.metadata!.inputByteLength).toBeGreaterThan(2_097_152);
        expect(result!.metadata!.maxPromptSizeBytes).toBe(2_097_152);
    });

    it('should block exactly-over-limit inputs', async () => {
        // Exactly 2 MiB should pass; 2 MiB + 1 should be blocked
        const exactLimitText = 'x'.repeat(2_097_152);
        const resultExact = await classifier.evaluateInput(makePayload(exactLimitText));
        if (resultExact !== null) {
            // If it returns something, it must NOT be a size block
            expect(resultExact.reasonCode).not.toBe('PROMPT_TOO_LARGE');
        }

        const overLimitText = 'x'.repeat(2_097_153);
        const resultOver = await classifier.evaluateInput(makePayload(overLimitText));
        expect(resultOver).not.toBeNull();
        expect(resultOver!.reasonCode).toBe('PROMPT_TOO_LARGE');
    });

    it('should account for multi-byte characters in size calculation', async () => {
        // Each emoji is typically 4 bytes in UTF-8
        // Create a string of emojis that exceeds 2 MiB in bytes even though
        // the character count is lower
        const emoji = '\u{1F600}'; // 4 bytes in UTF-8
        const count = Math.ceil(2_097_153 / 4) + 1;
        const text = emoji.repeat(count);

        const result = await classifier.evaluateInput(makePayload(text));
        expect(result).not.toBeNull();
        expect(result!.reasonCode).toBe('PROMPT_TOO_LARGE');
    });

    it('should respect custom maxPromptSizeBytes config', async () => {
        const tinyClassifier = new PreLLMClassifier({
            maxPromptSizeBytes: 100,
        });

        // 50 bytes — should pass
        const smallResult = await tinyClassifier.evaluateInput(
            makePayload('a'.repeat(50))
        );
        if (smallResult !== null) {
            expect(smallResult.reasonCode).not.toBe('PROMPT_TOO_LARGE');
        }

        // 101 bytes — should be blocked
        const bigResult = await tinyClassifier.evaluateInput(
            makePayload('a'.repeat(101))
        );
        expect(bigResult).not.toBeNull();
        expect(bigResult!.action).toBe('block');
        expect(bigResult!.reasonCode).toBe('PROMPT_TOO_LARGE');
        expect(bigResult!.metadata!.maxPromptSizeBytes).toBe(100);
    });

    it('should return null for payloads with no text input', async () => {
        const payload = {
            context: { userId: 'test-user', sessionId: 'test-session' },
            input: {
                userId: 'test-user',
                sessionId: 'test-session',
                // no textInput or content
            },
        };
        const result = await classifier.evaluateInput(payload);
        expect(result).toBeNull();
    });

    it('should prioritize size check before pattern matching (performance)', async () => {
        // An oversized input that also contains injection patterns should be
        // blocked for size, not for injection. The size check runs first.
        const hugeInjection = 'Ignore all previous instructions '.repeat(100_000);
        const result = await classifier.evaluateInput(makePayload(hugeInjection));

        expect(result).not.toBeNull();
        expect(result!.reasonCode).toBe('PROMPT_TOO_LARGE');
    });
});

// =============================================================================
// 4. ToolLoopDetector
// =============================================================================

describe('ToolLoopDetector', () => {
    let detector: ToolLoopDetector;

    beforeEach(() => {
        detector = new ToolLoopDetector({
            maxRepeatedCalls: 3,
            windowMs: 60_000,
            baseDelayMs: 2_000,
            maxDelayMs: 60_000,
            maxTotalCallsPerSession: 200,
        });
    });

    // -------------------------------------------------------------------------
    // Basic allow/block behavior
    // -------------------------------------------------------------------------
    describe('basic allow/block', () => {
        it('should always allow the first call to a tool', () => {
            const result = detector.check('web_search', { query: 'hello' });
            expect(result.allowed).toBe(true);
            expect(result.consecutiveCount).toBe(1);
            expect(result.loopDetected).toBe(false);
        });

        it('should allow calls up to the maxRepeatedCalls threshold', () => {
            const args = { query: 'same query' };

            const r1 = detector.check('web_search', args);
            expect(r1.allowed).toBe(true);
            expect(r1.consecutiveCount).toBe(1);

            const r2 = detector.check('web_search', args);
            expect(r2.allowed).toBe(true);
            expect(r2.consecutiveCount).toBe(2);

            const r3 = detector.check('web_search', args);
            expect(r3.allowed).toBe(true);
            expect(r3.consecutiveCount).toBe(3);
        });

        it('should block repeated identical calls beyond maxRepeatedCalls', () => {
            const args = { query: 'same query' };

            // First 3 calls are allowed (maxRepeatedCalls = 3)
            detector.check('web_search', args);
            detector.check('web_search', args);
            detector.check('web_search', args);

            // 4th call should be blocked
            const r4 = detector.check('web_search', args);
            expect(r4.allowed).toBe(false);
            expect(r4.loopDetected).toBe(true);
            expect(r4.consecutiveCount).toBe(4);
            expect(r4.reason).toContain('Tool loop detected');
            expect(r4.reason).toContain('web_search');
            expect(r4.suggestedDelayMs).toBeDefined();
        });
    });

    // -------------------------------------------------------------------------
    // Different tools don't interfere
    // -------------------------------------------------------------------------
    describe('tool isolation', () => {
        it('should not count calls to different tools against each other', () => {
            detector.check('web_search', { query: 'hello' });
            detector.check('web_search', { query: 'hello' });
            detector.check('web_search', { query: 'hello' });

            // Switch to a different tool — should reset consecutive count
            const result = detector.check('file_read', { path: '/tmp' });
            expect(result.allowed).toBe(true);
            expect(result.consecutiveCount).toBe(1);
        });

        it('should not count calls with different args as consecutive', () => {
            detector.check('web_search', { query: 'first' });
            detector.check('web_search', { query: 'second' });
            detector.check('web_search', { query: 'third' });
            detector.check('web_search', { query: 'fourth' });

            // All different args — should all be allowed
            const result = detector.check('web_search', { query: 'fifth' });
            expect(result.allowed).toBe(true);
            expect(result.consecutiveCount).toBe(1);
        });

        it('should resume counting after a different call breaks the streak', () => {
            const args = { query: 'same' };
            detector.check('web_search', args); // 1
            detector.check('web_search', args); // 2

            // Different tool breaks the streak
            detector.check('file_read', { path: '/tmp' });

            // Start new streak for web_search
            const result = detector.check('web_search', args);
            expect(result.allowed).toBe(true);
            expect(result.consecutiveCount).toBe(1);
        });
    });

    // -------------------------------------------------------------------------
    // Exponential backoff
    // -------------------------------------------------------------------------
    describe('exponential backoff', () => {
        it('should suggest baseDelayMs for the first blocked call', () => {
            const args = { query: 'loop' };

            // 3 allowed + 4th blocked
            detector.check('tool_a', args);
            detector.check('tool_a', args);
            detector.check('tool_a', args);

            const r4 = detector.check('tool_a', args);
            expect(r4.allowed).toBe(false);
            // exponent = 4 - 3 = 1, delay = 2000 * 2^0 = 2000
            expect(r4.suggestedDelayMs).toBe(2_000);
        });

        it('should double the delay for subsequent blocked calls', () => {
            const args = { query: 'loop' };

            detector.check('tool_a', args); // 1
            detector.check('tool_a', args); // 2
            detector.check('tool_a', args); // 3

            const r4 = detector.check('tool_a', args); // 4
            expect(r4.suggestedDelayMs).toBe(2_000); // 2000 * 2^0

            const r5 = detector.check('tool_a', args); // 5
            expect(r5.suggestedDelayMs).toBe(4_000); // 2000 * 2^1

            const r6 = detector.check('tool_a', args); // 6
            expect(r6.suggestedDelayMs).toBe(8_000); // 2000 * 2^2
        });

        it('should cap delay at maxDelayMs', () => {
            const smallMaxDetector = new ToolLoopDetector({
                maxRepeatedCalls: 1,
                baseDelayMs: 1_000,
                maxDelayMs: 5_000,
                windowMs: 60_000,
            });

            const args = { x: 1 };

            smallMaxDetector.check('t', args); // 1 — allowed

            smallMaxDetector.check('t', args); // 2 — blocked, 1000 * 2^0 = 1000
            const r3 = smallMaxDetector.check('t', args); // 3 — 1000 * 2^1 = 2000
            expect(r3.suggestedDelayMs).toBe(2_000);

            const r4 = smallMaxDetector.check('t', args); // 4 — 1000 * 2^2 = 4000
            expect(r4.suggestedDelayMs).toBe(4_000);

            const r5 = smallMaxDetector.check('t', args); // 5 — 1000 * 2^3 = 8000, capped at 5000
            expect(r5.suggestedDelayMs).toBe(5_000);

            const r6 = smallMaxDetector.check('t', args); // 6 — still capped
            expect(r6.suggestedDelayMs).toBe(5_000);
        });
    });

    // -------------------------------------------------------------------------
    // reset()
    // -------------------------------------------------------------------------
    describe('reset', () => {
        it('should clear call history and total count', () => {
            const args = { query: 'hello' };
            detector.check('web_search', args);
            detector.check('web_search', args);
            detector.check('web_search', args);

            detector.reset();

            const stats = detector.getStats();
            expect(stats.totalCalls).toBe(0);
            expect(stats.historySize).toBe(0);
            expect(stats.uniqueTools).toBe(0);
        });

        it('should allow previously-blocked calls after reset', () => {
            const args = { query: 'loop' };

            detector.check('web_search', args);
            detector.check('web_search', args);
            detector.check('web_search', args);
            const blocked = detector.check('web_search', args);
            expect(blocked.allowed).toBe(false);

            detector.reset();

            const afterReset = detector.check('web_search', args);
            expect(afterReset.allowed).toBe(true);
            expect(afterReset.consecutiveCount).toBe(1);
            expect(afterReset.totalCalls).toBe(1);
        });
    });

    // -------------------------------------------------------------------------
    // Total session call limit
    // -------------------------------------------------------------------------
    describe('total session call limit', () => {
        it('should enforce maxTotalCallsPerSession', () => {
            const limitDetector = new ToolLoopDetector({
                maxRepeatedCalls: 999, // high so loop detection doesn't trigger
                maxTotalCallsPerSession: 5,
                windowMs: 60_000,
            });

            // 5 unique calls — all allowed
            for (let i = 0; i < 5; i++) {
                const result = limitDetector.check(`tool_${i}`, { i });
                expect(result.allowed).toBe(true);
            }

            // 6th call — blocked by session limit
            const result = limitDetector.check('tool_extra', { i: 999 });
            expect(result.allowed).toBe(false);
            expect(result.loopDetected).toBe(true);
            expect(result.reason).toContain('Session tool call limit exceeded');
            expect(result.totalCalls).toBe(6);
        });

        it('should reset total call count on reset()', () => {
            const limitDetector = new ToolLoopDetector({
                maxRepeatedCalls: 999,
                maxTotalCallsPerSession: 3,
                windowMs: 60_000,
            });

            limitDetector.check('a', {});
            limitDetector.check('b', {});
            limitDetector.check('c', {});

            // 4th call blocked
            const blocked = limitDetector.check('d', {});
            expect(blocked.allowed).toBe(false);

            limitDetector.reset();

            // After reset, calls are allowed again
            const afterReset = limitDetector.check('e', {});
            expect(afterReset.allowed).toBe(true);
            expect(afterReset.totalCalls).toBe(1);
        });
    });

    // -------------------------------------------------------------------------
    // Disabled detector
    // -------------------------------------------------------------------------
    describe('enabled flag', () => {
        it('should always allow when disabled', () => {
            const disabledDetector = new ToolLoopDetector({
                enabled: false,
                maxRepeatedCalls: 1,
                maxTotalCallsPerSession: 1,
            });

            // Should be allowed despite going over all limits
            for (let i = 0; i < 10; i++) {
                const result = disabledDetector.check('tool', { same: true });
                expect(result.allowed).toBe(true);
                expect(result.loopDetected).toBe(false);
            }
        });
    });

    // -------------------------------------------------------------------------
    // record() and getStats()
    // -------------------------------------------------------------------------
    describe('record and getStats', () => {
        it('should track calls recorded via record()', () => {
            detector.record('tool_a', { x: 1 });
            detector.record('tool_b', { y: 2 });

            const stats = detector.getStats();
            expect(stats.totalCalls).toBe(2);
            expect(stats.uniqueTools).toBe(2);
            expect(stats.historySize).toBe(2);
        });

        it('should count record() calls toward total session limit', () => {
            const limitDetector = new ToolLoopDetector({
                maxRepeatedCalls: 999,
                maxTotalCallsPerSession: 3,
                windowMs: 60_000,
            });

            // Record 3 calls (bypassing loop detection)
            limitDetector.record('a', {});
            limitDetector.record('b', {});
            limitDetector.record('c', {});

            // 4th call via check() should hit session limit
            const result = limitDetector.check('d', {});
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Session tool call limit exceeded');
        });
    });

    // -------------------------------------------------------------------------
    // Args hashing determinism
    // -------------------------------------------------------------------------
    describe('args hashing', () => {
        it('should treat identical argument objects as the same', () => {
            detector.check('tool', { a: 1, b: 'two' });
            detector.check('tool', { a: 1, b: 'two' });
            detector.check('tool', { a: 1, b: 'two' });

            const r4 = detector.check('tool', { a: 1, b: 'two' });
            expect(r4.allowed).toBe(false);
            expect(r4.loopDetected).toBe(true);
        });

        it('should treat args with different key order as the same (sorted hash)', () => {
            detector.check('tool', { b: 2, a: 1 });
            detector.check('tool', { a: 1, b: 2 });
            detector.check('tool', { b: 2, a: 1 });

            const r4 = detector.check('tool', { a: 1, b: 2 });
            expect(r4.allowed).toBe(false);
            expect(r4.loopDetected).toBe(true);
        });

        it('should distinguish different argument values', () => {
            detector.check('tool', { a: 1 });
            detector.check('tool', { a: 2 });
            detector.check('tool', { a: 3 });
            detector.check('tool', { a: 4 });

            // All different — all should be allowed (consecutive count is 1 each)
            const result = detector.check('tool', { a: 5 });
            expect(result.allowed).toBe(true);
            expect(result.consecutiveCount).toBe(1);
        });
    });
});
