/**
 * @fileoverview `wunderland connect <service>` — OAuth-based service connections.
 * Currently supports Gmail. Opens the user's browser, runs a temporary local
 * callback server, exchanges the authorization code via PKCE, and persists
 * tokens in ~/.wunderland/config.json.
 * @module wunderland/cli/commands/connect
 */

import chalk from 'chalk';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { URL } from 'node:url';
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

// ── Gmail flow ───────────────────────────────────────────────────────────────

async function connectGmail(): Promise<void> {
  const clientId =
    process.env.GOOGLE_CLIENT_ID ||
    process.env.AUTH_GOOGLE_ID ||
    DEFAULT_GOOGLE_CLIENT_ID;
  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || '';

  const { verifier, challenge } = generatePKCE();

  // Find a free port by binding to 0 and reading back the assigned port.
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

    // Timeout after 5 minutes.
    setTimeout(() => {
      callbackServer.close();
      reject(new Error('OAuth timeout — no response within 5 minutes'));
    }, 300_000);
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

// ── Entry point ──────────────────────────────────────────────────────────────

export default async function connectCommand(args: string[]): Promise<void> {
  const service = args[0];

  if (!service) {
    console.log(`
  ${accent('Usage:')} wunderland connect <service>

  ${accent('Available services:')}
    ${chalk.white('gmail')}      Connect Gmail account via Google OAuth

  ${accent('Examples:')}
    ${muted('wunderland connect gmail')}
    `);
    return;
  }

  if (service === 'gmail') {
    await connectGmail();
  } else {
    console.log(chalk.red(`Unknown service: ${service}`));
    console.log(muted('Available: gmail'));
  }
}
