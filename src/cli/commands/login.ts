/**
 * @fileoverview `wunderland login` — authenticate with a provider via OAuth.
 *
 * Supported providers:
 * - OpenAI (device code flow)
 * - Twitter/X (OAuth 2.0 PKCE)
 * - Instagram (Meta OAuth 2.0)
 * - LinkedIn (OAuth 2.0 PKCE)
 * - Facebook (Meta OAuth 2.0)
 * - Bluesky (app-password token storage)
 * - Mastodon (access-token storage)
 * - Farcaster (Neynar API token storage)
 *
 * Stores tokens at ~/.wunderland/auth/{provider}.json.
 *
 * @module wunderland/cli/commands/login
 */

import type { GlobalFlags } from '../types.js';
import { accent, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

const SUPPORTED_PROVIDERS = [
  'openai',
  'twitter',
  'instagram',
  'linkedin',
  'facebook',
  'bluesky',
  'mastodon',
  'farcaster',
] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

interface TokenShape {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  metadata?: Record<string, string>;
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string {
  return typeof flags[key] === 'string' ? flags[key].trim() : '';
}

async function promptRequired(
  message: string,
  validateMessage: string,
  opts: { placeholder?: string; secret?: boolean } = {},
): Promise<string | null> {
  const p = await import('@clack/prompts');
  const result = opts.secret
    ? await p.password({
        message,
        validate: (val: string) => (!val.trim() ? validateMessage : undefined),
      })
    : await p.text({
        message,
        placeholder: opts.placeholder,
        validate: (val: string) => (!val.trim() ? validateMessage : undefined),
      });

  if (p.isCancel(result)) {
    fmt.note('Cancelled.');
    return null;
  }
  return String(result).trim();
}

function toMetadataRecord(input: Record<string, string | number | undefined>): Record<string, string> {
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined && String(value).trim().length > 0)
    .map(([key, value]) => [key, String(value).trim()] as const);
  return Object.fromEntries(entries);
}

async function saveManualToken(
  providerId: string,
  displayName: string,
  accessToken: string,
  opts: {
    refreshToken?: string;
    expiresAt?: number;
    metadata?: Record<string, string>;
  } = {},
): Promise<TokenShape> {
  const { FileTokenStore } = await import('@framers/agentos/auth');
  const store = new FileTokenStore();
  const tokens: TokenShape = {
    accessToken,
    refreshToken: opts.refreshToken,
    expiresAt: opts.expiresAt ?? Date.now() + 3650 * 24 * 60 * 60 * 1000, // ~10 years
    metadata: opts.metadata && Object.keys(opts.metadata).length > 0 ? opts.metadata : undefined,
  };
  await store.save(providerId, tokens);
  printSuccess(displayName, providerId, tokens);
  return tokens;
}

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

  let clientId = stringFlag(flags, 'client-id');
  if (!clientId) {
    clientId = process.env.TWITTER_CLIENT_ID ?? '';
  }
  if (!clientId) {
    const prompted = await promptRequired(
      'Twitter OAuth 2.0 Client ID:',
      'Client ID is required',
      { placeholder: 'From https://developer.x.com/en/portal/dashboard' },
    );
    if (!prompted) return;
    clientId = prompted;
  }

  const authMod = (await import('@framers/agentos/auth')) as any;
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

  let appId = stringFlag(flags, 'app-id');
  let appSecret = stringFlag(flags, 'app-secret');

  if (!appId) appId = process.env.META_APP_ID ?? process.env.FACEBOOK_APP_ID ?? '';
  if (!appSecret) appSecret = process.env.META_APP_SECRET ?? process.env.FACEBOOK_APP_SECRET ?? '';

  if (!appId) {
    const prompted = await promptRequired(
      'Meta/Facebook App ID:',
      'App ID is required',
      { placeholder: 'From https://developers.facebook.com/apps/' },
    );
    if (!prompted) return;
    appId = prompted;
  }
  if (!appSecret) {
    const prompted = await promptRequired('Meta/Facebook App Secret:', 'App Secret is required', {
      secret: true,
    });
    if (!prompted) return;
    appSecret = prompted;
  }

  const authMod = (await import('@framers/agentos/auth')) as any;
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

async function loginLinkedIn(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('LinkedIn OAuth 2.0 Login');
  console.log(`  Authenticating with LinkedIn via OAuth 2.0.\n`);

  let clientId = stringFlag(flags, 'client-id');
  let clientSecret = stringFlag(flags, 'client-secret');

  if (!clientId) clientId = process.env.LINKEDIN_CLIENT_ID ?? '';
  if (!clientSecret) clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? '';

  if (!clientId) {
    const prompted = await promptRequired(
      'LinkedIn OAuth Client ID:',
      'Client ID is required',
      { placeholder: 'From https://www.linkedin.com/developers/apps' },
    );
    if (!prompted) return;
    clientId = prompted;
  }
  if (!clientSecret) {
    const prompted = await promptRequired('LinkedIn OAuth Client Secret:', 'Client secret is required', {
      secret: true,
    });
    if (!prompted) return;
    clientSecret = prompted;
  }

  const authMod = (await import('@framers/agentos/auth')) as any;
  const { LinkedInOAuthFlow, FileTokenStore } = authMod;

  const flow = new LinkedInOAuthFlow({
    tokenStore: new FileTokenStore(),
    clientId,
    clientSecret,
    onAuthUrl: (url: string) => {
      console.log(`  ${accent('1.')} Your browser will open to authorize with LinkedIn.`);
      console.log(`  ${accent('2.')} If it doesn't, visit:\n     ${accent(url)}\n`);
      console.log(`  Waiting for authorization...`);
    },
  });

  const tokens = await flow.authenticate();
  printSuccess('LinkedIn', 'linkedin', tokens);
}

async function loginFacebook(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Facebook OAuth 2.0 Login');
  console.log(`  Authenticating with Facebook Pages via Meta OAuth 2.0.\n`);

  let appId = stringFlag(flags, 'app-id');
  let appSecret = stringFlag(flags, 'app-secret');

  if (!appId) appId = process.env.META_APP_ID ?? process.env.FACEBOOK_APP_ID ?? '';
  if (!appSecret) appSecret = process.env.META_APP_SECRET ?? process.env.FACEBOOK_APP_SECRET ?? '';

  if (!appId) {
    const prompted = await promptRequired(
      'Meta/Facebook App ID:',
      'App ID is required',
      { placeholder: 'From https://developers.facebook.com/apps/' },
    );
    if (!prompted) return;
    appId = prompted;
  }
  if (!appSecret) {
    const prompted = await promptRequired('Meta/Facebook App Secret:', 'App Secret is required', {
      secret: true,
    });
    if (!prompted) return;
    appSecret = prompted;
  }

  const authMod = (await import('@framers/agentos/auth')) as any;
  const { FacebookOAuthFlow, FileTokenStore } = authMod;

  const flow = new FacebookOAuthFlow({
    tokenStore: new FileTokenStore(),
    appId,
    appSecret,
    onAuthUrl: (url: string) => {
      console.log(`  ${accent('1.')} Your browser will open to authorize with Facebook.`);
      console.log(`  ${accent('2.')} If it doesn't, visit:\n     ${accent(url)}\n`);
      console.log(`  Waiting for authorization...`);
    },
  });

  const tokens = await flow.authenticate();
  printSuccess('Facebook', 'facebook', tokens);
  if (tokens.metadata?.pageId) {
    console.log(`  Page: ${accent(tokens.metadata.pageName ?? 'Unknown')} (${accent(tokens.metadata.pageId)})`);
  }
}

async function loginBluesky(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Bluesky Token Setup');
  console.log(`  Saving Bluesky credentials for CLI and channel adapter auto-load.\n`);

  let handle = stringFlag(flags, 'handle');
  let appPassword = stringFlag(flags, 'app-password');
  let service = stringFlag(flags, 'service');

  if (!handle) handle = process.env.BLUESKY_HANDLE ?? process.env.BSKY_HANDLE ?? '';
  if (!appPassword) appPassword = process.env.BLUESKY_APP_PASSWORD ?? process.env.BSKY_APP_PASSWORD ?? '';
  if (!service) service = process.env.BLUESKY_SERVICE ?? process.env.BSKY_SERVICE ?? 'https://bsky.social';

  if (!handle) {
    const prompted = await promptRequired(
      'Bluesky handle:',
      'Handle is required',
      { placeholder: 'alice.bsky.social' },
    );
    if (!prompted) return;
    handle = prompted;
  }
  if (!appPassword) {
    const prompted = await promptRequired(
      'Bluesky app password:',
      'App password is required',
      { secret: true },
    );
    if (!prompted) return;
    appPassword = prompted;
  }

  await saveManualToken('bluesky', 'Bluesky', appPassword, {
    metadata: toMetadataRecord({ handle, service }),
  });
  console.log(`  Handle: ${accent(handle)}`);
  console.log(`  Service: ${accent(service)}`);
  console.log('');
}

async function loginMastodon(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Mastodon Token Setup');
  console.log(`  Saving Mastodon credentials for CLI and channel adapter auto-load.\n`);

  let accessToken = stringFlag(flags, 'access-token');
  let instanceUrl = stringFlag(flags, 'instance-url');

  if (!accessToken) accessToken = process.env.MASTODON_ACCESS_TOKEN ?? '';
  if (!instanceUrl) instanceUrl = process.env.MASTODON_INSTANCE_URL ?? 'https://mastodon.social';

  if (!accessToken) {
    const prompted = await promptRequired(
      'Mastodon access token:',
      'Access token is required',
      { secret: true },
    );
    if (!prompted) return;
    accessToken = prompted;
  }

  await saveManualToken('mastodon', 'Mastodon', accessToken, {
    metadata: toMetadataRecord({ instanceUrl }),
  });
  console.log(`  Instance URL: ${accent(instanceUrl)}`);
  console.log('');
}

async function loginFarcaster(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Farcaster Token Setup');
  console.log(`  Saving Farcaster/Neynar credentials for CLI and channel adapter auto-load.\n`);

  let neynarApiKey = stringFlag(flags, 'neynar-api-key') || stringFlag(flags, 'api-key');
  let signerUuid = stringFlag(flags, 'signer-uuid');
  let fid = stringFlag(flags, 'fid');

  if (!neynarApiKey) neynarApiKey = process.env.NEYNAR_API_KEY ?? '';
  if (!signerUuid) signerUuid = process.env.FARCASTER_SIGNER_UUID ?? '';
  if (!fid) fid = process.env.FARCASTER_FID ?? '';

  if (!neynarApiKey) {
    const prompted = await promptRequired('Neynar API key:', 'Neynar API key is required', {
      secret: true,
    });
    if (!prompted) return;
    neynarApiKey = prompted;
  }

  await saveManualToken('farcaster', 'Farcaster', neynarApiKey, {
    metadata: toMetadataRecord({ signerUuid, fid }),
  });
  if (signerUuid) console.log(`  Signer UUID: ${accent(signerUuid)}`);
  if (fid) console.log(`  FID: ${accent(fid)}`);
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
      case 'openai': await loginOpenAI(flags); break;
      case 'twitter': await loginTwitter(flags); break;
      case 'instagram': await loginInstagram(flags); break;
      case 'linkedin': await loginLinkedIn(flags); break;
      case 'facebook': await loginFacebook(flags); break;
      case 'bluesky': await loginBluesky(flags); break;
      case 'mastodon': await loginMastodon(flags); break;
      case 'farcaster': await loginFarcaster(flags); break;
    }
  } catch (err) {
    fmt.errorBlock(
      'Login failed',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  }
}
