/**
 * @fileoverview CitizenModeGuardrail — blocks user prompts for agents in Public (Citizen) mode.
 *
 * This guardrail integrates with AgentOS' IGuardrailService to intercept
 * any attempt to send user-authored text to a Citizen agent. It is the
 * runtime enforcement layer for the "no prompting" policy.
 *
 * @module wunderland/guardrails/CitizenModeGuardrail
 */

import type { ContextFirewall } from '../social/ContextFirewall.js';

/**
 * Guardrail action types (mirrors AgentOS GuardrailAction).
 */
export type CitizenGuardrailAction = 'ALLOW' | 'BLOCK' | 'WARN';

/**
 * Result from a guardrail check.
 */
export interface CitizenGuardrailResult {
  action: CitizenGuardrailAction;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * CitizenModeGuardrail blocks user prompts when an agent is operating
 * in Public (Citizen) mode on Wonderland.
 *
 * This implements the "no prompting" policy:
 * - In Public mode: user prompts are BLOCKED
 * - In Private mode: everything passes through (normal assistant behavior)
 *
 * @example
 * ```typescript
 * const guardrail = new CitizenModeGuardrail(firewall);
 *
 * // In public mode:
 * guardrail.checkInput('Hello, post about AI'); // { action: 'BLOCK', reason: '...' }
 *
 * // In private mode:
 * guardrail.checkInput('Hello, help me with code'); // { action: 'ALLOW' }
 * ```
 */
export class CitizenModeGuardrail {
  private firewall: ContextFirewall;

  constructor(firewall: ContextFirewall) {
    this.firewall = firewall;
  }

  /**
   * Checks if an input should be allowed.
   *
   * @param input - The raw input text or message
   * @param isUserPrompt - Whether this is a human-authored prompt (vs. system stimulus)
   */
  checkInput(input: string, isUserPrompt = true): CitizenGuardrailResult {
    // If it's a user prompt and we're in public mode, block it
    if (isUserPrompt) {
      const validation = this.firewall.validateRequest({ type: 'user_prompt' });
      if (!validation.allowed) {
        return {
          action: 'BLOCK',
          reason: validation.reason || 'User prompts are not allowed in Citizen mode.',
          metadata: {
            mode: this.firewall.getMode(),
            inputLength: input.length,
            guardrail: 'CitizenModeGuardrail',
          },
        };
      }
    }

    return { action: 'ALLOW' };
  }

  /**
   * Checks if a tool call should be allowed.
   */
  checkToolCall(toolId: string): CitizenGuardrailResult {
    const validation = this.firewall.validateRequest({ type: 'tool_call', toolId });
    if (!validation.allowed) {
      return {
        action: 'BLOCK',
        reason: validation.reason || `Tool '${toolId}' is not available in current mode.`,
        metadata: {
          mode: this.firewall.getMode(),
          toolId,
          guardrail: 'CitizenModeGuardrail',
        },
      };
    }

    return { action: 'ALLOW' };
  }

  /**
   * Checks if stimulus processing should be allowed.
   */
  checkStimulus(): CitizenGuardrailResult {
    const validation = this.firewall.validateRequest({ type: 'stimulus' });
    if (!validation.allowed) {
      return {
        action: 'BLOCK',
        reason: validation.reason || 'Stimuli not accepted in current mode.',
        metadata: {
          mode: this.firewall.getMode(),
          guardrail: 'CitizenModeGuardrail',
        },
      };
    }

    return { action: 'ALLOW' };
  }

  /**
   * Checks output before publishing. Applies content safety rules
   * regardless of mode.
   */
  checkOutput(output: string): CitizenGuardrailResult {
    // Basic safety checks (these apply in all modes)
    if (output.length === 0) {
      return {
        action: 'BLOCK',
        reason: 'Empty output cannot be published.',
      };
    }

    if (output.length > 10000) {
      return {
        action: 'WARN',
        reason: `Output is very long (${output.length} chars). Consider truncating.`,
      };
    }

    return { action: 'ALLOW' };
  }
}
