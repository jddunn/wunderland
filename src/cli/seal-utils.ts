/**
 * @fileoverview Shared utilities for sealing/verifying agent configs.
 * @module wunderland/cli/seal-utils
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

const SEAL_DOMAIN = 'WUNDERLAND_SEAL_V1';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type SealSignature = {
  scheme: 'ed25519';
  /** Base64 DER (SPKI) public key bytes */
  publicKeySpkiB64: string;
  /** Base64 signature */
  signatureB64: string;
};

type SealedFileV1 = {
  sealedAt?: string;
  configHash?: string;
  config?: unknown;
};

type SealedFileV2 = {
  format?: string;
  sealedAt?: string;
  configHash?: string;
  signature?: SealSignature | null;
  config?: unknown;
};

export type SealVerificationResult = {
  ok: boolean;
  format: 'wunderland.sealed.v2' | 'legacy-v1';
  expectedHashRaw: string;
  expectedHashHex: string;
  actualHashHex: string;
  signaturePresent: boolean;
  signatureOk: boolean | null;
  warning?: string;
  error?: string;
};

function stableSortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSortJson);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = stableSortJson(record[key]);
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function canonicalizeJsonString(raw: string): { canonical: string; parsed: unknown } {
  const parsed = JSON.parse(raw) as unknown;
  const canonical = JSON.stringify(stableSortJson(parsed));
  return { canonical, parsed };
}

export function sha256HexUtf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildSealMessage(configHashHex: string): string {
  const h = String(configHashHex ?? '').trim().toLowerCase();
  return `${SEAL_DOMAIN}\nconfigHash:${h}`;
}

function seedBase64ToPrivateKey(seedB64: string) {
  const seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== 32) {
    throw new Error('WUNDERLAND_SEAL_SIGNING_SEED_BASE64 must decode to exactly 32 bytes.');
  }
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

export function signSealHashIfConfigured(configHashHex: string): SealSignature | null {
  const seedB64 = (process.env.WUNDERLAND_SEAL_SIGNING_SEED_BASE64 ?? '').trim();
  if (!seedB64) return null;

  const privateKey = seedBase64ToPrivateKey(seedB64);
  const publicKey = createPublicKey(privateKey);

  const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const message = Buffer.from(buildSealMessage(configHashHex), 'utf8');
  const signature = cryptoSign(null, message, privateKey);

  return {
    scheme: 'ed25519',
    publicKeySpkiB64: publicKeySpki.toString('base64'),
    signatureB64: signature.toString('base64'),
  };
}

export function verifySealSignature(opts: {
  configHashHex: string;
  signature: SealSignature;
}): boolean {
  if (!opts.signature?.publicKeySpkiB64 || !opts.signature?.signatureB64) return false;
  try {
    const publicKeyDer = Buffer.from(opts.signature.publicKeySpkiB64, 'base64');
    const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    const message = Buffer.from(buildSealMessage(opts.configHashHex), 'utf8');
    const sig = Buffer.from(opts.signature.signatureB64, 'base64');
    return cryptoVerify(null, message, publicKey, sig);
  } catch {
    return false;
  }
}

function parseSealedFile(raw: string): SealedFileV1 | SealedFileV2 | null {
  try {
    const parsed = JSON.parse(raw) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeHash(raw: string): string {
  const v = String(raw ?? '').trim();
  return v.toLowerCase().startsWith('sha256:') ? v.slice('sha256:'.length) : v;
}

function legacyCanonicalizeConfig(configRaw: string): string {
  const config = JSON.parse(configRaw) as Record<string, unknown>;
  const replacer = Object.keys(config).sort();
  return JSON.stringify(config, replacer, 0);
}

export function verifySealedConfig(opts: {
  configRaw: string;
  sealedRaw: string;
}): SealVerificationResult {
  const sealed = parseSealedFile(opts.sealedRaw);
  const expectedHashRaw =
    typeof (sealed as any)?.configHash === 'string' ? String((sealed as any).configHash).trim() : '';
  const expectedHashHex = normalizeHash(expectedHashRaw);

  if (!sealed || !expectedHashHex) {
    return {
      ok: false,
      format: 'legacy-v1',
      expectedHashRaw,
      expectedHashHex,
      actualHashHex: '',
      signaturePresent: false,
      signatureOk: null,
      error: 'Invalid sealed.json (expected a JSON object with non-empty configHash).',
    };
  }

  const isV2 =
    typeof (sealed as any)?.format === 'string' &&
    String((sealed as any).format).trim() === 'wunderland.sealed.v2';

  let actualHashHex = '';
  try {
    if (isV2) {
      const canonical = canonicalizeJsonString(opts.configRaw).canonical;
      actualHashHex = sha256HexUtf8(canonical);
    } else {
      // Legacy v1 canonicalization: used a replacer array which unintentionally drops nested keys.
      // We preserve this here only for backward-compatible verification.
      const canonicalLegacy = legacyCanonicalizeConfig(opts.configRaw);
      actualHashHex = sha256HexUtf8(canonicalLegacy);
    }
  } catch (err) {
    return {
      ok: false,
      format: isV2 ? 'wunderland.sealed.v2' : 'legacy-v1',
      expectedHashRaw,
      expectedHashHex,
      actualHashHex,
      signaturePresent: false,
      signatureOk: null,
      error: err instanceof Error ? err.message : 'Failed to canonicalize config',
    };
  }

  const hashOk = expectedHashHex.toLowerCase() === actualHashHex.toLowerCase();
  if (!hashOk) {
    return {
      ok: false,
      format: isV2 ? 'wunderland.sealed.v2' : 'legacy-v1',
      expectedHashRaw,
      expectedHashHex,
      actualHashHex,
      signaturePresent: Boolean((sealed as any)?.signature),
      signatureOk: null,
      error: 'Config hash mismatch (agent.config.json has changed since sealing).',
    };
  }

  const signature = (sealed as any)?.signature as SealSignature | null | undefined;
  if (signature && signature.scheme === 'ed25519') {
    const sigOk = verifySealSignature({ configHashHex: expectedHashHex, signature });
    if (!sigOk) {
      return {
        ok: false,
        format: isV2 ? 'wunderland.sealed.v2' : 'legacy-v1',
        expectedHashRaw,
        expectedHashHex,
        actualHashHex,
        signaturePresent: true,
        signatureOk: false,
        error: 'Signature invalid (sealed.json may be tampered or wrong key).',
      };
    }
    return {
      ok: true,
      format: isV2 ? 'wunderland.sealed.v2' : 'legacy-v1',
      expectedHashRaw,
      expectedHashHex,
      actualHashHex,
      signaturePresent: true,
      signatureOk: true,
    };
  }

  return {
    ok: true,
    format: isV2 ? 'wunderland.sealed.v2' : 'legacy-v1',
    expectedHashRaw,
    expectedHashHex,
    actualHashHex,
    signaturePresent: false,
    signatureOk: null,
    warning: 'No signature present (hash-only verification).',
  };
}
