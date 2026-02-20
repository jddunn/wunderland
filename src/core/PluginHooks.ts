/**
 * @fileoverview PluginHookManager — event-driven plugin hook system for Wunderland agents.
 *
 * Allows extensions and plugins to intercept and modify agent behavior at specific
 * lifecycle points. Handlers run in priority order and can mutate the context object
 * or return `false` to block the hook chain.
 *
 * @module wunderland/core/PluginHooks
 *
 * @example
 * ```typescript
 * const hooks = PluginHookManager.getInstance();
 *
 * // Register a content-filter hook that blocks messages containing forbidden words
 * hooks.registerHook('before_message_write', {
 *   name: 'content-filter',
 *   handler: async (ctx) => {
 *     if (ctx.data?.message?.includes('forbidden')) {
 *       return false; // block the message
 *     }
 *   },
 * }, 10);
 *
 * // Execute hooks before writing a message
 * const result = await hooks.executeHooks('before_message_write', {
 *   data: { message: 'hello world' },
 * });
 *
 * if (result.blocked) {
 *   console.log(`Blocked by: ${result.blockedBy}`);
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Hook Names
// ---------------------------------------------------------------------------

/**
 * Named hooks supported by the system. Each represents a specific lifecycle point
 * where plugins can intercept agent behavior.
 */
export type HookName =
  | 'before_message_write'
  | 'after_message_write'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'before_compaction'
  | 'after_compaction';

/** All valid hook names as a readonly array (useful for iteration/validation). */
export const HOOK_NAMES: readonly HookName[] = [
  'before_message_write',
  'after_message_write',
  'before_tool_call',
  'after_tool_call',
  'before_compaction',
  'after_compaction',
] as const;

// ---------------------------------------------------------------------------
// Context & Result Types
// ---------------------------------------------------------------------------

/**
 * Mutable context object passed through the hook chain.
 * Handlers can read and modify `data` to alter agent behavior.
 */
export interface HookContext {
  /** The hook being executed. */
  hookName: HookName;
  /** Arbitrary mutable data for this hook invocation. */
  data: Record<string, unknown>;
  /** Optional metadata (e.g., agent ID, session ID). */
  metadata?: Record<string, unknown>;
}

/**
 * Result of executing a hook chain.
 */
export interface HookResult {
  /** Whether the hook chain completed without being blocked. */
  blocked: boolean;
  /** Name of the handler that blocked the chain (if blocked). */
  blockedBy: string | null;
  /** The (possibly mutated) context after all handlers ran. */
  context: HookContext;
}

// ---------------------------------------------------------------------------
// Handler Types
// ---------------------------------------------------------------------------

/**
 * A hook handler function. Receives the mutable context and can:
 * - Modify `context.data` in place to alter behavior
 * - Return `false` to block the hook chain (no subsequent handlers run)
 * - Return `void` / `undefined` / `true` to continue the chain
 */
export type HookHandlerFn = (context: HookContext) => Promise<boolean | void> | boolean | void;

/**
 * A registered hook handler with metadata.
 */
export interface HookHandler {
  /** Human-readable name for this handler (used in blockedBy reporting). */
  name: string;
  /** The handler function. */
  handler: HookHandlerFn;
}

/**
 * Internal representation of a registered handler with its priority.
 */
interface RegisteredHandler {
  /** The handler definition. */
  hook: HookHandler;
  /** Priority (lower = runs first). Defaults to 100. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Default priority
// ---------------------------------------------------------------------------

/** Default handler priority when none is specified. */
const DEFAULT_PRIORITY = 100;

// ---------------------------------------------------------------------------
// PluginHookManager (Singleton)
// ---------------------------------------------------------------------------

/**
 * Singleton manager for the plugin hook system.
 *
 * Supports registering, removing, and executing hook handlers at named lifecycle
 * points. Handlers run in priority order (lower values first) and can block
 * the chain by returning `false`.
 */
export class PluginHookManager {
  private static instance: PluginHookManager | null = null;

  /** Map of hook name to sorted array of registered handlers. */
  private readonly hooks = new Map<HookName, RegisteredHandler[]>();

  /** Private constructor — use `getInstance()` instead. */
  private constructor() {
    // Initialize empty arrays for each known hook name
    for (const name of HOOK_NAMES) {
      this.hooks.set(name, []);
    }
  }

  /**
   * Get the singleton PluginHookManager instance.
   *
   * @returns The shared PluginHookManager instance
   */
  static getInstance(): PluginHookManager {
    if (!PluginHookManager.instance) {
      PluginHookManager.instance = new PluginHookManager();
    }
    return PluginHookManager.instance;
  }

  /**
   * Reset the singleton instance (primarily for testing).
   * After calling this, the next `getInstance()` creates a fresh manager.
   */
  static resetInstance(): void {
    PluginHookManager.instance = null;
  }

  /**
   * Register a hook handler at the specified lifecycle point.
   *
   * @param hookName - The hook to attach to
   * @param handler - The handler definition (name + function)
   * @param priority - Execution priority (lower = runs first). Defaults to 100.
   * @throws If `hookName` is not a recognized hook name
   *
   * @example
   * ```typescript
   * hooks.registerHook('before_tool_call', {
   *   name: 'rate-limiter',
   *   handler: async (ctx) => {
   *     if (isRateLimited(ctx.data.toolName)) return false;
   *   },
   * }, 5); // High priority — runs before most other handlers
   * ```
   */
  registerHook(hookName: HookName, handler: HookHandler, priority?: number): void {
    const handlers = this.hooks.get(hookName);
    if (!handlers) {
      throw new Error(
        `Unknown hook name "${hookName}". Valid hooks: ${HOOK_NAMES.join(', ')}`,
      );
    }

    const entry: RegisteredHandler = {
      hook: handler,
      priority: priority ?? DEFAULT_PRIORITY,
    };

    handlers.push(entry);

    // Re-sort by priority (stable sort — handlers with equal priority keep insertion order)
    handlers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a previously registered hook handler.
   *
   * Matches by handler function reference (same as EventEmitter semantics).
   *
   * @param hookName - The hook to remove from
   * @param handler - The handler to remove (matched by `.handler` function reference)
   * @returns `true` if a handler was removed, `false` if not found
   */
  removeHook(hookName: HookName, handler: HookHandler): boolean {
    const handlers = this.hooks.get(hookName);
    if (!handlers) {
      return false;
    }

    const idx = handlers.findIndex((entry) => entry.hook.handler === handler.handler);
    if (idx === -1) {
      return false;
    }

    handlers.splice(idx, 1);
    return true;
  }

  /**
   * Execute all registered handlers for a hook in priority order.
   *
   * The context object is mutable — handlers can modify `context.data` to alter
   * behavior for subsequent handlers and the calling code. If any handler returns
   * `false`, the chain stops immediately.
   *
   * @param hookName - The hook to execute
   * @param context - The context to pass through the handler chain. If a plain
   *   object with just `data` is passed, `hookName` will be set automatically.
   * @returns A HookResult indicating whether the chain was blocked and by whom
   *
   * @example
   * ```typescript
   * const result = await hooks.executeHooks('before_message_write', {
   *   data: { message: 'Hello!', agentId: 'seed-42' },
   * });
   *
   * if (!result.blocked) {
   *   // Proceed with writing the (possibly modified) message
   *   writeMessage(result.context.data.message as string);
   * }
   * ```
   */
  async executeHooks(
    hookName: HookName,
    context: Omit<HookContext, 'hookName'> | HookContext,
  ): Promise<HookResult> {
    const ctx: HookContext = {
      hookName,
      data: context.data,
      metadata: context.metadata,
    };

    const handlers = this.hooks.get(hookName);
    if (!handlers || handlers.length === 0) {
      return { blocked: false, blockedBy: null, context: ctx };
    }

    for (const entry of handlers) {
      try {
        const result = await entry.hook.handler(ctx);

        if (result === false) {
          return {
            blocked: true,
            blockedBy: entry.hook.name,
            context: ctx,
          };
        }
      } catch (err) {
        // Log but don't crash the hook chain for a single failing handler
        console.warn(
          `[PluginHooks] Handler "${entry.hook.name}" threw during "${hookName}":`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return { blocked: false, blockedBy: null, context: ctx };
  }

  /**
   * Get the number of registered handlers for a given hook.
   *
   * @param hookName - The hook to query
   * @returns Number of registered handlers
   */
  getHandlerCount(hookName: HookName): number {
    return this.hooks.get(hookName)?.length ?? 0;
  }

  /**
   * Get all registered handler names for a given hook (useful for diagnostics).
   *
   * @param hookName - The hook to query
   * @returns Array of handler names in execution order
   */
  getHandlerNames(hookName: HookName): string[] {
    const handlers = this.hooks.get(hookName);
    if (!handlers) return [];
    return handlers.map((entry) => entry.hook.name);
  }

  /**
   * Remove all handlers from all hooks.
   */
  clearAll(): void {
    for (const name of HOOK_NAMES) {
      this.hooks.set(name, []);
    }
  }
}
