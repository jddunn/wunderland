/**
 * @fileoverview SSRF protection — blocks requests to private/internal IPs
 * @module wunderland/utils/ssrf-guard
 *
 * Validates hostnames and IP addresses to prevent Server-Side Request Forgery
 * (SSRF) attacks where an agent's tool HTTP requests are redirected to internal
 * services (localhost, RFC 1918, link-local, etc.).
 *
 * Ported from OpenClaw upstream security fixes for SSRF IPv4 hardening.
 */

import { URL } from 'node:url';
import * as net from 'node:net';

/**
 * IPv4 private/reserved ranges that should be blocked.
 *
 * - 10.0.0.0/8        (RFC 1918 — private)
 * - 172.16.0.0/12      (RFC 1918 — private)
 * - 192.168.0.0/16     (RFC 1918 — private)
 * - 127.0.0.0/8        (loopback)
 * - 169.254.0.0/16     (link-local)
 * - 0.0.0.0/8          (current network)
 * - 100.64.0.0/10      (carrier-grade NAT — RFC 6598)
 * - 192.0.0.0/24       (IANA reserved)
 * - 192.0.2.0/24       (documentation — RFC 5737)
 * - 198.51.100.0/24    (documentation — RFC 5737)
 * - 203.0.113.0/24     (documentation — RFC 5737)
 * - 224.0.0.0/4        (multicast)
 * - 240.0.0.0/4        (reserved)
 * - 255.255.255.255/32 (broadcast)
 */
interface CIDRRange {
  base: number;
  mask: number;
}

function ipToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  // eslint-disable-next-line no-bitwise
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidr(ip: string, prefix: number): CIDRRange {
  return {
    base: ipToNum(ip),
    // eslint-disable-next-line no-bitwise
    mask: prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0,
  };
}

const BLOCKED_IPV4_RANGES: CIDRRange[] = [
  cidr('0.0.0.0', 8),       // current network
  cidr('10.0.0.0', 8),      // RFC 1918
  cidr('100.64.0.0', 10),   // carrier-grade NAT
  cidr('127.0.0.0', 8),     // loopback
  cidr('169.254.0.0', 16),  // link-local
  cidr('172.16.0.0', 12),   // RFC 1918
  cidr('192.0.0.0', 24),    // IANA reserved
  cidr('192.0.2.0', 24),    // documentation
  cidr('192.168.0.0', 16),  // RFC 1918
  cidr('198.18.0.0', 15),   // benchmarking
  cidr('198.51.100.0', 24), // documentation
  cidr('203.0.113.0', 24),  // documentation
  cidr('224.0.0.0', 4),     // multicast
  cidr('240.0.0.0', 4),     // reserved
];

/**
 * IPv6 prefixes that should be blocked.
 */
const BLOCKED_IPV6_PREFIXES = [
  '::1',         // loopback
  'fe80:',       // link-local
  'fc00:',       // unique-local (RFC 4193)
  'fd',          // unique-local
  '::ffff:127.', // IPv4-mapped loopback
  '::ffff:10.',  // IPv4-mapped private
  '::ffff:172.16.', '::ffff:172.17.', '::ffff:172.18.', '::ffff:172.19.',
  '::ffff:172.20.', '::ffff:172.21.', '::ffff:172.22.', '::ffff:172.23.',
  '::ffff:172.24.', '::ffff:172.25.', '::ffff:172.26.', '::ffff:172.27.',
  '::ffff:172.28.', '::ffff:172.29.', '::ffff:172.30.', '::ffff:172.31.',
  '::ffff:192.168.', // IPv4-mapped private
  '::ffff:169.254.', // IPv4-mapped link-local
  '::ffff:0.',   // IPv4-mapped current network
];

/**
 * Hostnames that should always be blocked (case-insensitive).
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',       // GCP metadata
  'metadata.google.com',
  '169.254.169.254',                // AWS/GCP/Azure metadata
  'metadata.azure.internal',
]);

/**
 * Checks if an IPv4 address falls within any blocked range.
 */
export function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;

  const num = ipToNum(ip);
  for (const range of BLOCKED_IPV4_RANGES) {
    // eslint-disable-next-line no-bitwise
    if ((num & range.mask) === (range.base & range.mask)) {
      return true;
    }
  }

  // Also check broadcast
  if (ip === '255.255.255.255') return true;

  return false;
}

/**
 * Checks if an IPv6 address is a blocked/private address.
 */
export function isPrivateIPv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;

  const lower = ip.toLowerCase();
  return BLOCKED_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Checks if an IP address (v4 or v6) is private/reserved.
 */
export function isPrivateIP(ip: string): boolean {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip);
}

/**
 * Checks if a hostname resolves to a blocked address or is in the blocklist.
 *
 * Note: This does NOT perform DNS resolution (which would be async).
 * It checks literal IPs and known-blocked hostnames only.
 * For full protection, DNS resolution should be checked separately.
 */
export function isBlockedHost(host: string): boolean {
  const lower = host.toLowerCase().trim();

  // Check blocked hostname list
  if (BLOCKED_HOSTNAMES.has(lower)) return true;

  // Check if the host is a literal IP
  if (net.isIP(lower)) {
    return isPrivateIP(lower);
  }

  // Check for IPv6 bracket notation [::1]
  if (lower.startsWith('[') && lower.endsWith(']')) {
    const innerIP = lower.slice(1, -1);
    if (net.isIPv6(innerIP)) {
      return isPrivateIPv6(innerIP);
    }
  }

  // Hostname ending with common internal suffixes
  if (
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.intranet')
  ) {
    return true;
  }

  return false;
}

/**
 * Validates a URL for SSRF safety.
 *
 * @param urlString - URL to validate
 * @param options - Validation options
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateURL('http://169.254.169.254/metadata');
 * // → { safe: false, reason: 'Host resolves to blocked IP: 169.254.169.254' }
 *
 * const result2 = validateURL('https://api.example.com/data');
 * // → { safe: true }
 * ```
 */
export function validateURL(
  urlString: string,
  options: {
    /** Allow HTTP (non-TLS) connections. Default: true */
    allowHTTP?: boolean;
    /** Allow non-standard ports. Default: true */
    allowNonStandardPorts?: boolean;
    /** Additional blocked hosts */
    additionalBlockedHosts?: string[];
  } = {}
): { safe: boolean; reason?: string } {
  const { allowHTTP = true, additionalBlockedHosts = [] } = options;

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: `Invalid URL: ${urlString}` };
  }

  // Protocol check
  const allowedProtocols = allowHTTP
    ? ['http:', 'https:']
    : ['https:'];

  if (!allowedProtocols.includes(parsed.protocol)) {
    return {
      safe: false,
      reason: `Blocked protocol: ${parsed.protocol} (allowed: ${allowedProtocols.join(', ')})`,
    };
  }

  // Host check
  const host = parsed.hostname;
  if (!host) {
    return { safe: false, reason: 'URL has no hostname' };
  }

  if (isBlockedHost(host)) {
    return {
      safe: false,
      reason: `Blocked host: ${host} (private/reserved address)`,
    };
  }

  // Check additional blocked hosts
  const lowerHost = host.toLowerCase();
  for (const blocked of additionalBlockedHosts) {
    if (lowerHost === blocked.toLowerCase()) {
      return {
        safe: false,
        reason: `Blocked host: ${host} (custom blocklist)`,
      };
    }
  }

  return { safe: true };
}

/**
 * Validates that a WebSocket URL uses TLS for non-loopback hosts.
 *
 * Ported from OpenClaw upstream: block plaintext ws:// to non-loopback.
 */
export function validateWebSocketURL(wsUrl: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return { safe: false, reason: `Invalid WebSocket URL: ${wsUrl}` };
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { safe: false, reason: `Not a WebSocket URL: ${parsed.protocol}` };
  }

  const host = parsed.hostname.toLowerCase();

  // ws:// is only allowed for loopback addresses
  if (parsed.protocol === 'ws:') {
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]';

    if (!isLoopback) {
      return {
        safe: false,
        reason: `Plaintext ws:// connections are only allowed to loopback addresses. Use wss:// for ${host}`,
      };
    }
  }

  // For wss://, still block private IPs
  if (parsed.protocol === 'wss:' && isBlockedHost(host)) {
    // Allow loopback for local development
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]';

    if (!isLoopback) {
      return {
        safe: false,
        reason: `Blocked WebSocket host: ${host} (private/reserved address)`,
      };
    }
  }

  return { safe: true };
}
