import { describe, it, expect, vi } from 'vitest';
import { validateUrlWithDns } from '../ssrf-guard.js';

/** Build an injectable resolver returning fixed addresses for a host. */
function resolver(map: Record<string, Array<{ address: string; family: number }>>) {
  return vi.fn(async (host: string) => {
    const recs = map[host];
    if (!recs) throw new Error(`ENOTFOUND ${host}`);
    return recs;
  });
}

describe('validateUrlWithDns (SSRF + DNS resolution)', () => {
  it('rejects a literal private IP without needing DNS', async () => {
    const lookup = resolver({});
    const r = await validateUrlWithDns('http://169.254.169.254/latest/meta-data', { lookup });
    expect(r.safe).toBe(false);
    expect(lookup).not.toHaveBeenCalled(); // sync path caught it
  });

  it('allows a public host resolving to a public IP', async () => {
    const lookup = resolver({ 'api.example.com': [{ address: '93.184.216.34', family: 4 }] });
    const r = await validateUrlWithDns('https://api.example.com/hook', { lookup });
    expect(r.safe).toBe(true);
    expect(r.resolvedAddresses).toContain('93.184.216.34');
  });

  it('blocks DNS rebinding: public host that resolves to a private IP', async () => {
    const lookup = resolver({ 'rebind.evil.com': [{ address: '10.0.0.5', family: 4 }] });
    const r = await validateUrlWithDns('https://rebind.evil.com/x', { lookup });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/resolv|private|10\.0\.0\.5/i);
  });

  it('blocks if ANY resolved record is private (mixed A records)', async () => {
    const lookup = resolver({
      'mixed.example.com': [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    const r = await validateUrlWithDns('https://mixed.example.com', { lookup });
    expect(r.safe).toBe(false);
  });

  it('blocks a private IPv6 resolution', async () => {
    const lookup = resolver({ 'v6.example.com': [{ address: '::1', family: 6 }] });
    const r = await validateUrlWithDns('https://v6.example.com', { lookup });
    expect(r.safe).toBe(false);
  });

  it('rejects when the host does not resolve', async () => {
    const lookup = resolver({});
    const r = await validateUrlWithDns('https://nope.invalid', { lookup });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/resolv|lookup|ENOTFOUND/i);
  });

  it('honors additionalBlockedHosts before resolving', async () => {
    const lookup = resolver({ 'blocked.example.com': [{ address: '93.184.216.34', family: 4 }] });
    const r = await validateUrlWithDns('https://blocked.example.com', {
      lookup,
      additionalBlockedHosts: ['blocked.example.com'],
    });
    expect(r.safe).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});
