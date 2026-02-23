import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  canonicalizeJsonString,
  sha256HexUtf8,
  signSealHashIfConfigured,
  verifySealedConfig,
  verifySealSignature,
} from '../seal-utils.js';

describe('seal-utils', () => {
  const originalEnv = process.env.WUNDERLAND_SEAL_SIGNING_SEED_BASE64;

  beforeEach(() => {
    delete process.env.WUNDERLAND_SEAL_SIGNING_SEED_BASE64;
  });

  afterEach(() => {
    if (originalEnv) process.env.WUNDERLAND_SEAL_SIGNING_SEED_BASE64 = originalEnv;
    else delete process.env.WUNDERLAND_SEAL_SIGNING_SEED_BASE64;
  });

  it('canonicalizes JSON deeply (stable key order)', () => {
    const raw = JSON.stringify({ b: 1, a: { d: 2, c: 3 } });
    const { canonical } = canonicalizeJsonString(raw);
    expect(canonical).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('hash changes when nested values change', () => {
    const one = canonicalizeJsonString(JSON.stringify({ a: { x: 1 } })).canonical;
    const two = canonicalizeJsonString(JSON.stringify({ a: { x: 2 } })).canonical;
    expect(sha256HexUtf8(one)).not.toBe(sha256HexUtf8(two));
  });

  it('signs and verifies when signing seed env is present', () => {
    const seed = Buffer.alloc(32, 7);
    process.env.WUNDERLAND_SEAL_SIGNING_SEED_BASE64 = seed.toString('base64');

    const configHashHex = sha256HexUtf8('example');
    const signature = signSealHashIfConfigured(configHashHex);
    expect(signature?.scheme).toBe('ed25519');

    expect(
      verifySealSignature({
        configHashHex,
        signature: signature!,
      })
    ).toBe(true);

    expect(
      verifySealSignature({
        configHashHex: sha256HexUtf8('different'),
        signature: signature!,
      })
    ).toBe(false);
  });

  it('verifies v2 sealed.json against agent.config.json (hash-only)', () => {
    const configRaw = JSON.stringify({ b: 1, a: { z: 9, y: 8 } }, null, 2);
    const canonical = canonicalizeJsonString(configRaw).canonical;
    const configHash = sha256HexUtf8(canonical);

    const sealedRaw = JSON.stringify({
      format: 'wunderland.sealed.v2',
      sealedAt: new Date().toISOString(),
      configHash,
      signature: null,
      config: JSON.parse(configRaw),
    });

    const res = verifySealedConfig({ configRaw, sealedRaw });
    expect(res.ok).toBe(true);
    expect(res.format).toBe('wunderland.sealed.v2');
    expect(res.signaturePresent).toBe(false);
    expect(res.actualHashHex).toBe(configHash);
  });

  it('rejects when config hash mismatches', () => {
    const configRaw = JSON.stringify({ a: 1 });
    const sealedRaw = JSON.stringify({ format: 'wunderland.sealed.v2', configHash: sha256HexUtf8('different'), signature: null });
    const res = verifySealedConfig({ configRaw, sealedRaw });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/mismatch/i);
  });

  it('verifies signature when present', () => {
    const seed = Buffer.alloc(32, 9);
    process.env.WUNDERLAND_SEAL_SIGNING_SEED_BASE64 = seed.toString('base64');

    const configRaw = JSON.stringify({ a: 1, nested: { b: 2 } });
    const canonical = canonicalizeJsonString(configRaw).canonical;
    const configHash = sha256HexUtf8(canonical);
    const signature = signSealHashIfConfigured(configHash);
    expect(signature).toBeTruthy();

    const sealedRaw = JSON.stringify({
      format: 'wunderland.sealed.v2',
      configHash,
      signature,
      config: JSON.parse(configRaw),
    });

    const res = verifySealedConfig({ configRaw, sealedRaw });
    expect(res.ok).toBe(true);
    expect(res.signaturePresent).toBe(true);
    expect(res.signatureOk).toBe(true);
  });

  it('supports legacy v1 sealed.json verification', () => {
    const configObj = { b: 1, a: { x: 1, y: 2 } };
    const configRaw = JSON.stringify(configObj);
    const legacyCanonical = JSON.stringify(configObj, Object.keys(configObj).sort(), 0);
    const legacyHash = sha256HexUtf8(legacyCanonical);

    const sealedRaw = JSON.stringify({ sealedAt: new Date().toISOString(), configHash: `sha256:${legacyHash}`, config: configObj });
    const res = verifySealedConfig({ configRaw, sealedRaw });
    expect(res.ok).toBe(true);
    expect(res.format).toBe('legacy-v1');
  });
});
