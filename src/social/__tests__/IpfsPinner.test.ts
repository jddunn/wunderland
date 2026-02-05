/**
 * @fileoverview Tests for IpfsPinner — IPFS raw block pinning
 * @module @framers/wunderland/social/__tests__/IpfsPinner.test
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { IpfsPinner, PinningError } from '../IpfsPinner.js';

describe('IpfsPinner', () => {
  describe('cidFromHash', () => {
    it('should generate valid CIDv1 from SHA-256 hash', () => {
      // Known test vector
      const content = Buffer.from('hello world');
      const hash = createHash('sha256').update(content).digest('hex');
      const cid = IpfsPinner.cidFromHash(hash);

      // CIDv1 raw blocks start with 'b' (base32lower) followed by afkrei
      expect(cid).toMatch(/^b[a-z2-7]+$/);
      expect(cid.startsWith('bafkrei')).toBe(true);
    });

    it('should produce consistent CIDs for same hash', () => {
      const hash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'; // sha256('hello world')
      const cid1 = IpfsPinner.cidFromHash(hash);
      const cid2 = IpfsPinner.cidFromHash(hash);

      expect(cid1).toBe(cid2);
    });

    it('should produce different CIDs for different hashes', () => {
      const hash1 = createHash('sha256').update('content A').digest('hex');
      const hash2 = createHash('sha256').update('content B').digest('hex');

      const cid1 = IpfsPinner.cidFromHash(hash1);
      const cid2 = IpfsPinner.cidFromHash(hash2);

      expect(cid1).not.toBe(cid2);
    });

    it('should reject invalid hash format', () => {
      // Too short
      expect(() => IpfsPinner.cidFromHash('abc123')).toThrow('Invalid SHA-256 hash');

      // Too long
      expect(() =>
        IpfsPinner.cidFromHash('a'.repeat(65)),
      ).toThrow('Invalid SHA-256 hash');

      // Non-hex characters
      expect(() =>
        IpfsPinner.cidFromHash('g' + 'a'.repeat(63)),
      ).toThrow('Invalid SHA-256 hash');

      // Empty
      expect(() => IpfsPinner.cidFromHash('')).toThrow('Invalid SHA-256 hash');
    });

    it('should handle uppercase hex', () => {
      const hash =
        'B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9';
      const cid = IpfsPinner.cidFromHash(hash);

      expect(cid).toMatch(/^bafkrei/);
    });
  });

  describe('computeCid', () => {
    it('should compute CID directly from content', () => {
      const content = Buffer.from('test content');
      const cid = IpfsPinner.computeCid(content);

      // Verify it matches the hash-based computation
      const hash = createHash('sha256').update(content).digest('hex');
      const expectedCid = IpfsPinner.cidFromHash(hash);

      expect(cid).toBe(expectedCid);
    });

    it('should handle empty content', () => {
      const content = Buffer.from('');
      const cid = IpfsPinner.computeCid(content);

      // Empty content has a known hash
      const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const expectedCid = IpfsPinner.cidFromHash(emptyHash);

      expect(cid).toBe(expectedCid);
    });

    it('should handle binary content', () => {
      const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const cid = IpfsPinner.computeCid(content);

      expect(cid).toMatch(/^bafkrei/);
    });

    it('should handle large content', () => {
      const content = Buffer.alloc(10000, 'x');
      const cid = IpfsPinner.computeCid(content);

      expect(cid).toMatch(/^bafkrei/);
    });
  });

  describe('verifyCid', () => {
    it('should return true for matching CID and hash', () => {
      const content = Buffer.from('verify me');
      const hash = createHash('sha256').update(content).digest('hex');
      const cid = IpfsPinner.cidFromHash(hash);

      expect(IpfsPinner.verifyCid(cid, hash)).toBe(true);
    });

    it('should return false for mismatched CID and hash', () => {
      const content1 = Buffer.from('content 1');
      const content2 = Buffer.from('content 2');

      const hash1 = createHash('sha256').update(content1).digest('hex');
      const cid2 = IpfsPinner.computeCid(content2);

      expect(IpfsPinner.verifyCid(cid2, hash1)).toBe(false);
    });

    it('should return false for invalid hash', () => {
      const cid = IpfsPinner.computeCid(Buffer.from('test'));

      expect(IpfsPinner.verifyCid(cid, 'invalid')).toBe(false);
    });

    it('should return false for invalid CID', () => {
      const hash = createHash('sha256').update('test').digest('hex');

      expect(IpfsPinner.verifyCid('not-a-cid', hash)).toBe(false);
    });
  });

  describe('getGatewayUrl', () => {
    it('should use default gateway when not configured', () => {
      const pinner = new IpfsPinner({ provider: 'local' });
      const cid = IpfsPinner.computeCid(Buffer.from('test'));

      const url = pinner.getGatewayUrl(cid);

      expect(url).toBe(`https://ipfs.io/ipfs/${cid}`);
    });

    it('should use configured gateway', () => {
      const pinner = new IpfsPinner({
        provider: 'local',
        gatewayUrl: 'https://cloudflare-ipfs.com',
      });
      const cid = IpfsPinner.computeCid(Buffer.from('test'));

      const url = pinner.getGatewayUrl(cid);

      expect(url).toBe(`https://cloudflare-ipfs.com/ipfs/${cid}`);
    });

    it('should handle gateway URL without trailing slash', () => {
      const pinner = new IpfsPinner({
        provider: 'local',
        gatewayUrl: 'https://gateway.example.com',
      });
      const cid = 'bafkreitest';

      const url = pinner.getGatewayUrl(cid);

      expect(url).toBe('https://gateway.example.com/ipfs/bafkreitest');
    });
  });

  describe('constructor', () => {
    it('should accept local provider config', () => {
      const pinner = new IpfsPinner({
        provider: 'local',
        endpoint: 'http://localhost:5001',
      });

      expect(pinner).toBeDefined();
    });

    it('should accept pinata provider config', () => {
      const pinner = new IpfsPinner({
        provider: 'pinata',
        apiKey: 'test-api-key',
      });

      expect(pinner).toBeDefined();
    });

    it('should accept web3storage provider config', () => {
      const pinner = new IpfsPinner({
        provider: 'web3storage',
        apiKey: 'test-api-key',
        gatewayUrl: 'https://w3s.link',
      });

      expect(pinner).toBeDefined();
    });

    it('should accept nft.storage provider config', () => {
      const pinner = new IpfsPinner({
        provider: 'nft.storage',
        apiKey: 'test-api-key',
      });

      expect(pinner).toBeDefined();
    });
  });

  describe('PinningError', () => {
    it('should include provider information', () => {
      const error = new PinningError('test error', 'pinata');

      expect(error.message).toBe('test error');
      expect(error.provider).toBe('pinata');
      expect(error.name).toBe('PinningError');
    });
  });

  describe('CID format verification', () => {
    it('should produce CID with correct structure', () => {
      const content = Buffer.from('test');
      const cid = IpfsPinner.computeCid(content);

      // CIDv1 raw format:
      // - 'b' prefix for base32lower
      // - 'afkrei' is the base32 encoding of: 0x01 (version) + 0x55 (raw codec)
      expect(cid.startsWith('bafkrei')).toBe(true);

      // Total CID should be deterministic length
      // base32(1 + 1 + 1 + 1 + 32) = base32(36 bytes) = 58 chars + 'b' prefix = 59 chars
      expect(cid.length).toBe(59);
    });

    it('should be case-insensitive for hash input', () => {
      const hashLower = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const hashUpper = 'B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9';

      const cidLower = IpfsPinner.cidFromHash(hashLower);
      const cidUpper = IpfsPinner.cidFromHash(hashUpper);

      expect(cidLower).toBe(cidUpper);
    });
  });
});
