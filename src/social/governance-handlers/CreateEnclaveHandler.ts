/**
 * @fileoverview Handler for 'create_enclave' governance proposals.
 * @module wunderland/social/governance-handlers/CreateEnclaveHandler
 */

import type { EnclaveRegistry } from '../EnclaveRegistry.js';
import type { GovernanceExecutionResult, EnclaveConfig } from '../types.js';
import type { ExecutionHandler } from '../GovernanceExecutor.js';

/**
 * Creates an {@link ExecutionHandler} that processes `create_enclave` proposals.
 *
 * When invoked, the handler:
 * 1. Extracts and validates required fields from the payload.
 * 2. Creates the enclave via the registry.
 * 3. Sets the creator as the enclave moderator.
 *
 * @param registry - The {@link EnclaveRegistry} to create enclaves in.
 * @returns An execution handler for `create_enclave` proposals.
 *
 * @example
 * ```typescript
 * const handler = createCreateEnclaveHandler(registry);
 * executor.registerHandler('create_enclave', handler);
 * ```
 */
export function createCreateEnclaveHandler(registry: EnclaveRegistry): ExecutionHandler {
  return async (proposalId: string, payload: Record<string, unknown>): Promise<GovernanceExecutionResult> => {
    try {
      const name = payload.name as string | undefined;
      const displayName = (payload.displayName as string | undefined) ?? name ?? '';
      const description = (payload.description as string | undefined) ?? '';
      const tags = payload.tags as string[] | undefined;
      const creatorSeedId = payload.creatorSeedId as string | undefined;
      const rules = (payload.rules as string[] | undefined) ?? [];

      // Validate required fields
      if (!name) {
        return {
          proposalId,
          success: false,
          action: 'create_enclave',
          error: 'Missing required field: name',
          stateChanges: [],
        };
      }

      if (!creatorSeedId) {
        return {
          proposalId,
          success: false,
          action: 'create_enclave',
          error: 'Missing required field: creatorSeedId',
          stateChanges: [],
        };
      }

      if (!Array.isArray(tags)) {
        return {
          proposalId,
          success: false,
          action: 'create_enclave',
          error: 'Missing or invalid required field: tags must be an array',
          stateChanges: [],
        };
      }

      const config: EnclaveConfig = {
        name,
        displayName,
        description,
        tags,
        creatorSeedId,
        rules,
      };

      registry.createEnclave(config);
      registry.setModerator(creatorSeedId, name);

      return {
        proposalId,
        success: true,
        action: 'create_enclave',
        stateChanges: [
          `Enclave created: ${name}`,
          `Moderator set: ${creatorSeedId}`,
        ],
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        proposalId,
        success: false,
        action: 'create_enclave',
        error: errorMessage,
        stateChanges: [],
      };
    }
  };
}
