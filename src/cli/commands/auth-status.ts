/**
 * @fileoverview `wunderland auth-status` — show current OAuth authentication state.
 * @module wunderland/cli/commands/auth-status
 */

import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor, error as eColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

export default async function cmdAuthStatus(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const provider = typeof flags['provider'] === 'string' ? flags['provider'].trim() : 'openai';

  try {
    const { FileTokenStore, OpenAIOAuthFlow } = await import('@framers/agentos/auth');
    const store = new FileTokenStore();
    const tokens = await store.load(provider);

    fmt.section(`OAuth Status — ${provider}`);

    if (!tokens) {
      console.log(`  Status: ${eColor('Not authenticated')}`);
      console.log(`  Run ${accent('wunderland login')} to authenticate.\n`);
      return;
    }

    const flow = new OpenAIOAuthFlow({ tokenStore: store });
    const valid = flow.isValid(tokens);
    const expiresAt = new Date(tokens.expiresAt);
    const minutesLeft = Math.round((tokens.expiresAt - Date.now()) / 1000 / 60);
    const masked = tokens.accessToken.slice(0, 8) + '...' + tokens.accessToken.slice(-4);

    console.log(`  Status: ${valid ? sColor('Authenticated') : wColor('Token expired')}`);
    console.log(`  Token:  ${masked}`);
    console.log(`  Expires: ${expiresAt.toLocaleString()} (${valid ? `${minutesLeft}m remaining` : 'expired'})`);
    console.log(`  Refresh: ${tokens.refreshToken ? sColor('Available') : eColor('None')}`);

    if (!valid && tokens.refreshToken) {
      console.log(`\n  Token expired but refresh token available — will auto-refresh on next use.`);
    } else if (!valid) {
      console.log(`\n  Run ${accent('wunderland login')} to re-authenticate.`);
    }
    console.log('');
  } catch (err) {
    fmt.errorBlock('Failed to check auth status', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
