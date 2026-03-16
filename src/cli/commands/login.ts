/**
 * @fileoverview `wunderland login` — authenticate your LLM provider.
 *
 * Default interactive menu shows LLM authentication options:
 * - OpenAI OAuth (ChatGPT subscription — no API key needed)
 * - OpenAI API Key
 * - Anthropic API Key
 * - Google Gemini API Key
 * - OpenRouter API Key
 * - Other providers (AWS Bedrock, Minimax, Qwen, etc.)
 *
 * Social channel auth (Twitter, Instagram, etc.) is available via
 * `wunderland login --provider twitter`.
 *
 * Stores tokens at ~/.wunderland/auth/{provider}.json.
 * Stores API keys in ~/.wunderland/.env.
 *
 * @module wunderland/cli/commands/login
 */

import type { GlobalFlags } from '../types.js';
import { LLM_PROVIDERS } from '../constants.js';
import { accent, success as sColor, dim, muted, bright, info as iColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { updateConfig } from '../config/config-manager.js';
import { mergeEnv } from '../config/env-manager.js';

// ── All providers (LLM + social channels) ────────────────────────────────────

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
  printTokenSuccess(displayName, providerId, tokens);
  return tokens;
}

// ── LLM Provider Login Flows ─────────────────────────────────────────────────

async function loginOpenAIOAuth(_flags: Record<string, string | boolean>, globals: GlobalFlags): Promise<void> {
  const authMod = await import('@framers/agentos/auth') as any;
  const { OpenAIOAuthFlow, FileTokenStore } = authMod;
  const store = new FileTokenStore();

  // Check for cached tokens first
  const existing = await store.load('openai');
  if (existing) {
    const checkFlow = new OpenAIOAuthFlow({ tokenStore: store });
    if (checkFlow.isValid(existing)) {
      const masked = existing.accessToken.slice(0, 8) + '...' + existing.accessToken.slice(-4);
      const expiresIn = Math.round((existing.expiresAt - Date.now()) / 1000 / 60);
      const unit = expiresIn > 1440 ? `${Math.round(expiresIn / 1440)} days` : `${expiresIn} minutes`;

      console.log();
      fmt.ok(`You're already logged in — no need to re-authenticate.`);
      fmt.note(`Token: ${dim(masked)} · expires in ${accent(unit)}`);
      console.log();
      fmt.note(`Next step: ${accent('wunderland chat --oauth')}`);
      console.log();
      return;
    }
  }

  await fmt.panel({
    title: 'OpenAI OAuth Login',
    style: 'brand',
    content: [
      `${bright('Authenticate with your ChatGPT subscription')}`,
      `${dim('Opens your browser to log in — same flow as the Codex CLI.')}`,
      '',
      `${muted('Plan')}              ${muted('Price')}       ${muted('API Credits')}`,
      `${iColor('ChatGPT Plus')}     $20/mo      $5/mo`,
      `${iColor('ChatGPT Pro')}      $200/mo     $50/mo + unlimited Codex`,
      `${iColor('ChatGPT Team')}     $25-30/mo   shared pool`,
    ].join('\n'),
  });

  console.log();

  const flow = new OpenAIOAuthFlow({
    tokenStore: store,
    onBrowserOpen: (_authUrl: string) => {
      fmt.note('Opening your browser to log in with OpenAI...');
      fmt.note(`If it doesn't open, visit: ${iColor(_authUrl)}`);
      console.log();
      fmt.note('Waiting for authorization...');
    },
  });

  const tokens = await flow.authenticate();
  printTokenSuccess('OpenAI', 'openai', tokens);

  // Persist auth method in config
  await updateConfig({ llmProvider: 'openai', llmAuthMethod: 'oauth' }, globals.config);

  console.log();
  fmt.ok(`Config updated: ${accent('llmAuthMethod = "oauth"')}`);
  fmt.note(`Start chatting: ${accent('wunderland chat --oauth')}`);
  console.log();
}

async function loginApiKey(
  providerId: string,
  globals: GlobalFlags,
): Promise<void> {
  const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
  if (!provider || !provider.envVar) {
    fmt.errorBlock('Invalid provider', `No API key env var for provider "${providerId}".`);
    return;
  }

  await fmt.panel({
    title: `${provider.label} API Key`,
    style: 'info',
    content: [
      `${bright(`Set your ${provider.label} API key.`)}`,
      `${dim(`Get one at: ${provider.docsUrl}`)}`,
      '',
      `${muted('Stored in')} ${accent('~/.wunderland/.env')} ${muted(`as ${provider.envVar}`)}`,
    ].join('\n'),
  });

  console.log();

  // Check if already set
  const existing = process.env[provider.envVar];
  if (existing) {
    const masked = existing.slice(0, 6) + '...' + existing.slice(-4);
    fmt.ok(`${provider.label}: already set (${dim(masked)})`);

    const p = await import('@clack/prompts');
    const replace = await p.confirm({ message: 'Replace the existing key?', initialValue: false });
    if (p.isCancel(replace) || !replace) {
      fmt.note('Keeping existing key.');
      return;
    }
  }

  const apiKey = await promptRequired(`${provider.label} API Key:`, `${provider.label} key is required`, {
    secret: true,
  });
  if (!apiKey) return;

  // Write to .env
  await mergeEnv({ [provider.envVar]: apiKey }, globals.config);

  // Persist as default provider in config
  await updateConfig({ llmProvider: providerId, llmAuthMethod: 'api-key' }, globals.config);

  // Also select a model
  if (provider.models.length > 0) {
    const p = await import('@clack/prompts');
    const modelOptions = provider.models.map((m, i) => ({
      value: m as string,
      label: m as string,
      hint: i === 0 ? 'recommended' : undefined,
    }));

    const model = await p.select({
      message: 'Default model:',
      options: modelOptions,
    });

    if (!p.isCancel(model)) {
      await updateConfig({ llmModel: model as string }, globals.config);
    }
  }

  console.log();
  printApiKeySuccess(provider.label, provider.envVar);
}

// ── Social Channel Login Flows (kept for --provider flag) ────────────────────

async function loginTwitter(flags: Record<string, string | boolean>): Promise<void> {
  await fmt.panel({
    title: 'Twitter/X OAuth 2.0',
    style: 'info',
    content: `${bright('Authenticating with Twitter/X via OAuth 2.0 (PKCE).')}`,
  });
  console.log();

  let clientId = stringFlag(flags, 'client-id');
  if (!clientId) clientId = process.env.TWITTER_CLIENT_ID ?? '';
  if (!clientId) {
    const prompted = await promptRequired('Twitter OAuth 2.0 Client ID:', 'Client ID is required', {
      placeholder: 'From https://developer.x.com/en/portal/dashboard',
    });
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
  printTokenSuccess('Twitter/X', 'twitter', tokens);
}

async function loginInstagram(flags: Record<string, string | boolean>): Promise<void> {
  await fmt.panel({
    title: 'Instagram OAuth 2.0',
    style: 'info',
    content: `${bright('Authenticating with Instagram via Meta OAuth 2.0.')}`,
  });
  console.log();

  let appId = stringFlag(flags, 'app-id');
  let appSecret = stringFlag(flags, 'app-secret');
  if (!appId) appId = process.env.META_APP_ID ?? process.env.FACEBOOK_APP_ID ?? '';
  if (!appSecret) appSecret = process.env.META_APP_SECRET ?? process.env.FACEBOOK_APP_SECRET ?? '';

  if (!appId) {
    const prompted = await promptRequired('Meta/Facebook App ID:', 'App ID is required', {
      placeholder: 'From https://developers.facebook.com/apps/',
    });
    if (!prompted) return;
    appId = prompted;
  }
  if (!appSecret) {
    const prompted = await promptRequired('Meta/Facebook App Secret:', 'App Secret is required', { secret: true });
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
  printTokenSuccess('Instagram', 'instagram', tokens);
  if (tokens.metadata?.igUserId) {
    console.log(`  IG Business Account: ${accent(tokens.metadata.igUserId)}`);
  }
  console.log('');
}

async function loginLinkedIn(flags: Record<string, string | boolean>): Promise<void> {
  await fmt.panel({
    title: 'LinkedIn OAuth 2.0',
    style: 'info',
    content: `${bright('Authenticating with LinkedIn via OAuth 2.0 (PKCE).')}`,
  });
  console.log();

  let clientId = stringFlag(flags, 'client-id');
  let clientSecret = stringFlag(flags, 'client-secret');
  if (!clientId) clientId = process.env.LINKEDIN_CLIENT_ID ?? '';
  if (!clientSecret) clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? '';

  if (!clientId) {
    const prompted = await promptRequired('LinkedIn OAuth Client ID:', 'Client ID is required', {
      placeholder: 'From https://www.linkedin.com/developers/apps',
    });
    if (!prompted) return;
    clientId = prompted;
  }
  if (!clientSecret) {
    const prompted = await promptRequired('LinkedIn OAuth Client Secret:', 'Client secret is required', { secret: true });
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
  printTokenSuccess('LinkedIn', 'linkedin', tokens);
}

async function loginFacebook(flags: Record<string, string | boolean>): Promise<void> {
  await fmt.panel({
    title: 'Facebook Pages OAuth 2.0',
    style: 'info',
    content: `${bright('Authenticating with Facebook Pages via Meta OAuth 2.0.')}`,
  });
  console.log();

  let appId = stringFlag(flags, 'app-id');
  let appSecret = stringFlag(flags, 'app-secret');
  if (!appId) appId = process.env.META_APP_ID ?? process.env.FACEBOOK_APP_ID ?? '';
  if (!appSecret) appSecret = process.env.META_APP_SECRET ?? process.env.FACEBOOK_APP_SECRET ?? '';

  if (!appId) {
    const prompted = await promptRequired('Meta/Facebook App ID:', 'App ID is required', {
      placeholder: 'From https://developers.facebook.com/apps/',
    });
    if (!prompted) return;
    appId = prompted;
  }
  if (!appSecret) {
    const prompted = await promptRequired('Meta/Facebook App Secret:', 'App Secret is required', { secret: true });
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
  printTokenSuccess('Facebook', 'facebook', tokens);
  if (tokens.metadata?.pageId) {
    console.log(`  Page: ${accent(tokens.metadata.pageName ?? 'Unknown')} (${accent(tokens.metadata.pageId)})`);
  }
}

async function loginBluesky(flags: Record<string, string | boolean>): Promise<void> {
  await fmt.panel({
    title: 'Bluesky Token Setup',
    style: 'info',
    content: `${bright('Saving Bluesky credentials for CLI and channel adapter auto-load.')}`,
  });
  console.log();

  let handle = stringFlag(flags, 'handle');
  let appPassword = stringFlag(flags, 'app-password');
  let service = stringFlag(flags, 'service');
  if (!handle) handle = process.env.BLUESKY_HANDLE ?? process.env.BSKY_HANDLE ?? '';
  if (!appPassword) appPassword = process.env.BLUESKY_APP_PASSWORD ?? process.env.BSKY_APP_PASSWORD ?? '';
  if (!service) service = process.env.BLUESKY_SERVICE ?? process.env.BSKY_SERVICE ?? 'https://bsky.social';

  if (!handle) {
    const prompted = await promptRequired('Bluesky handle:', 'Handle is required', { placeholder: 'alice.bsky.social' });
    if (!prompted) return;
    handle = prompted;
  }
  if (!appPassword) {
    const prompted = await promptRequired('Bluesky app password:', 'App password is required', { secret: true });
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
  await fmt.panel({
    title: 'Mastodon Token Setup',
    style: 'info',
    content: `${bright('Saving Mastodon credentials for CLI and channel adapter auto-load.')}`,
  });
  console.log();

  let accessToken = stringFlag(flags, 'access-token');
  let instanceUrl = stringFlag(flags, 'instance-url');
  if (!accessToken) accessToken = process.env.MASTODON_ACCESS_TOKEN ?? '';
  if (!instanceUrl) instanceUrl = process.env.MASTODON_INSTANCE_URL ?? 'https://mastodon.social';

  if (!accessToken) {
    const prompted = await promptRequired('Mastodon access token:', 'Access token is required', { secret: true });
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
  await fmt.panel({
    title: 'Farcaster / Neynar Token Setup',
    style: 'info',
    content: `${bright('Saving Farcaster/Neynar credentials for CLI and channel adapter auto-load.')}`,
  });
  console.log();

  let neynarApiKey = stringFlag(flags, 'neynar-api-key') || stringFlag(flags, 'api-key');
  let signerUuid = stringFlag(flags, 'signer-uuid');
  let fid = stringFlag(flags, 'fid');
  if (!neynarApiKey) neynarApiKey = process.env.NEYNAR_API_KEY ?? '';
  if (!signerUuid) signerUuid = process.env.FARCASTER_SIGNER_UUID ?? '';
  if (!fid) fid = process.env.FARCASTER_FID ?? '';

  if (!neynarApiKey) {
    const prompted = await promptRequired('Neynar API key:', 'Neynar API key is required', { secret: true });
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

function printTokenSuccess(displayName: string, providerId: string, tokens: { accessToken: string; expiresAt: number }): void {
  const g = glyphs();
  const masked = tokens.accessToken.slice(0, 8) + '...' + tokens.accessToken.slice(-4);
  const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 1000 / 60);
  const unit = expiresIn > 1440 ? `${Math.round(expiresIn / 1440)} days` : `${expiresIn} minutes`;

  console.log();
  fmt.panel({
    title: `${g.ok} Authenticated`,
    style: 'success',
    content: [
      `${muted('Provider')}    ${accent(displayName)}`,
      `${muted('Token')}       ${dim(masked)}`,
      `${muted('Expires')}     ${sColor(unit)}`,
      `${muted('Stored at')}   ${accent(`~/.wunderland/auth/${providerId}.json`)}`,
    ].join('\n'),
  });
}

function printApiKeySuccess(displayName: string, envVar: string): void {
  const g = glyphs();
  fmt.panel({
    title: `${g.ok} API Key Saved`,
    style: 'success',
    content: [
      `${muted('Provider')}    ${accent(displayName)}`,
      `${muted('Env var')}     ${accent(envVar)}`,
      `${muted('Stored in')}   ${accent('~/.wunderland/.env')}`,
    ].join('\n'),
  });
}

// ── Interactive LLM provider menu ────────────────────────────────────────────

type LoginChoice = 'openai-oauth' | 'openai-key' | 'anthropic-key' | 'gemini-key' | 'openrouter-key' | 'other-key';

const LOGIN_OPTIONS: Array<{ value: LoginChoice; label: string; hint: string }> = [
  { value: 'openai-oauth',  label: 'OpenAI (ChatGPT Subscription)', hint: 'not yet supported — use API key instead' },
  { value: 'openai-key',    label: 'OpenAI (API Key)',               hint: 'paste your OPENAI_API_KEY' },
  { value: 'anthropic-key', label: 'Anthropic (API Key)',            hint: 'paste your ANTHROPIC_API_KEY' },
  { value: 'gemini-key',    label: 'Google Gemini (API Key)',        hint: 'paste your GEMINI_API_KEY' },
  { value: 'openrouter-key', label: 'OpenRouter (API Key)',          hint: 'universal — routes to any model' },
  { value: 'other-key',     label: 'Other LLM Provider...',         hint: 'Bedrock, Minimax, Qwen, etc.' },
];

async function selectLoginChoice(): Promise<LoginChoice | null> {
  const p = await import('@clack/prompts');

  p.intro(accent('LLM Authentication'));

  const selected = await p.select({
    message: 'How do you want to authenticate?',
    options: LOGIN_OPTIONS,
  });

  if (p.isCancel(selected)) {
    p.cancel('Login cancelled.');
    return null;
  }

  return selected as LoginChoice;
}

async function selectOtherProvider(): Promise<string | null> {
  const p = await import('@clack/prompts');

  // Show all LLM providers not already in the main menu
  const mainIds = new Set(['openai', 'anthropic', 'gemini', 'openrouter']);
  const others = LLM_PROVIDERS.filter((prov) => !mainIds.has(prov.id) && prov.envVar);

  const selected = await p.select({
    message: 'Select an LLM provider:',
    options: others.map((prov) => ({
      value: prov.id,
      label: prov.label,
      hint: prov.envVar,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    return null;
  }

  return selected as string;
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdLogin(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // If explicit --provider flag, dispatch directly (supports social channels too)
  if (typeof flags['provider'] === 'string' && flags['provider'].trim()) {
    const provider = flags['provider'].trim();
    await dispatchProvider(provider, flags, globals);
    return;
  }

  // Interactive menu — LLM-focused
  const choice = await selectLoginChoice();
  if (!choice) return;

  try {
    switch (choice) {
      case 'openai-oauth':
        fmt.errorBlock(
          'Not yet supported',
          'OAuth subscription-based usage (ChatGPT Plus/Pro) is not yet available.\n' +
          'OpenAI subscription token usage requires a registered OAuth application.\n' +
          'Please use an OpenAI API key instead — get one at https://platform.openai.com/api-keys',
        );
        return;
      case 'openai-key':
        await loginApiKey('openai', globals);
        break;
      case 'anthropic-key':
        await loginApiKey('anthropic', globals);
        break;
      case 'gemini-key':
        await loginApiKey('gemini', globals);
        break;
      case 'openrouter-key':
        await loginApiKey('openrouter', globals);
        break;
      case 'other-key': {
        const otherId = await selectOtherProvider();
        if (otherId) await loginApiKey(otherId, globals);
        break;
      }
    }
  } catch (err) {
    fmt.errorBlock('Login failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function dispatchProvider(
  provider: string,
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // Normalize
  if (provider === 'openai-oauth') {
    await loginOpenAIOAuth(flags, globals);
    return;
  }

  // Check if it's an LLM provider with an API key
  const llmProv = LLM_PROVIDERS.find((p) => p.id === provider);
  if (llmProv && llmProv.envVar) {
    await loginApiKey(provider, globals);
    return;
  }

  // Social channel providers
  const socialMap: Record<string, (f: Record<string, string | boolean>) => Promise<void>> = {
    twitter: loginTwitter,
    instagram: loginInstagram,
    linkedin: loginLinkedIn,
    facebook: loginFacebook,
    bluesky: loginBluesky,
    mastodon: loginMastodon,
    farcaster: loginFarcaster,
  };

  const handler = socialMap[provider];
  if (handler) {
    try {
      await handler(flags);
    } catch (err) {
      fmt.errorBlock('Login failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  fmt.errorBlock(
    'Unknown provider',
    `Try: openai, anthropic, gemini, openrouter, or use --provider <name>.`,
  );
  process.exitCode = 1;
}
