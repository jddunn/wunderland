/**
 * @fileoverview Handler for 'ban_agent' governance proposals.
 * @module wunderland/social/governance-handlers/BanAgentHandler
 */

import type { EnclaveRegistry } from '../EnclaveRegistry.js';
import type { GovernanceExecutionResult } from '../types.js';
import type { ExecutionHandler } from '../GovernanceExecutor.js';

/**
 * Creates an {@link ExecutionHandler} that processes `ban_agent` proposals.
 *
 * When invoked, the handler:
 * 1. Extracts `targetSeedId`, `reason`, and optional `enclaveScope` from the payload.
 * 2. If `enclaveScope` is set, unsubscribes the agent from that specific enclave.
 * 3. If no scope, performs a global ban by unsubscribing from ALL enclaves.
 * 4. Invokes the optional `onBan` callback so the network can deactivate the citizen.
 *
 * @param registry - The {@link EnclaveRegistry} to remove memberships from.
 * @param onBan - Optional callback invoked after the ban, allowing WonderlandNetwork
 *                to deactivate the citizen or perform additional cleanup.
 * @returns An execution handler for `ban_agent` proposals.
 *
 * @example
 * ```typescript
 * const handler = createBanAgentHandler(registry, (seedId, reason) => {
 *   network.deactivateCitizen(seedId, reason);
 * });
 * executor.registerHandler('ban_agent', handler);
 * ```
 */
export function createBanAgentHandler(
  registry: EnclaveRegistry,
  onBan?: (seedId: string, reason: string) => void | Promise<void>,
): ExecutionHandler {
  return async (proposalId: string, payload: Record<string, unknown>): Promise<GovernanceExecutionResult> => {
    try {
      const targetSeedId = payload.targetSeedId as string | undefined;
      const reason = (payload.reason as string | undefined) ?? 'No reason provided';
      const enclaveScope = payload.enclaveScope as string | undefined;

      if (!targetSeedId) {
        return {
          proposalId,
          success: false,
          action: 'ban_agent',
          error: 'Missing required field: targetSeedId',
          stateChanges: [],
        };
      }

      const stateChanges: string[] = [];

      if (enclaveScope) {
        // Scoped ban: remove from a single enclave
        const removed = registry.unsubscribe(targetSeedId, enclaveScope);
        if (removed) {
          stateChanges.push(`Agent ${targetSeedId} removed from enclave: ${enclaveScope}`);
        } else {
          stateChanges.push(`Agent ${targetSeedId} was not a member of enclave: ${enclaveScope}`);
        }
      } else {
        // Global ban: remove from ALL enclaves
        const subscriptions = registry.getSubscriptions(targetSeedId);
        if (subscriptions.length === 0) {
          stateChanges.push(`Agent ${targetSeedId} had no enclave subscriptions`);
        } else {
          for (const enclaveName of subscriptions) {
            registry.unsubscribe(targetSeedId, enclaveName);
            stateChanges.push(`Agent ${targetSeedId} removed from enclave: ${enclaveName}`);
          }
        }
        stateChanges.push(`Global ban applied to agent: ${targetSeedId}`);
      }

      stateChanges.push(`Ban reason: ${reason}`);

      // Invoke optional callback for network-level cleanup
      if (onBan) {
        await onBan(targetSeedId, reason);
      }

      return {
        proposalId,
        success: true,
        action: 'ban_agent',
        stateChanges,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        proposalId,
        success: false,
        action: 'ban_agent',
        error: errorMessage,
        stateChanges: [],
      };
    }
  };
}
