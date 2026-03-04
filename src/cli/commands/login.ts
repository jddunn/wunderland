/**
 * @fileoverview `wunderland login` — authenticate with a provider via OAuth.
 *
 * Supports: OpenAI (device code flow), Twitter/X (OAuth 2.0 PKCE),
 * Instagram (Meta OAuth 2.0).
 *
 * Stores tokens at ~/.wunderland/auth/{provider}.json.
 *
 * @module wunderland/cli/commands/login
 */

import type { GlobalFlags } from '../types.js';
import { accent, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

const SUPPORTED_PROVIDERS = ['openai', 'twitter', 'instagram'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

// ── Provider-specific login flows ───────────────────────────────────────────

async function loginOpenAI(_flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('OpenAI OAuth Login');
  console.log(`  Authenticating with your OpenAI subscription (ChatGPT Plus/Pro).`);
  console.log(`  This uses the same OAuth flow as the Codex CLI.\n`);

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
  printSuccess('OpenAI', 'openai', tokens);

  console.log(`\n  To use OAuth in your agent, add to ${accent('agent.config.json')}:`);
  console.log(`    ${accent('"llmAuthMethod": "oauth"')}\n`);
}

async function loginTwitter(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Twitter/X OAuth 2.0 Login');
  console.log(`  Authenticating with Twitter/X via OAuth 2.0 (PKCE).\n`);

  let clientId = typeof flags['client-id'] === 'string' ? flags['client-id'].trim() : '';

  if (!clientId) {
    clientId = process.env.TWITTER_CLIENT_ID ?? '';
  }

  if (!clientId) {
    const p = await import('@clack/prompts');
    const input = await p.text({
      message: 'Twitter OAuth 2.0 Client ID:',
      placeholder: 'From https://developer.x.com/en/portal/dashboard',
      validate: (val: string) => (!val.trim() ? 'Client ID is required' : undefined),
    });
    if (p.isCancel(input)) {
      fmt.note('Cancelled.');
      return;
    }
    clientId = (input as string).trim();
  }

  // Dynamic import — TwitterOAuthFlow is available in local build; type resolves after agentos publish
  const authMod = await import('@framers/agentos/auth') as any;
  const { TwitterOAuthFlow, FileTokenStore } = authMod;

  const flow = new TwitterOAuthFlow({
    tokenStore: new FileTokenStore(),
    clientId,
    onAuthUrl: (url: string) => {
      console.log(`  ${accent('1.')} Your browser will open to authorize with Twitter.`);
      console.log(`  ${accent('2.')} If it doesn't, visit:\n     ${accent(url)}\n`);
      console.log(`  Waiting for authorization...`);
    },
  });

  const tokens = await flow.authenticate();
  printSuccess('Twitter/X', 'twitter', tokens);
}

async function loginInstagram(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Instagram OAuth 2.0 Login');
  console.log(`  Authenticating with Instagram via Meta OAuth 2.0.\n`);

  let appId = typeof flags['app-id'] === 'string' ? flags['app-id'].trim() : '';
  let appSecret = typeof flags['app-secret'] === 'string' ? flags['app-secret'].trim() : '';

  if (!appId) appId = process.env.META_APP_ID ?? process.env.FACEBOOK_APP_ID ?? '';
  if (!appSecret) appSecret = process.env.META_APP_SECRET ?? process.env.FACEBOOK_APP_SECRET ?? '';

  if (!appId || !appSecret) {
    const p = await import('@clack/prompts');

    if (!appId) {
      const input = await p.text({
        message: 'Meta/Facebook App ID:',
        placeholder: 'From https://developers.facebook.com/apps/',
        validate: (val: string) => (!val.trim() ? 'App ID is required' : undefined),
      });
      if (p.isCancel(input)) { fmt.note('Cancelled.'); return; }
      appId = (input as string).trim();
    }

    if (!appSecret) {
      const input = await p.password({
        message: 'Meta/Facebook App Secret:',
        validate: (val: string) => (!val.trim() ? 'App Secret is required' : undefined),
      });
      if (p.isCancel(input)) { fmt.note('Cancelled.'); return; }
      appSecret = (input as string).trim();
    }
  }

  // Dynamic import — InstagramOAuthFlow is available in local build; type resolves after agentos publish
  const authMod = await import('@framers/agentos/auth') as any;
  const { InstagramOAuthFlow, FileTokenStore } = authMod;

  const flow = new InstagramOAuthFlow({
    tokenStore: new FileTokenStore(),
    appId,
    appSecret,
    onAuthUrl: (url: string) => {
      console.log(`  ${accent('1.')} Your browser will open to authorize with Meta/Instagram.`);
      console.log(`  ${accent('2.')} If it doesn't, visit:\n     ${accent(url)}\n`);
      console.log(`  Waiting for authorization...`);
    },
  });

  const tokens = await flow.authenticate();
  printSuccess('Instagram', 'instagram', tokens);

  if (tokens.metadata?.igUserId) {
    console.log(`  IG Business Account: ${accent(tokens.metadata.igUserId)}`);
  }
  console.log('');
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function printSuccess(displayName: string, providerId: string, tokens: { accessToken: string; expiresAt: number }): void {
  const masked = tokens.accessToken.slice(0, 8) + '...' + tokens.accessToken.slice(-4);
  const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 1000 / 60);
  const unit = expiresIn > 1440 ? `${Math.round(expiresIn / 1440)} days` : `${expiresIn} minutes`;

  console.log('');
  fmt.successBlock('Authenticated', [
    `Provider: ${accent(displayName)}`,
    `Token: ${masked}`,
    `Expires in: ${unit}`,
    `Stored at: ${accent(`~/.wunderland/auth/${providerId}.json`)}`,
  ].join('\n'));
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdLogin(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const provider = (typeof flags['provider'] === 'string' ? flags['provider'].trim() : 'openai') as string;

  if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    fmt.errorBlock(
      'Unsupported provider',
      `Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}. Got: "${provider}".`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    switch (provider) {
      case 'openai':    await loginOpenAI(flags); break;
      case 'twitter':   await loginTwitter(flags); break;
      case 'instagram': await loginInstagram(flags); break;
    }
  } catch (err) {
    fmt.errorBlock(
      'Login failed',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  }
}
