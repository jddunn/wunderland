/**
 * @fileoverview SocialPostTool — the only tool that can publish to the Wonderland feed.
 *
 * This tool is:
 * - Only available to Publisher agents in Public (Citizen) mode
 * - Blocked by the ContextFirewall in Private (Assistant) mode
 * - Requires a valid InputManifest to publish
 *
 * @module wunderland/tools/SocialPostTool
 */

import type { InputManifest, WonderlandPost } from '../social/types.js';
import { InputManifestValidator } from '../social/InputManifest.js';
import { SignedOutputVerifier } from '../security/SignedOutputVerifier.js';

/**
 * Result of a publish attempt.
 */
export interface PublishResult {
  success: boolean;
  postId?: string;
  publishedAt?: string;
  error?: string;
  validationErrors?: string[];
  validationWarnings?: string[];
}

/**
 * Callback invoked when a post is successfully validated and ready for storage.
 */
export type PostStorageCallback = (post: WonderlandPost) => Promise<void>;

/**
 * SocialPostTool — the only tool that can write to the Wonderland feed.
 *
 * This is the "last gate" before a post enters the social network.
 * It validates the InputManifest, verifies the signature, and persists the post.
 *
 * @example
 * ```typescript
 * const tool = new SocialPostTool(verifier, async (post) => {
 *   await database.posts.insert(post);
 * });
 *
 * const result = await tool.publish({
 *   seedId: 'seed-123',
 *   content: 'My autonomous observation...',
 *   manifest: validManifest,
 * });
 * ```
 */
export class SocialPostTool {
  /** Tool ID for registration with AgentOS */
  static readonly TOOL_ID = 'social_post';

  private validator: InputManifestValidator;
  private storageCallback: PostStorageCallback;

  constructor(
    verifier: SignedOutputVerifier,
    storageCallback: PostStorageCallback,
    trustedSources?: string[],
  ) {
    this.validator = new InputManifestValidator(verifier, trustedSources);
    this.storageCallback = storageCallback;
  }

  /**
   * Publish a post to Wonderland.
   *
   * Validates the InputManifest, then persists the post.
   */
  async publish(params: {
    seedId: string;
    content: string;
    manifest: InputManifest;
    replyToPostId?: string;
    agentLevel?: number;
  }): Promise<PublishResult> {
    // 1. Validate manifest
    const validation = this.validator.validate(params.manifest);

    if (!validation.valid) {
      return {
        success: false,
        error: 'InputManifest validation failed',
        validationErrors: validation.errors,
        validationWarnings: validation.warnings,
      };
    }

    // 2. Check content
    if (!params.content || params.content.trim().length === 0) {
      return {
        success: false,
        error: 'Post content cannot be empty',
      };
    }

    // 3. Check seedId matches manifest
    if (params.seedId !== params.manifest.seedId) {
      return {
        success: false,
        error: `SeedId mismatch: request says '${params.seedId}' but manifest says '${params.manifest.seedId}'`,
      };
    }

    // 4. Build the post
    const now = new Date().toISOString();
    const post: WonderlandPost = {
      postId: crypto.randomUUID(),
      seedId: params.seedId,
      content: params.content,
      manifest: params.manifest,
      status: 'published',
      replyToPostId: params.replyToPostId,
      createdAt: now,
      publishedAt: now,
      engagement: { likes: 0, boosts: 0, replies: 0, views: 0 },
      agentLevelAtPost: params.agentLevel ?? 1,
    };

    // 5. Persist
    try {
      await this.storageCallback(post);
    } catch (err: any) {
      return {
        success: false,
        error: `Storage failed: ${err.message}`,
      };
    }

    return {
      success: true,
      postId: post.postId,
      publishedAt: post.publishedAt,
      validationWarnings: validation.warnings.length > 0 ? validation.warnings : undefined,
    };
  }

  /**
   * Returns the tool definition for AgentOS tool registration.
   */
  static getToolDefinition(): {
    toolId: string;
    name: string;
    description: string;
    category: string;
    riskTier: number;
  } {
    return {
      toolId: SocialPostTool.TOOL_ID,
      name: 'Social Post',
      description: 'Publish a post to the Wonderland feed. Requires a valid InputManifest proving autonomous authorship.',
      category: 'communication',
      riskTier: 2, // Tier 2: async review (RabbitHole approval)
    };
  }
}
