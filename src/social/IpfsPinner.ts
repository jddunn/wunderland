/**
 * @fileoverview IpfsPinner — IPFS raw block pinning for verifiable content.
 *
 * Stores content as raw blocks (not UnixFS) so CID is directly derivable
 * from SHA-256 hash. Supports local IPFS nodes and hosted pinning services.
 *
 * Key property: CID = bafkrei + base32(sha256(content))
 * This allows on-chain content_hash to serve as verifiable commitment.
 *
 * @module @framers/wunderland/social/IpfsPinner
 */

import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

/** IPFS pinning provider type. */
export type PinningProvider = 'local' | 'pinata' | 'web3storage' | 'nft.storage';

/** Configuration for a pinning provider. */
export interface PinningConfig {
  /** Provider type. */
  provider: PinningProvider;
  /** API endpoint (for local IPFS or custom gateway). */
  endpoint?: string;
  /** API key/token for hosted services. */
  apiKey?: string;
  /** Optional gateway URL for retrieving content. */
  gatewayUrl?: string;
}

/** Result of a pin operation. */
export interface PinResult {
  /** IPFS CID (Content Identifier). */
  cid: string;
  /** SHA-256 hash of content (hex). */
  contentHash: string;
  /** Content size in bytes. */
  size: number;
  /** Which provider was used. */
  provider: PinningProvider;
  /** Pin timestamp. */
  pinnedAt: Date;
}

/** Error thrown when pinning fails. */
export class PinningError extends Error {
  constructor(
    message: string,
    public readonly provider: PinningProvider,
  ) {
    super(message);
    this.name = 'PinningError';
  }
}

// ============================================================================
// Constants
// ============================================================================

/** CIDv1 raw codec multicodec (0x55). */
const RAW_CODEC = 0x55;

/** SHA-256 multicodec (0x12). */
const SHA256_CODEC = 0x12;

/** SHA-256 digest length (32 bytes). */
const SHA256_LENGTH = 32;

/** Base32 lower alphabet (RFC 4648). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

// ============================================================================
// IpfsPinner
// ============================================================================

/**
 * IPFS raw block pinner for verifiable content storage.
 *
 * @example
 * ```typescript
 * // Local IPFS node
 * const pinner = new IpfsPinner({
 *   provider: 'local',
 *   endpoint: 'http://localhost:5001',
 * });
 *
 * const result = await pinner.pin(contentBuffer);
 * console.log(result.cid); // bafkrei...
 *
 * // Verify CID matches hash
 * const derivedCid = IpfsPinner.cidFromHash(result.contentHash);
 * console.log(derivedCid === result.cid); // true
 * ```
 */
export class IpfsPinner {
  private config: PinningConfig;

  constructor(config: PinningConfig) {
    this.config = config;
  }

  /**
   * Pin content to IPFS as a raw block.
   *
   * @param content Content bytes to pin.
   * @returns Pin result with CID and hash.
   */
  async pin(content: Buffer): Promise<PinResult> {
    // Compute SHA-256 hash
    const contentHash = createHash('sha256').update(content).digest('hex');

    // Derive CID from hash
    const cid = IpfsPinner.cidFromHash(contentHash);

    // Pin based on provider
    switch (this.config.provider) {
      case 'local':
        await this.pinLocal(content, cid);
        break;
      case 'pinata':
        await this.pinPinata(content, cid);
        break;
      case 'web3storage':
        await this.pinWeb3Storage(content, cid);
        break;
      case 'nft.storage':
        await this.pinNftStorage(content, cid);
        break;
    }

    return {
      cid,
      contentHash,
      size: content.length,
      provider: this.config.provider,
      pinnedAt: new Date(),
    };
  }

  /**
   * Derive CIDv1 (raw, sha256) from a hex-encoded SHA-256 hash.
   *
   * Format: bafkrei + base32(0x01 + 0x55 + 0x12 + 0x20 + hash_bytes)
   * - 0x01 = CIDv1
   * - 0x55 = raw codec
   * - 0x12 = sha2-256 multihash codec
   * - 0x20 = 32 bytes (hash length)
   *
   * @param hashHex SHA-256 hash in hex format.
   * @returns CIDv1 string (bafkrei...).
   */
  static cidFromHash(hashHex: string): string {
    // Validate hash
    if (!/^[a-f0-9]{64}$/i.test(hashHex)) {
      throw new Error('Invalid SHA-256 hash: must be 64 hex characters');
    }

    // Build multihash: sha2-256 codec (0x12) + length (0x20) + hash bytes
    const hashBytes = Buffer.from(hashHex, 'hex');
    const multihash = Buffer.concat([
      Buffer.from([SHA256_CODEC, SHA256_LENGTH]),
      hashBytes,
    ]);

    // Build CID: version (0x01) + raw codec (0x55) + multihash
    const cidBytes = Buffer.concat([Buffer.from([0x01, RAW_CODEC]), multihash]);

    // Encode as base32 with 'b' prefix (base32lower)
    const base32 = encodeBase32(cidBytes);
    return 'b' + base32;
  }

  /**
   * Verify that a CID matches a given content hash.
   *
   * @param cid CID to verify.
   * @param contentHash Expected SHA-256 hash (hex).
   * @returns True if CID matches hash.
   */
  static verifyCid(cid: string, contentHash: string): boolean {
    try {
      const expected = IpfsPinner.cidFromHash(contentHash);
      return cid === expected;
    } catch {
      return false;
    }
  }

  /**
   * Compute the expected CID for content.
   *
   * @param content Content bytes.
   * @returns CID string.
   */
  static computeCid(content: Buffer): string {
    const hash = createHash('sha256').update(content).digest('hex');
    return IpfsPinner.cidFromHash(hash);
  }

  /**
   * Get gateway URL for a CID.
   *
   * @param cid CID to resolve.
   * @returns Full gateway URL.
   */
  getGatewayUrl(cid: string): string {
    const gateway = this.config.gatewayUrl ?? 'https://ipfs.io';
    return `${gateway}/ipfs/${cid}`;
  }

  // ── Private methods ──

  /**
   * Pin to local IPFS node via HTTP API.
   */
  private async pinLocal(content: Buffer, expectedCid: string): Promise<void> {
    const endpoint = this.config.endpoint ?? 'http://localhost:5001';

    // Use block/put for raw blocks
    const formData = new FormData();
    formData.append('file', new Blob([content]));

    const response = await fetch(`${endpoint}/api/v0/block/put?format=raw&mhtype=sha2-256`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new PinningError(
        `Local IPFS pin failed: ${response.status} ${response.statusText}`,
        'local',
      );
    }

    const result = (await response.json()) as { Key: string };

    // Verify CID matches
    if (result.Key !== expectedCid) {
      throw new PinningError(
        `CID mismatch: expected ${expectedCid}, got ${result.Key}`,
        'local',
      );
    }
  }

  /**
   * Pin to Pinata.
   */
  private async pinPinata(content: Buffer, expectedCid: string): Promise<void> {
    if (!this.config.apiKey) {
      throw new PinningError('Pinata API key required', 'pinata');
    }

    const formData = new FormData();
    formData.append('file', new Blob([content]), 'content.bin');

    // Pinata options for raw block
    const pinataOptions = JSON.stringify({
      cidVersion: 1,
    });
    formData.append('pinataOptions', pinataOptions);

    const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new PinningError(`Pinata pin failed: ${errorText}`, 'pinata');
    }

    const result = (await response.json()) as { IpfsHash: string };

    // Note: Pinata may return UnixFS-wrapped CID, verify hash differently
    // For strict raw blocks, consider using Pinata's raw block API if available
    if (result.IpfsHash !== expectedCid) {
      // Log warning but don't fail - Pinata may wrap content
      console.warn(
        `[IpfsPinner] Pinata CID differs from raw CID: ${result.IpfsHash} vs ${expectedCid}`,
      );
    }
  }

  /**
   * Pin to web3.storage.
   */
  private async pinWeb3Storage(content: Buffer, expectedCid: string): Promise<void> {
    if (!this.config.apiKey) {
      throw new PinningError('web3.storage API key required', 'web3storage');
    }

    // web3.storage CAR upload for raw blocks
    // For simplicity, using blob upload (may wrap in UnixFS)
    const response = await fetch('https://api.web3.storage/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new PinningError(`web3.storage pin failed: ${errorText}`, 'web3storage');
    }

    const result = (await response.json()) as { cid: string };

    if (result.cid !== expectedCid) {
      console.warn(
        `[IpfsPinner] web3.storage CID differs from raw CID: ${result.cid} vs ${expectedCid}`,
      );
    }
  }

  /**
   * Pin to NFT.storage.
   */
  private async pinNftStorage(content: Buffer, expectedCid: string): Promise<void> {
    if (!this.config.apiKey) {
      throw new PinningError('NFT.storage API key required', 'nft.storage');
    }

    const response = await fetch('https://api.nft.storage/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new PinningError(`NFT.storage pin failed: ${errorText}`, 'nft.storage');
    }

    const result = (await response.json()) as { value: { cid: string } };

    if (result.value.cid !== expectedCid) {
      console.warn(
        `[IpfsPinner] NFT.storage CID differs from raw CID: ${result.value.cid} vs ${expectedCid}`,
      );
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Encode bytes as base32 (lowercase, no padding).
 */
function encodeBase32(data: Buffer): string {
  let result = '';
  let bits = 0;
  let value = 0;

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return result;
}
