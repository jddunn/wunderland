/**
 * @fileoverview `wunderland login` — authenticate with an LLM provider via OAuth.
 *
 * Currently supports OpenAI's device code flow (Codex CLI-compatible).
 * Stores tokens at ~/.wunderland/auth/{provider}.json.
 *
 * @module wunderland/cli/commands/login
 */

import type { GlobalFlags } from '../types.js';
import { accent, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

export default async function cmdLogin(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const provider = typeof flags['provider'] === 'string' ? flags['provider'].trim() : 'openai';

  if (provider !== 'openai') {
    fmt.errorBlock('Unsupported provider', `OAuth login is currently only supported for OpenAI. Got: "${provider}".`);
    process.exitCode = 1;
    return;
  }

  fmt.section('OpenAI OAuth Login');
  console.log(`  Authenticating with your OpenAI subscription (ChatGPT Plus/Pro).`);
  console.log(`  This uses the same OAuth flow as the Codex CLI.\n`);

  try {
    const { OpenAIOAuthFlow, FileTokenStore } = await import('@framers/agentos/auth');

    const flow = new OpenAIOAuthFlow({
      tokenStore: new FileTokenStore(),
      onUserCode: (code: string, url: string) => {
        console.log(`  ${accent('1.')} Open your browser and visit:`);
        console.log(`     ${accent(url)}\n`);
        console.log(`  ${accent('2.')} Enter the code: ${sColor(code)}\n`);
        console.log(`  Waiting for authorization...`);
      },
    });

    const tokens = await flow.authenticate();
    const masked = tokens.accessToken.slice(0, 8) + '...' + tokens.accessToken.slice(-4);
    const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 1000 / 60);

    console.log('');
    fmt.successBlock('Authenticated', [
      `Provider: ${accent('OpenAI')}`,
      `Token: ${masked}`,
      `Expires in: ${expiresIn} minutes`,
      `Stored at: ${accent('~/.wunderland/auth/openai.json')}`,
    ].join('\n'));

    console.log(`\n  To use OAuth in your agent, add to ${accent('agent.config.json')}:`);
    console.log(`    ${accent('"llmAuthMethod": "oauth"')}\n`);
  } catch (err) {
    fmt.errorBlock(
      'Login failed',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  }
}
