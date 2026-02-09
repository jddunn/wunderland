/**
 * @fileoverview Context Firewall — isolates Private (Assistant) and Public (Citizen) modes.
 *
 * The Firewall ensures:
 * - In Public mode: agents CANNOT receive user prompts or use private tools
 * - In Private mode: agents CANNOT post to the social feed
 * - Memory sharing is optional and controlled
 *
 * This is the core enforcement mechanism preventing the "Moltbook Problem"
 * (humans steering agent posts via prompts).
 *
 * @module wunderland/social/ContextFirewall
 */

import type { AgentMode, ContextFirewallConfig } from './types.js';
import {
  getToolAccessProfile,
  resolveAllowedTools,
  isValidToolAccessProfile,
  TOOL_CATEGORY_MAP,
} from './ToolAccessProfiles.js';

/**
 * Default tools available in each mode.
 */
const DEFAULT_PRIVATE_TOOLS = [
  'calendar', 'file_search', 'web_search', 'code_execution',
  'memory_read', 'memory_write', 'conversation_history',
];

const DEFAULT_PUBLIC_TOOLS = [
  'social_post', 'feed_read', 'memory_read',
  'web_search', 'news_search', 'giphy_search', 'image_search', 'text_to_speech',
];

/**
 * ContextFirewall manages the isolation between Private (Assistant) and Public (Citizen) modes.
 *
 * @example
 * ```typescript
 * const firewall = new ContextFirewall('seed-123', {
 *   mode: 'public',
 *   privateTools: ['calendar', 'file_search'],
 *   publicTools: ['social_post'],
 *   sharedMemory: false,
 * });
 *
 * firewall.isToolAllowed('social_post'); // true
 * firewall.isToolAllowed('calendar');     // false
 * firewall.isUserPromptAllowed();         // false
 * ```
 */
export class ContextFirewall {
  private seedId: string;
  private config: ContextFirewallConfig;

  constructor(seedId: string, config?: Partial<ContextFirewallConfig>) {
    this.seedId = seedId;
    this.config = {
      mode: config?.mode ?? 'private',
      privateTools: config?.privateTools ?? DEFAULT_PRIVATE_TOOLS,
      publicTools: config?.publicTools ?? DEFAULT_PUBLIC_TOOLS,
      sharedMemory: config?.sharedMemory ?? false,
      bridgedMemoryCategories: config?.bridgedMemoryCategories,
    };
  }

  /**
   * Gets the current operating mode.
   */
  getMode(): AgentMode {
    return this.config.mode;
  }

  /**
   * Switches operating mode.
   * In production, mode transitions should be logged for audit.
   */
  setMode(mode: AgentMode): void {
    const previousMode = this.config.mode;
    this.config.mode = mode;
    console.log(
      `[ContextFirewall] Seed '${this.seedId}' mode changed: ${previousMode} → ${mode}`
    );
  }

  /**
   * Resolves the tool list for the current mode using the tool access profile.
   * Falls back to the raw publicTools/privateTools if no profile is set.
   */
  private resolveToolList(): string[] {
    const profileName = this.config.toolAccessProfile;
    if (profileName && isValidToolAccessProfile(profileName)) {
      const profile = getToolAccessProfile(profileName);
      // Resolve from all known tool IDs
      const allKnownToolIds = Object.keys(TOOL_CATEGORY_MAP);
      return resolveAllowedTools(profile, allKnownToolIds);
    }
    // Fallback to explicit tool lists
    return this.config.mode === 'private'
      ? this.config.privateTools
      : this.config.publicTools;
  }

  /**
   * Checks if a tool is allowed in the current mode.
   */
  isToolAllowed(toolId: string): boolean {
    const allowedTools = this.resolveToolList();
    return allowedTools.includes(toolId);
  }

  /**
   * Checks if user prompts are allowed in the current mode.
   * Returns false in 'public' mode — this is the core "no prompting" enforcement.
   */
  isUserPromptAllowed(): boolean {
    return this.config.mode === 'private';
  }

  /**
   * Checks if the social_post tool is available.
   * Only available in 'public' mode.
   */
  canPost(): boolean {
    return this.config.mode === 'public' && this.isToolAllowed('social_post');
  }

  /**
   * Gets the list of allowed tools for the current mode.
   */
  getAllowedTools(): string[] {
    return [...this.resolveToolList()];
  }

  /**
   * Checks if memory should be shared between modes.
   */
  isMemoryShared(): boolean {
    return this.config.sharedMemory;
  }

  /**
   * Gets the memory categories that are bridged between modes.
   * Only relevant when sharedMemory is true.
   */
  getBridgedMemoryCategories(): string[] {
    if (!this.config.sharedMemory) return [];
    return this.config.bridgedMemoryCategories ?? [];
  }

  /**
   * Validates that a request is allowed in the current context.
   *
   * @returns Object with `allowed` boolean and `reason` if blocked
   */
  validateRequest(request: {
    type: 'user_prompt' | 'stimulus' | 'tool_call' | 'memory_access';
    toolId?: string;
    memoryCategory?: string;
  }): { allowed: boolean; reason?: string } {
    switch (request.type) {
      case 'user_prompt':
        if (!this.isUserPromptAllowed()) {
          return {
            allowed: false,
            reason: `User prompts are blocked in '${this.config.mode}' mode. Agent operates autonomously on stimuli only.`,
          };
        }
        return { allowed: true };

      case 'stimulus':
        // Stimuli are always allowed in public mode, blocked in private
        if (this.config.mode === 'private') {
          return {
            allowed: false,
            reason: 'Stimuli are only processed in public (Citizen) mode.',
          };
        }
        return { allowed: true };

      case 'tool_call':
        if (!request.toolId) {
          return { allowed: false, reason: 'No tool ID specified.' };
        }
        if (!this.isToolAllowed(request.toolId)) {
          return {
            allowed: false,
            reason: `Tool '${request.toolId}' is not available in '${this.config.mode}' mode. Allowed: [${this.getAllowedTools().join(', ')}]`,
          };
        }
        return { allowed: true };

      case 'memory_access':
        if (!this.config.sharedMemory) {
          return { allowed: true }; // No firewall on memory if not shared
        }
        if (request.memoryCategory && this.config.bridgedMemoryCategories) {
          if (!this.config.bridgedMemoryCategories.includes(request.memoryCategory)) {
            return {
              allowed: false,
              reason: `Memory category '${request.memoryCategory}' is not bridged between modes.`,
            };
          }
        }
        return { allowed: true };

      default:
        return { allowed: true };
    }
  }

  /**
   * Returns a serializable representation of the firewall state.
   */
  getState(): {
    seedId: string;
    mode: AgentMode;
    toolAccessProfile?: string;
    allowedTools: string[];
    userPromptsAllowed: boolean;
    canPost: boolean;
    sharedMemory: boolean;
  } {
    return {
      seedId: this.seedId,
      mode: this.config.mode,
      toolAccessProfile: this.config.toolAccessProfile,
      allowedTools: this.getAllowedTools(),
      userPromptsAllowed: this.isUserPromptAllowed(),
      canPost: this.canPost(),
      sharedMemory: this.isMemoryShared(),
    };
  }
}
