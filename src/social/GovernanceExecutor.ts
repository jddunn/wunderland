/**
 * @fileoverview GovernanceExecutor — dispatches approved governance proposals to handlers.
 * @module wunderland/social/GovernanceExecutor
 */

import { EventEmitter } from 'events';
import type { ProposalType, ProposalAction, GovernanceExecutionResult } from './types.js';

/**
 * Handler function that executes a specific governance proposal type.
 * Receives the proposal ID and action payload, returns the execution result.
 */
export type ExecutionHandler = (
  proposalId: string,
  payload: Record<string, unknown>,
) => Promise<GovernanceExecutionResult>;

/**
 * GovernanceExecutor dispatches approved governance proposals to their
 * registered handlers and emits execution events.
 *
 * Each {@link ProposalType} maps to exactly one {@link ExecutionHandler}.
 * When a proposal is executed, the executor looks up the handler, invokes it,
 * and emits a `governance_executed` event with the result.
 *
 * @example
 * ```typescript
 * const executor = new GovernanceExecutor();
 * executor.registerHandler('create_enclave', createCreateEnclaveHandler(registry));
 * const result = await executor.execute('prop-1', { type: 'create_enclave', payload: { ... } });
 * ```
 */
export class GovernanceExecutor extends EventEmitter {
  /** Map of proposal types to their execution handlers. */
  private handlers: Map<ProposalType, ExecutionHandler> = new Map();

  constructor() {
    super();
  }

  /**
   * Register an execution handler for a proposal type.
   * Overwrites any previously registered handler for the same type.
   *
   * @param type - The proposal type to handle.
   * @param handler - The handler function to invoke for this type.
   */
  registerHandler(type: ProposalType, handler: ExecutionHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Execute an approved proposal by dispatching to the registered handler.
   *
   * If no handler is registered for the action type, returns a failure result.
   * Handler errors are caught and returned as failure results.
   * On completion (success or failure), emits a `governance_executed` event.
   *
   * @param proposalId - Unique identifier of the proposal being executed.
   * @param action - The proposal action containing type and payload.
   * @returns The execution result.
   */
  async execute(proposalId: string, action: ProposalAction): Promise<GovernanceExecutionResult> {
    const handler = this.handlers.get(action.type);

    if (!handler) {
      const result: GovernanceExecutionResult = {
        proposalId,
        success: false,
        action: action.type,
        error: 'No handler registered',
        stateChanges: [],
      };
      this.emit('governance_executed', result);
      return result;
    }

    try {
      const result = await handler(proposalId, action.payload);
      this.emit('governance_executed', result);
      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const result: GovernanceExecutionResult = {
        proposalId,
        success: false,
        action: action.type,
        error: errorMessage,
        stateChanges: [],
      };
      this.emit('governance_executed', result);
      return result;
    }
  }

  /**
   * Check whether a handler is registered for the given proposal type.
   *
   * @param type - The proposal type to check.
   * @returns `true` if a handler exists for this type.
   */
  hasHandler(type: ProposalType): boolean {
    return this.handlers.has(type);
  }

  /**
   * Get all proposal types that have registered handlers.
   *
   * @returns Array of registered proposal types.
   */
  getRegisteredTypes(): ProposalType[] {
    return [...this.handlers.keys()];
  }
}
