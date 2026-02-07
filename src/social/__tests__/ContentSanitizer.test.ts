/**
 * @fileoverview Tests for ContentSanitizer — SSRF-safe content fetching
 * @module wunderland/social/__tests__/ContentSanitizer.test
 */

import { describe, it, expect } from 'vitest';
import { ContentSanitizer, SSRFError, ContentError } from '../ContentSanitizer.js';

describe('ContentSanitizer', () => {
  const sanitizer = new ContentSanitizer();

  describe('validateUrl', () => {
    describe('should allow', () => {
      it('valid HTTPS URLs', () => {
        expect(() => sanitizer.validateUrl('https://example.com')).not.toThrow();
        expect(() => sanitizer.validateUrl('https://example.com/path?query=1')).not.toThrow();
        expect(() => sanitizer.validateUrl('https://sub.domain.example.com')).not.toThrow();
      });

      it('valid HTTP URLs', () => {
        expect(() => sanitizer.validateUrl('http://example.com')).not.toThrow();
      });

      it('public IP addresses', () => {
        expect(() => sanitizer.validateUrl('https://8.8.8.8')).not.toThrow();
        expect(() => sanitizer.validateUrl('https://1.2.3.4')).not.toThrow();
      });
    });

    describe('should block localhost', () => {
      it('localhost hostname', () => {
        expect(() => sanitizer.validateUrl('http://localhost')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('https://localhost:3000')).toThrow(SSRFError);
      });

      it('localhost subdomains', () => {
        expect(() => sanitizer.validateUrl('http://foo.localhost')).toThrow(SSRFError);
      });

      it('127.0.0.1', () => {
        expect(() => sanitizer.validateUrl('http://127.0.0.1')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://127.0.0.1:8080')).toThrow(SSRFError);
      });

      it('::1 (IPv6 loopback)', () => {
        expect(() => sanitizer.validateUrl('http://[::1]')).toThrow(SSRFError);
      });
    });

    describe('should block private IPs', () => {
      it('10.x.x.x range', () => {
        expect(() => sanitizer.validateUrl('http://10.0.0.1')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://10.255.255.255')).toThrow(SSRFError);
      });

      it('172.16-31.x.x range', () => {
        expect(() => sanitizer.validateUrl('http://172.16.0.1')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://172.31.255.255')).toThrow(SSRFError);
        // 172.32.x.x is NOT private
        expect(() => sanitizer.validateUrl('http://172.32.0.1')).not.toThrow();
      });

      it('192.168.x.x range', () => {
        expect(() => sanitizer.validateUrl('http://192.168.0.1')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://192.168.1.100')).toThrow(SSRFError);
      });
    });

    describe('should block cloud metadata endpoints', () => {
      it('AWS/GCP metadata IP', () => {
        expect(() => sanitizer.validateUrl('http://169.254.169.254')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://169.254.169.254/latest/meta-data')).toThrow(SSRFError);
      });

      it('GCP metadata hostname', () => {
        expect(() => sanitizer.validateUrl('http://metadata.google.internal')).toThrow(SSRFError);
      });
    });

    describe('should block link-local addresses', () => {
      it('169.254.x.x range', () => {
        expect(() => sanitizer.validateUrl('http://169.254.0.1')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://169.254.255.255')).toThrow(SSRFError);
      });
    });

    describe('should block special addresses', () => {
      it('0.0.0.0', () => {
        expect(() => sanitizer.validateUrl('http://0.0.0.0')).toThrow(SSRFError);
      });

      it('multicast (224-239.x.x.x)', () => {
        expect(() => sanitizer.validateUrl('http://224.0.0.1')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://239.255.255.255')).toThrow(SSRFError);
      });

      it('carrier-grade NAT (100.64-127.x.x)', () => {
        expect(() => sanitizer.validateUrl('http://100.64.0.1')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://100.127.255.255')).toThrow(SSRFError);
        // 100.63.x.x is NOT carrier-grade NAT
        expect(() => sanitizer.validateUrl('http://100.63.0.1')).not.toThrow();
      });
    });

    describe('should block non-HTTP protocols', () => {
      it('file:// protocol', () => {
        expect(() => sanitizer.validateUrl('file:///etc/passwd')).toThrow(SSRFError);
      });

      it('ftp:// protocol', () => {
        expect(() => sanitizer.validateUrl('ftp://ftp.example.com')).toThrow(SSRFError);
      });

      it('javascript: protocol', () => {
        expect(() => sanitizer.validateUrl('javascript:alert(1)')).toThrow(SSRFError);
      });

      it('data: protocol', () => {
        expect(() => sanitizer.validateUrl('data:text/html,<script>alert(1)</script>')).toThrow(SSRFError);
      });
    });

    describe('should block internal hostname patterns', () => {
      it('internal hostnames', () => {
        expect(() => sanitizer.validateUrl('http://internal.company.com')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://intranet.corp.local')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://admin.private.net')).toThrow(SSRFError);
      });

      it('kubernetes hostnames', () => {
        expect(() => sanitizer.validateUrl('http://kubernetes.default.svc')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('http://k8s.cluster.local')).toThrow(SSRFError);
      });
    });

    describe('should handle invalid URLs', () => {
      it('malformed URLs', () => {
        expect(() => sanitizer.validateUrl('not-a-url')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('')).toThrow(SSRFError);
        expect(() => sanitizer.validateUrl('://missing-protocol')).toThrow(SSRFError);
      });
    });
  });

  describe('sanitizeText', () => {
    it('should normalize line endings', () => {
      const result = sanitizer.sanitizeText('line1\r\nline2\rline3\nline4');
      expect(result.content.toString()).toBe('line1\nline2\nline3\nline4');
    });

    it('should trim whitespace', () => {
      const result = sanitizer.sanitizeText('  hello world  ');
      expect(result.content.toString()).toBe('hello world');
    });

    it('should compute SHA-256 hash', () => {
      const result = sanitizer.sanitizeText('test content');
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should set content type to text/plain', () => {
      const result = sanitizer.sanitizeText('test');
      expect(result.contentType).toBe('text/plain');
    });

    it('should set fetchedAt timestamp', () => {
      const before = new Date();
      const result = sanitizer.sanitizeText('test');
      const after = new Date();

      expect(result.fetchedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.fetchedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should produce consistent hashes for same content', () => {
      const result1 = sanitizer.sanitizeText('identical content');
      const result2 = sanitizer.sanitizeText('identical content');
      expect(result1.contentHash).toBe(result2.contentHash);
    });

    it('should produce different hashes for different content', () => {
      const result1 = sanitizer.sanitizeText('content A');
      const result2 = sanitizer.sanitizeText('content B');
      expect(result1.contentHash).not.toBe(result2.contentHash);
    });
  });

  describe('HTML sanitization', () => {
    // Test sanitization logic via sanitizeText with HTML content
    // (The internal sanitizeHtml is tested indirectly through fetchAndSanitize)

    it('should handle empty content', () => {
      const result = sanitizer.sanitizeText('');
      expect(result.content.toString()).toBe('');
    });

    it('should handle unicode content', () => {
      const result = sanitizer.sanitizeText('Hello 世界 🌍');
      expect(result.content.toString()).toBe('Hello 世界 🌍');
    });

    it('should handle large content within limits', () => {
      const largeContent = 'x'.repeat(10000);
      const result = sanitizer.sanitizeText(largeContent);
      expect(result.contentLength).toBe(10000);
    });
  });

  describe('constructor', () => {
    it('should accept additional content types', () => {
      const customSanitizer = new ContentSanitizer(['application/pdf', 'image/png']);
      // The custom content types are stored internally - we can't test directly
      // but the sanitizer should not throw
      expect(customSanitizer).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle IPv6 unique local addresses', () => {
      expect(() => sanitizer.validateUrl('http://[fc00::1]')).toThrow(SSRFError);
      expect(() => sanitizer.validateUrl('http://[fd00::1]')).toThrow(SSRFError);
    });

    it('should handle IPv6 link-local addresses', () => {
      expect(() => sanitizer.validateUrl('http://[fe80::1]')).toThrow(SSRFError);
    });

    it('should handle documentation test IPs', () => {
      expect(() => sanitizer.validateUrl('http://192.0.2.1')).toThrow(SSRFError);
      expect(() => sanitizer.validateUrl('http://198.51.100.1')).toThrow(SSRFError);
      expect(() => sanitizer.validateUrl('http://203.0.113.1')).toThrow(SSRFError);
    });
  });
});
