/**
 * @fileoverview `wunderland connect <service>` — OAuth-based service connections.
 * Supports Gmail, WhatsApp (Twilio / Meta), Slack (OAuth via rabbithole.inc),
 * and Signal (signal-cli setup wizard).
 *
 * Gmail supports three credential ingestion paths:
 *   1. `--credentials <path>` flag pointing to a Google OAuth client secret JSON
 *   2. Auto-discovery of `client_secret*.json` in ~/Downloads
 *   3. Manual env vars `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
 *
 * @module wunderland/cli/commands/connect
 */

import chalk from 'chalk';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { URL } from 'node:url';
import { createInterface } from 'node:readline';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { accent, muted } from '../ui/theme.js';

// Default Google OAuth client ID — "Desktop app" type, safe to embed.
// Users can override with GOOGLE_CLIENT_ID env var.
const DEFAULT_GOOGLE_CLIENT_ID =
  '937557153344-qv88lfkiege3udnv9v84fhkabpra77rv.apps.googleusercontent.com';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process');
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

// ── Google credential ingestion helpers ──────────────────────────────────────

/**
 * Parse a Google OAuth client secret JSON file (the file you download from
 * the Google Cloud Console). Handles both `{"installed": {...}}` (Desktop app)
 * and `{"web": {...}}` (Web application) wrapper formats.
 *
 * @param filePath - Absolute or relative path to the JSON file.
 * @returns Extracted `clientId` and `clientSecret`.
 * @throws If the file is missing, malformed, or lacks required fields.
 */
function parseGoogleCredentialsFile(filePath: string): { clientId: string; clientSecret: string } {
  const resolved = path.resolve(filePath);
  const raw = readFileSync(resolved, 'utf-8');
  const json = JSON.parse(raw);

  // Google downloads either {"installed": {...}} or {"web": {...}}
  const creds = json.installed || json.web;
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error('Invalid Google credentials file — missing client_id or client_secret');
  }

  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

/**
 * Auto-discover a Google OAuth client secret JSON in the user's ~/Downloads
 * folder. Looks for files matching `client_secret*.json` and returns the
 * newest one (by modification time).
 *
 * @returns Parsed credentials plus the file path, or `null` if nothing found.
 */
async function discoverGoogleCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
  path: string;
} | null> {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  try {
    const files = readdirSync(downloadsDir)
      .filter(f => f.startsWith('client_secret') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(downloadsDir, f),
        mtime: statSync(path.join(downloadsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (files.length === 0) return null;

    const newest = files[0];
    const creds = parseGoogleCredentialsFile(newest.path);
    return { ...creds, path: newest.path };
  } catch {
    return null;
  }
}

// ── Gmail flow ───────────────────────────────────────────────────────────────

async function connectGmail(credentialsFile?: string): Promise<void> {
  let clientId =
    process.env.GOOGLE_CLIENT_ID ||
    process.env.AUTH_GOOGLE_ID ||
    DEFAULT_GOOGLE_CLIENT_ID;
  let clientSecret =
    process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || '';

  const { verifier, challenge } = generatePKCE();

  // Fixed port for OAuth callback — must match Google Cloud Console redirect URI.
  // Port 19832 chosen to avoid conflicts with common services.
  const port = 19832;
  const redirectUri = `http://localhost:${port}/callback`;

  // ── Path 1: --credentials flag — parse the user-provided file ────────
  if (credentialsFile) {
    try {
      const parsed = parseGoogleCredentialsFile(credentialsFile);
      clientId = parsed.clientId;
      clientSecret = parsed.clientSecret;
      console.log(`\n  ${chalk.green('\u2713')}  Loaded credentials from ${chalk.cyan(path.basename(credentialsFile))}`);
      console.log(`     Client ID: ${clientId.slice(0, 20)}...`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`\n  ${chalk.red('\u2717')}  Failed to parse credentials file: ${message}`);
      return;
    }
  }

  // Guide users to create their own Google Cloud project if no credentials are set.
  const usingDefaultClientId = clientId === DEFAULT_GOOGLE_CLIENT_ID;
  if (usingDefaultClientId || !clientSecret) {
    // ── Path 2: Auto-discover from ~/Downloads ───────────────────────────
    const discovered = await discoverGoogleCredentials();
    if (discovered) {
      console.log(`\n  ${chalk.green('\u2713')}  Found Google credentials: ${chalk.cyan(path.basename(discovered.path))}`);
      console.log(`     Client ID: ${discovered.clientId.slice(0, 20)}...`);

      const useIt = await prompt(`\n  ${accent('Use these credentials? (Y/n):')} `);
      if (!useIt || useIt.toLowerCase() === 'y' || useIt.toLowerCase() === 'yes') {
        clientId = discovered.clientId;
        clientSecret = discovered.clientSecret;
      }
    }
  }

  // Re-check after auto-discovery — if still on defaults, show the manual guide.
  const stillDefault = clientId === DEFAULT_GOOGLE_CLIENT_ID;
  if (stillDefault || !clientSecret) {
    console.log(`\n  ${chalk.yellow('\u26A0')}  ${chalk.yellow('Gmail requires your own Google Cloud credentials.')}`);
    console.log(`     Our app is not yet verified by Google, so you need your own project.\n`);
    console.log(`     ${accent('Quick setup (5 minutes):')}`);
    console.log(`     1. Go to ${muted('https://console.cloud.google.com/apis/credentials')}`);
    console.log(`     2. Create a project (or select existing)`);
    console.log(`     3. Enable the ${accent('Gmail API')}: ${muted('https://console.cloud.google.com/apis/library/gmail.googleapis.com')}`);
    console.log(`     4. Go to ${accent('Credentials')} → ${accent('Create Credentials')} → ${accent('OAuth client ID')}`);
    console.log(`     5. Application type: ${accent('Desktop app')}`);
    console.log(`     6. Download the JSON file (${accent('client_secret_*.json')})\n`);
    console.log(`     Then either:`);
    console.log(`     ${accent('a)')} Run: ${muted('wunderland connect gmail --credentials ~/Downloads/client_secret_*.json')}`);
    console.log(`     ${accent('b)')} Drop the file in ~/Downloads and re-run ${muted('wunderland connect gmail')} (auto-detected)`);
    console.log(`     ${accent('c)')} Set environment variables:`);
    console.log(`        ${muted('export GOOGLE_CLIENT_ID=your-client-id')}`);
    console.log(`        ${muted('export GOOGLE_CLIENT_SECRET=your-secret')}`);
    console.log(`        ${muted('wunderland connect gmail')}\n`);

    if (stillDefault) {
      console.log(`     ${chalk.red('Cannot proceed without your own credentials.')}\n`);
      return;
    }
  }

  console.log(`\n  ${accent('Connecting Gmail...')}`);
  console.log(`  ${muted('Opening browser for Google authorization...')}\n`);

  // Build consent URL.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // Start callback server and wait for the authorization code.
  const code = await new Promise<string>((resolve, reject) => {
    const callbackServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);

      if (url.pathname === '/callback') {
        const authCode = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>',
          );
          callbackServer.close();
          reject(new Error(`Google OAuth error: ${error}`));
          return;
        }

        if (authCode) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h2>Gmail connected!</h2><p>You can close this window and return to the terminal.</p></body></html>',
          );
          callbackServer.close();
          resolve(authCode);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    callbackServer.listen(port, '127.0.0.1', () => {
      openBrowser(authUrl);
    });

    // Timeout after 10 minutes.
    setTimeout(() => {
      callbackServer.close();
      reject(new Error('OAuth timeout — no response within 10 minutes'));
    }, 600_000);
  });

  console.log(`  ${muted('Received authorization, exchanging for tokens...')}`);

  // Exchange code for tokens.
  const tokenParams: Record<string, string> = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  };

  // Include client_secret if available (web app flow); omit for PKCE-only (desktop).
  if (clientSecret) {
    tokenParams.client_secret = clientSecret;
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenParams),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    if (err.includes('client_secret')) {
      throw new Error(
        `Token exchange failed: ${err}\n\n` +
        `  Your Google OAuth client requires a client_secret.\n` +
        `  Set GOOGLE_CLIENT_SECRET in your .env file:\n` +
        `    GOOGLE_CLIENT_SECRET=your-secret-here\n` +
        `  Find it at: https://console.cloud.google.com/apis/credentials`,
      );
    }
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Fetch user email.
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = (await userRes.json()) as { email?: string };
  const email = userInfo.email || 'unknown';

  // Persist tokens to ~/.wunderland/config.json.
  const { loadConfig, saveConfig } = await import('../config/config-manager.js');
  const config = await loadConfig();
  if (!config.google) config.google = {};
  config.google.clientId = clientId;
  if (clientSecret) config.google.clientSecret = clientSecret;
  config.google.refreshToken = tokens.refresh_token;
  config.google.accessToken = tokens.access_token;
  config.google.email = email;
  config.google.expiresAt = Date.now() + tokens.expires_in * 1000;
  await saveConfig(config);

  // Set env vars for current session so extensions pick them up immediately.
  process.env.GOOGLE_CLIENT_ID = clientId;
  if (clientSecret) process.env.GOOGLE_CLIENT_SECRET = clientSecret;
  if (tokens.refresh_token) process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;

  console.log(`
  ${accent('+')} Gmail connected: ${chalk.white(email)}

  ${muted('Tokens saved to agent config.')}
  ${muted('Gmail extension will auto-activate on next')} ${chalk.white('wunderland chat')} ${muted('or')} ${chalk.white('wunderland start')}
  `);
}

// ── Interactive prompt helper ────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── WhatsApp flow ────────────────────────────────────────────────────────────

async function connectWhatsApp(): Promise<void> {
  console.log(`\n  ${accent('Connecting WhatsApp...')}\n`);

  const choice = await prompt(
    `  Which provider?\n    ${chalk.white('1)')} Twilio\n    ${chalk.white('2)')} Meta Cloud API\n\n  ${accent('Choice (1/2):')} `
  );

  const { loadConfig, saveConfig } = await import('../config/config-manager.js');
  const config = await loadConfig();

  if (choice === '1') {
    // Twilio path
    const accountSid = await prompt(`  ${accent('Twilio Account SID:')} `);
    const authToken = await prompt(`  ${accent('Twilio Auth Token:')} `);
    const phoneNumber = await prompt(`  ${accent('WhatsApp phone number (e.g. +14155238886):')} `);

    if (!accountSid || !authToken) {
      console.log(chalk.red('\n  Account SID and Auth Token are required.'));
      return;
    }

    console.log(`\n  ${muted('Verifying Twilio credentials...')}`);

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          },
        }
      );

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Twilio verification failed (${res.status}): ${errBody}`);
      }

      const account = (await res.json()) as { friendly_name?: string; status?: string };
      console.log(`  ${muted(`Account: ${account.friendly_name || accountSid} (${account.status || 'unknown'})`)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\n  Twilio verification failed: ${message}`));
      return;
    }

    config.whatsapp = {
      provider: 'twilio',
      accountSid,
      authToken,
      phoneNumber,
    };
    await saveConfig(config);

    console.log(`
  ${accent('+')} WhatsApp connected via Twilio: ${chalk.white(phoneNumber || '(no number)')}

  ${muted('Credentials saved to agent config.')}
  ${muted('WhatsApp channel will auto-activate on next')} ${chalk.white('wunderland chat')} ${muted('or')} ${chalk.white('wunderland start')}
    `);
  } else if (choice === '2') {
    // Meta Cloud API path — OAuth via browser
    const { verifier, challenge } = generatePKCE();

    const port = await new Promise<number>((resolve, reject) => {
      const tmp = createServer();
      tmp.listen(0, '127.0.0.1', () => {
        const addr = tmp.address();
        if (!addr || typeof addr === 'string') {
          tmp.close();
          reject(new Error('Could not determine a free port'));
          return;
        }
        const p = addr.port;
        tmp.close(() => resolve(p));
      });
    });

    const redirectUri = `http://localhost:${port}/callback`;

    const scopes = [
      'whatsapp_business_management',
      'whatsapp_business_messaging',
    ].join(',');

    const appId = process.env.FACEBOOK_APP_ID || process.env.META_APP_ID || '';
    if (!appId) {
      console.log(chalk.red('\n  FACEBOOK_APP_ID or META_APP_ID env var is required for Meta OAuth.'));
      return;
    }

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;

    console.log(`  ${muted('Opening browser for Facebook Business authorization...')}\n`);

    const code = await new Promise<string>((resolve, reject) => {
      const callbackServer = createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${port}`);

        if (url.pathname === '/callback') {
          const authCode = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>');
            callbackServer.close();
            reject(new Error(`Facebook OAuth error: ${error}`));
            return;
          }

          if (authCode) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>WhatsApp connected!</h2><p>You can close this window and return to the terminal.</p></body></html>');
            callbackServer.close();
            resolve(authCode);
            return;
          }
        }

        res.writeHead(404);
        res.end('Not found');
      });

      callbackServer.listen(port, '127.0.0.1', () => {
        openBrowser(authUrl);
      });

      setTimeout(() => {
        callbackServer.close();
        reject(new Error('OAuth timeout — no response within 5 minutes'));
      }, 300_000);
    });

    console.log(`  ${muted('Received authorization, exchanging for tokens...')}`);

    const appSecret = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET || '';
    const tokenParams: Record<string, string> = {
      client_id: appId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    };
    if (appSecret) tokenParams.client_secret = appSecret;

    const tokenRes = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?${new URLSearchParams(tokenParams).toString()}`
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Token exchange failed: ${err}`);
    }

    const tokens = (await tokenRes.json()) as { access_token: string };

    // Fetch WhatsApp Business Account info
    const bizRes = await fetch(
      'https://graph.facebook.com/v18.0/me/businesses?fields=id,name',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    const bizData = (await bizRes.json()) as { data?: Array<{ id: string; name: string }> };
    const businessId = bizData?.data?.[0]?.id || '';

    const phoneNumberId = await prompt(`  ${accent('WhatsApp Phone Number ID (from Meta dashboard):')} `);

    config.whatsapp = {
      provider: 'meta',
      accessToken: tokens.access_token,
      businessId,
      phoneNumberId,
    };
    await saveConfig(config);

    console.log(`
  ${accent('+')} WhatsApp connected via Meta Cloud API
  ${muted(`Business ID: ${businessId || '(not detected)'}`)}
  ${muted(`Phone Number ID: ${phoneNumberId || '(not set)'}`)}

  ${muted('Tokens saved to agent config.')}
  ${muted('WhatsApp channel will auto-activate on next')} ${chalk.white('wunderland chat')} ${muted('or')} ${chalk.white('wunderland start')}
    `);
  } else {
    console.log(chalk.red('\n  Invalid choice. Please run again and select 1 or 2.'));
  }
}

// ── Slack flow ───────────────────────────────────────────────────────────────

async function connectSlack(): Promise<void> {
  console.log(`\n  ${accent('Connecting Slack...')}`);
  console.log(`  ${muted('Opening browser for Slack authorization via Rabbithole...')}\n`);

  const token = randomBytes(32).toString('hex');
  const oauthUrl = `https://rabbithole.inc/api/channels/oauth/slack/initiate?cli=true&token=${token}`;

  await openBrowser(oauthUrl);

  console.log(`  ${muted('Waiting for Slack authorization (timeout: 5 minutes)...')}`);

  const pollUrl = `https://rabbithole.inc/api/channels/oauth/slack/cli-poll?token=${token}`;
  const deadline = Date.now() + 300_000; // 5 minutes

  const { loadConfig, saveConfig } = await import('../config/config-manager.js');

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const res = await fetch(pollUrl);
      if (!res.ok) continue;

      const data = (await res.json()) as {
        status?: string;
        workspace?: string;
        channel?: string;
        botToken?: string;
      };

      if (data.status === 'connected') {
        const config = await loadConfig();
        config.slack = {
          workspace: data.workspace,
          channel: data.channel,
          botToken: data.botToken,
        };
        await saveConfig(config);

        console.log(`
  ${accent('+')} Slack connected: ${chalk.white(data.workspace || '(workspace)')} / ${chalk.white(data.channel || '(channel)')}

  ${muted('Connection saved to agent config.')}
  ${muted('Slack channel will auto-activate on next')} ${chalk.white('wunderland chat')} ${muted('or')} ${chalk.white('wunderland start')}
        `);
        return;
      }
    } catch {
      // Poll failure — keep trying
    }
  }

  console.log(chalk.red('\n  Slack authorization timed out (5 minutes). Please try again.'));
}

// ── Signal flow ──────────────────────────────────────────────────────────────

async function connectSignal(): Promise<void> {
  console.log(`\n  ${accent('Connecting Signal...')}`);
  console.log(`  ${muted('Signal setup wizard via signal-cli')}\n`);

  const { exec: execCb } = await import('node:child_process');

  // Step 1: Check for signal-cli
  const signalCliPath = await new Promise<string | null>((resolve) => {
    execCb('which signal-cli', (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.trim());
    });
  });

  if (!signalCliPath) {
    console.log(chalk.red('  signal-cli not found on PATH.\n'));
    console.log(`  ${accent('Install signal-cli:')}`);
    console.log(`    ${muted('macOS:')}   ${chalk.white('brew install signal-cli')}`);
    console.log(`    ${muted('Linux:')}   ${chalk.white('apt install signal-cli')}`);
    console.log(`    ${muted('Manual:')}  ${chalk.white('https://github.com/AsamK/signal-cli/releases')}\n`);
    return;
  }

  console.log(`  ${muted(`Found signal-cli at: ${signalCliPath}`)}\n`);

  // Step 2: Prompt for phone number
  const phoneNumber = await prompt(`  ${accent('Phone number (with country code, e.g. +1234567890):')} `);
  if (!phoneNumber || !phoneNumber.startsWith('+')) {
    console.log(chalk.red('\n  Phone number must start with + and include country code.'));
    return;
  }

  // Step 3: Register
  console.log(`\n  ${muted('Registering with Signal...')}`);

  const registerResult = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    execCb(`signal-cli -a ${phoneNumber} register`, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, output: stderr || error.message });
      else resolve({ ok: true, output: stdout });
    });
  });

  if (!registerResult.ok) {
    console.log(chalk.red(`\n  Registration failed: ${registerResult.output}`));
    return;
  }

  console.log(`  ${muted('Registration initiated. Check your SMS for a verification code.')}\n`);

  // Step 4: Verification code
  const verificationCode = await prompt(`  ${accent('Enter 6-digit verification code:')} `);
  if (!verificationCode || verificationCode.length < 3) {
    console.log(chalk.red('\n  Invalid verification code.'));
    return;
  }

  console.log(`\n  ${muted('Verifying...')}`);

  const verifyResult = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    execCb(`signal-cli -a ${phoneNumber} verify ${verificationCode}`, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, output: stderr || error.message });
      else resolve({ ok: true, output: stdout });
    });
  });

  if (!verifyResult.ok) {
    console.log(chalk.red(`\n  Verification failed: ${verifyResult.output}`));
    return;
  }

  // Step 5: Save config
  const { loadConfig, saveConfig } = await import('../config/config-manager.js');
  const config = await loadConfig();
  config.signal = {
    phoneNumber,
    cliPath: signalCliPath,
  };
  await saveConfig(config);

  console.log(`
  ${accent('+')} Signal connected: ${chalk.white(phoneNumber)}

  ${muted('Configuration saved to agent config.')}
  ${muted('Signal channel will auto-activate on next')} ${chalk.white('wunderland chat')} ${muted('or')} ${chalk.white('wunderland start')}
  `);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export default async function connectCommand(
  args: string[],
  flags?: Record<string, string | boolean>,
): Promise<void> {
  const service = args[0];

  if (!service) {
    console.log(`
  ${accent('Usage:')} wunderland connect <service>

  ${accent('Available services:')}
    ${chalk.white('gmail')}      Connect Gmail account via Google OAuth
    ${chalk.white('whatsapp')}   Connect WhatsApp via Twilio or Meta Cloud API
    ${chalk.white('slack')}      Connect Slack workspace via OAuth
    ${chalk.white('signal')}     Connect Signal via signal-cli

  ${accent('Examples:')}
    ${muted('wunderland connect gmail')}
    ${muted('wunderland connect gmail --credentials ~/Downloads/client_secret_*.json')}
    ${muted('wunderland connect whatsapp')}
    ${muted('wunderland connect slack')}
    ${muted('wunderland connect signal')}
    `);
    return;
  }

  // Parse --credentials flag from either the flags object (from CLI parser)
  // or directly from the args array (e.g. ['gmail', '--credentials', '/path']).
  let credentialsFile: string | undefined;
  if (flags && typeof flags['credentials'] === 'string') {
    credentialsFile = flags['credentials'];
  } else {
    const credIdx = args.indexOf('--credentials');
    if (credIdx !== -1 && credIdx + 1 < args.length) {
      credentialsFile = args[credIdx + 1];
    }
  }

  switch (service) {
    case 'gmail':
      await connectGmail(credentialsFile);
      break;
    case 'whatsapp':
      await connectWhatsApp();
      break;
    case 'slack':
      await connectSlack();
      break;
    case 'signal':
      await connectSignal();
      break;
    default:
      console.log(chalk.red(`Unknown service: ${service}`));
      console.log(muted('Available: gmail, whatsapp, slack, signal'));
  }
}
