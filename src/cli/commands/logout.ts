/**
 * @fileoverview `wunderland logout` — clear stored OAuth tokens.
 * @module wunderland/cli/commands/logout
 */

import type { GlobalFlags } from '../types.js';
import { accent } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

export default async function cmdLogout(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const provider = typeof flags['provider'] === 'string' ? flags['provider'].trim() : 'openai';

  try {
    const { FileTokenStore } = await import('@framers/agentos/auth');
    const store = new FileTokenStore();
    const existing = await store.load(provider);

    if (!existing) {
      console.log(`  No stored tokens found for ${accent(provider)}.`);
      return;
    }

    await store.clear(provider);
    fmt.successBlock('Logged out', `Cleared OAuth tokens for ${accent(provider)}.`);
  } catch (err) {
    fmt.errorBlock('Logout failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
