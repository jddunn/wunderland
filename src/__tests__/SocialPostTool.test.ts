/**
 * @fileoverview Tests for SocialPostTool
 * @module wunderland/__tests__/SocialPostTool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocialPostTool } from '../tools/SocialPostTool.js';
import { InputManifestBuilder } from '../social/InputManifest.js';
import { SignedOutputVerifier } from '../security/SignedOutputVerifier.js';
import type { InputManifest, StimulusEvent } from '../social/types.js';

function createTestStimulus(): StimulusEvent {
  return {
    eventId: 'evt-123',
    type: 'world_feed',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'world_feed',
      headline: 'Test headline',
      category: 'technology',
      sourceName: 'Reuters',
    },
    priority: 'normal',
    source: { providerId: 'reuters', verified: true },
  };
}

describe('SocialPostTool', () => {
  let verifier: SignedOutputVerifier;
  let storageCallback: ReturnType<typeof vi.fn>;
  let tool: SocialPostTool;

  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'test-secret-for-social-post';
    verifier = new SignedOutputVerifier();
    storageCallback = vi.fn().mockResolvedValue(undefined);
    tool = new SocialPostTool(verifier, storageCallback);
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  function buildValidManifest(seedId = 'seed-123'): InputManifest {
    const builder = new InputManifestBuilder(seedId, verifier);
    builder.recordStimulus(createTestStimulus());
    builder.recordProcessingStep('OBSERVER', 'Accepted');
    builder.recordProcessingStep('WRITER', 'Drafted', 'model-1');
    return builder.build();
  }

  describe('Static properties', () => {
    it('should have correct TOOL_ID', () => {
      expect(SocialPostTool.TOOL_ID).toBe('social_post');
    });

    it('should return tool definition', () => {
      const def = SocialPostTool.getToolDefinition();
      expect(def.toolId).toBe('social_post');
      expect(def.name).toBe('Social Post');
      expect(def.category).toBe('communication');
      expect(def.riskTier).toBe(2);
    });
  });

  describe('publish', () => {
    it('should publish a valid post', async () => {
      const manifest = buildValidManifest();
      const result = await tool.publish({
        seedId: 'seed-123',
        content: 'My autonomous observation about technology.',
        manifest,
      });

      expect(result.success).toBe(true);
      expect(result.postId).toBeDefined();
      expect(result.publishedAt).toBeDefined();
      expect(storageCallback).toHaveBeenCalledTimes(1);
    });

    it('should reject empty content', async () => {
      const manifest = buildValidManifest();
      const result = await tool.publish({
        seedId: 'seed-123',
        content: '',
        manifest,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject whitespace-only content', async () => {
      const manifest = buildValidManifest();
      const result = await tool.publish({
        seedId: 'seed-123',
        content: '   ',
        manifest,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject seedId mismatch', async () => {
      const manifest = buildValidManifest('seed-123');
      const result = await tool.publish({
        seedId: 'different-seed',
        content: 'Some content',
        manifest,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('mismatch');
    });

    it('should reject manifest with humanIntervention=true', async () => {
      const manifest = buildValidManifest();
      (manifest as any).humanIntervention = true;

      const result = await tool.publish({
        seedId: 'seed-123',
        content: 'Some content',
        manifest,
      });

      expect(result.success).toBe(false);
      expect(result.validationErrors).toBeDefined();
      expect(result.validationErrors!.some(e => e.includes('HUMAN_INTERVENTION'))).toBe(true);
    });

    it('should reject manifest without signature', async () => {
      const manifest = buildValidManifest();
      manifest.runtimeSignature = '';

      const result = await tool.publish({
        seedId: 'seed-123',
        content: 'Some content',
        manifest,
      });

      expect(result.success).toBe(false);
      expect(result.validationErrors).toBeDefined();
    });

    it('should handle storage failure gracefully', async () => {
      storageCallback.mockRejectedValueOnce(new Error('Database down'));
      const manifest = buildValidManifest();

      const result = await tool.publish({
        seedId: 'seed-123',
        content: 'Valid content',
        manifest,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Storage failed');
    });

    it('should include validation warnings in successful result', async () => {
      const manifest = buildValidManifest();
      // Set old timestamp to trigger stale warning
      manifest.stimulus.timestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const result = await tool.publish({
        seedId: 'seed-123',
        content: 'Valid content',
        manifest,
      });

      expect(result.success).toBe(true);
      expect(result.validationWarnings).toBeDefined();
      expect(result.validationWarnings!.some(w => w.includes('STALE'))).toBe(true);
    });

    it('should set correct post fields', async () => {
      const manifest = buildValidManifest();
      await tool.publish({
        seedId: 'seed-123',
        content: 'Post content',
        manifest,
        replyToPostId: 'parent-post',
        agentLevel: 3,
      });

      const storedPost = storageCallback.mock.calls[0][0];
      expect(storedPost.seedId).toBe('seed-123');
      expect(storedPost.content).toBe('Post content');
      expect(storedPost.status).toBe('published');
      expect(storedPost.replyToPostId).toBe('parent-post');
      expect(storedPost.agentLevelAtPost).toBe(3);
      expect(storedPost.engagement.likes).toBe(0);
    });
  });
});
