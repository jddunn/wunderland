/**
 * @fileoverview Unsubscribe links, the suppression list and the unsubscribe
 * route for the security alert emails that `NotificationManager` sends.
 * @module wunderland/security/mail-unsubscribe
 *
 * Every alert email links to `<unsubscribeUrl>/<token>` in its footer and in a
 * `List-Unsubscribe` header, beside `List-Unsubscribe-Post:
 * List-Unsubscribe=One-Click` (RFC 8058). The token is the recipient's address
 * sealed with AES-256-GCM under a key derived from the unsubscribe secret: it
 * names no one to a reader, it is bound to that one address, and the only
 * thing it can do is put that address on the suppression list.
 *
 * {@link createMailUnsubscribeHandler} answers the link. A GET (or HEAD) shows
 * a page that asks, since link scanners follow links; a POST, the mail
 * client's one-click request or the page's button, suppresses the address at
 * once. No confirmation email is sent.
 *
 * The suppression list is an append-only JSON Lines file of SHA-256 address
 * hashes, read before every send. An append never rewrites earlier lines, so a
 * sending process and a web process that share the file cannot lose each
 * other's entries.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { appendFile, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Settings shared by the sender, the unsubscribe route and the suppression helpers. */
export interface MailUnsubscribeOptions {
  /**
   * The https address the unsubscribe route answers at, for example
   * `https://agents.example.com/mail/unsubscribe`. Each link is this address
   * plus `/<token>`. Default: `WUNDERLAND_MAIL_UNSUBSCRIBE_URL`. Without one,
   * no email is sent.
   */
  unsubscribeUrl?: string;
  /**
   * The secret the tokens are sealed with, at least 32 characters. Changing it
   * voids every link already sent. Default: `WUNDERLAND_MAIL_UNSUBSCRIBE_SECRET`,
   * else a key generated once into `mail-unsubscribe.key` beside the
   * suppression list.
   */
  unsubscribeSecret?: string;
  /**
   * The suppression list. Default: `WUNDERLAND_MAIL_SUPPRESSION_FILE`, else
   * `~/.wunderland/security/mail-suppressions.jsonl`.
   */
  suppressionFile?: string;
  /**
   * Addresses that are never mailed, in addition to those listed in
   * `WUNDERLAND_MAIL_DO_NOT_CONTACT` (separated by commas, semicolons or
   * white space).
   */
  doNotContact?: readonly string[];
}

/** Options for {@link createMailUnsubscribeHandler}. */
export interface MailUnsubscribeHandlerOptions extends MailUnsubscribeOptions {
  /**
   * The request path the links arrive at, for a server behind a proxy that
   * rewrites paths. Default: the path of `unsubscribeUrl`.
   */
  basePath?: string;
}

/**
 * Answers a request for an unsubscribe link and resolves `true`, or resolves
 * `false` without touching the response for any other path.
 */
export type MailUnsubscribeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const ENV_UNSUBSCRIBE_URL = 'WUNDERLAND_MAIL_UNSUBSCRIBE_URL';
const ENV_UNSUBSCRIBE_SECRET = 'WUNDERLAND_MAIL_UNSUBSCRIBE_SECRET';
const ENV_SUPPRESSION_FILE = 'WUNDERLAND_MAIL_SUPPRESSION_FILE';
const ENV_DO_NOT_CONTACT = 'WUNDERLAND_MAIL_DO_NOT_CONTACT';

const KEY_FILE_NAME = 'mail-unsubscribe.key';
const MIN_SECRET_LENGTH = 32;

const TOKEN_VERSION = 1;
const TOKEN_SALT = Buffer.from('wunderland mail unsubscribe', 'utf8');
const TOKEN_INFO = Buffer.from('token key v1', 'utf8');
const TOKEN_AAD = Buffer.from('wunderland mail unsubscribe token v1', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** base64url only; 40 characters is shorter than the shortest token. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,1024}$/;

/** An addr-spec with no quoting, comments or route: what the alerts are sent to. */
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

/** The headers RFC 8058 section 4 requires the DKIM signature to cover. */
const LIST_HEADERS = ['List-Unsubscribe', 'List-Unsubscribe-Post'] as const;

/**
 * nodemailer's default list of DKIM-signed headers (src/dkim/sign.ts). It
 * holds List-Unsubscribe but not List-Unsubscribe-Post.
 */
const NODEMAILER_DKIM_HEADERS =
  'From:Sender:Reply-To:Subject:Date:Message-ID:To:' +
  'Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:' +
  'Content-Description:Resent-Date:Resent-From:Resent-Sender:' +
  'Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References:' +
  'List-Id:List-Help:List-Unsubscribe:List-Subscribe:List-Post:' +
  'List-Owner:List-Archive:OTP-Token';

interface SuppressionLine {
  v: 1;
  op: 'suppress' | 'resume';
  /** SHA-256 of the normalized address, in hex. */
  address: string;
  at: string;
  source: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The suppression list file these options name. */
export function resolveSuppressionFile(options: MailUnsubscribeOptions = {}): string {
  const configured = options.suppressionFile?.trim() || envValue(ENV_SUPPRESSION_FILE);
  if (!configured) {
    return path.join(homedir(), '.wunderland', 'security', 'mail-suppressions.jsonl');
  }
  const expanded = configured.startsWith('~/') ? path.join(homedir(), configured.slice(2)) : configured;
  return path.resolve(expanded);
}

/**
 * The unsubscribe address checked for use in links: an https URL with no
 * query, fragment or credentials. Otherwise the reason it cannot be used.
 */
export function resolveUnsubscribeUrl(
  options: MailUnsubscribeOptions = {},
): { url: URL } | { problem: string } {
  const raw = options.unsubscribeUrl?.trim() || envValue(ENV_UNSUBSCRIBE_URL);
  const setting = `emailConfig.unsubscribeUrl (or ${ENV_UNSUBSCRIBE_URL})`;
  if (!raw) {
    return {
      problem: `no unsubscribe address: set ${setting} to the https address where createMailUnsubscribeHandler answers`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: `${setting} is not a URL` };
  }
  if (url.protocol !== 'https:') {
    return { problem: `${setting} must be an https address` };
  }
  if (url.search || url.hash || url.username || url.password) {
    return { problem: `${setting} must not carry a query, a fragment or credentials` };
  }
  return { url };
}

/** The link for one token: the unsubscribe address plus `/<token>`. */
export function unsubscribeLink(base: URL, token: string): string {
  const linkUrl = new URL(base.href);
  linkUrl.pathname = `${base.pathname.replace(/\/+$/, '')}/${token}`;
  return linkUrl.href;
}

/**
 * The bare address of a recipient written as `addr` or `Name <addr>`, in lower
 * case, or `null` when it is not a plain email address.
 */
export function normalizeMailAddress(input: string): string | null {
  let value = input.trim();
  const bracketed = /<([^<>]*)>\s*$/.exec(value);
  if (bracketed) value = (bracketed[1] ?? '').trim();
  value = value.toLowerCase();
  return ADDRESS.test(value) ? value : null;
}

/**
 * Splits a recipient list at the commas and semicolons that separate
 * recipients, leaving those inside a quoted display name or angle brackets.
 */
export function splitMailRecipients(to: string | readonly string[]): string[] {
  const recipients: string[] = [];
  for (const list of typeof to === 'string' ? [to] : to) {
    let current = '';
    let quoted = false;
    let bracketed = false;
    for (let i = 0; i < list.length; i++) {
      const ch = list.charAt(i);
      if (quoted && ch === '\\' && i + 1 < list.length) {
        current += ch + list.charAt(i + 1);
        i += 1;
        continue;
      }
      if (ch === '"' && !bracketed) quoted = !quoted;
      else if (!quoted && ch === '<') bracketed = true;
      else if (!quoted && ch === '>') bracketed = false;
      else if (!quoted && !bracketed && (ch === ',' || ch === ';')) {
        if (current.trim()) recipients.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) recipients.push(current.trim());
  }
  return recipients;
}

/** The SHA-256 of a normalized address, as the suppression list keeps it. */
export function hashMailAddress(address: string): string {
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

function tokenKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, TOKEN_SALT, TOKEN_INFO, 32));
}

/** Seals a normalized address into an unsubscribe token. */
export function createUnsubscribeToken(address: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(secret), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(TOKEN_AAD);
  const sealed = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([TOKEN_VERSION]), iv, sealed, cipher.getAuthTag()]).toString('base64url');
}

/**
 * The address a token was sealed for, or `null` for a token this secret did
 * not seal (another deployment's, a cut-short copy, a guess).
 */
export function readUnsubscribeToken(token: string, secret: string): string | null {
  if (!TOKEN_SHAPE.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length <= 1 + IV_BYTES + TAG_BYTES || raw[0] !== TOKEN_VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(secret), raw.subarray(1, 1 + IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const opened = Buffer.concat([
      decipher.update(raw.subarray(1 + IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    return normalizeMailAddress(opened);
  } catch {
    return null;
  }
}

async function readKeyFile(file: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
  const key = text.trim();
  if (key.length < MIN_SECRET_LENGTH) {
    throw new Error(`the unsubscribe key in ${file} is shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  return key;
}

/**
 * The secret the tokens are sealed with: the configured one, else the key
 * file beside the suppression list, created on first use. The key is written
 * to a file of its own and linked into place, so two processes that start
 * together end up with the same key.
 */
export async function resolveUnsubscribeSecret(options: MailUnsubscribeOptions = {}): Promise<string> {
  const configured = options.unsubscribeSecret ? options.unsubscribeSecret : envValue(ENV_UNSUBSCRIBE_SECRET);
  if (configured !== undefined) {
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new Error(`the unsubscribe secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    return configured;
  }

  const keyFile = path.join(path.dirname(resolveSuppressionFile(options)), KEY_FILE_NAME);
  const existing = await readKeyFile(keyFile);
  if (existing !== null) return existing;

  await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const content = `${randomBytes(32).toString('base64url')}\n`;
  const draft = `${keyFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(draft, content, { mode: 0o600, flag: 'wx' });
  try {
    await link(draft, keyFile);
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') {
      // A file system without hard links: create the key file directly.
      try {
        await writeFile(keyFile, content, { mode: 0o600, flag: 'wx' });
      } catch (fallbackErr) {
        if (errorCode(fallbackErr) !== 'EEXIST') throw fallbackErr;
      }
    }
  } finally {
    await unlink(draft).catch(() => undefined);
  }

  const created = await readKeyFile(keyFile);
  if (created === null) throw new Error(`the unsubscribe key ${keyFile} could not be created`);
  return created;
}

function isSuppressionLine(value: unknown): value is SuppressionLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    (line.op === 'suppress' || line.op === 'resume') &&
    typeof line.address === 'string' &&
    /^[0-9a-f]{64}$/.test(line.address)
  );
}

/**
 * The hashes of every suppressed address. A missing file is an empty list;
 * any other read error is thrown, so a sender that cannot read the list sends
 * nothing.
 */
export async function readSuppressedAddressHashes(options: MailUnsubscribeOptions = {}): Promise<Set<string>> {
  const suppressed = new Set<string>();
  let text: string;
  try {
    text = await readFile(resolveSuppressionFile(options), 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return suppressed;
    throw err;
  }
  for (const row of text.split('\n')) {
    if (!row.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch {
      // A line cut short by a crash; the lines around it still count.
      continue;
    }
    if (!isSuppressionLine(parsed)) continue;
    if (parsed.op === 'suppress') suppressed.add(parsed.address);
    else suppressed.delete(parsed.address);
  }
  return suppressed;
}

async function appendSuppressionLines(
  options: MailUnsubscribeOptions,
  op: SuppressionLine['op'],
  hashes: readonly string[],
  source: string,
): Promise<void> {
  if (hashes.length === 0) return;
  const file = resolveSuppressionFile(options);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  // The batch starts on a line of its own: a last line that a crash cut short
  // ends without a newline and would otherwise swallow the first new entry.
  // The reader skips the blank lines this leaves.
  const text = `\n${hashes
    .map((address) => `${JSON.stringify({ v: 1, op, address, at, source } satisfies SuppressionLine)}\n`)
    .join('')}`;
  await appendFile(file, text, { mode: 0o600 });
}

/**
 * Puts addresses on the suppression list, for an operator loading a
 * do-not-contact list or acting on a request made outside the link. Resolves
 * how many of them were email addresses.
 */
export async function suppressMailRecipients(
  addresses: Iterable<string>,
  options: MailUnsubscribeOptions = {},
): Promise<number> {
  const hashes = new Set<string>();
  for (const entry of addresses) {
    const address = normalizeMailAddress(entry);
    if (address) hashes.add(hashMailAddress(address));
  }
  await appendSuppressionLines(options, 'suppress', [...hashes], 'operator');
  return hashes.size;
}

/**
 * Takes an address off the suppression list, for a person who asked to get the
 * alerts again. Resolves `false` when the input is not an email address.
 */
export async function resumeMailRecipient(address: string, options: MailUnsubscribeOptions = {}): Promise<boolean> {
  const normalized = normalizeMailAddress(address);
  if (!normalized) return false;
  await appendSuppressionLines(options, 'resume', [hashMailAddress(normalized)], 'operator');
  return true;
}

/** Whether an address is on the suppression list. */
export async function isMailRecipientSuppressed(
  address: string,
  options: MailUnsubscribeOptions = {},
): Promise<boolean> {
  const normalized = normalizeMailAddress(address);
  if (!normalized) return false;
  return (await readSuppressedAddressHashes(options)).has(hashMailAddress(normalized));
}

/** The normalized addresses that are never mailed: the configured ones and the environment's. */
export function resolveDoNotContact(options: MailUnsubscribeOptions = {}): Set<string> {
  const blocked = new Set<string>();
  const entries = [...(options.doNotContact ?? []), ...(process.env[ENV_DO_NOT_CONTACT] ?? '').split(/[\s,;]+/)];
  for (const entry of entries) {
    const address = entry ? normalizeMailAddress(entry) : null;
    if (address) blocked.add(address);
  }
  return blocked;
}

/** The two RFC 8058 headers for a link, passed to nodemailer as prepared values. */
export function unsubscribeHeaders(linkHref: string): Record<string, { prepared: true; value: string }> {
  return {
    'List-Unsubscribe': { prepared: true, value: `<${linkHref}>` },
    'List-Unsubscribe-Post': { prepared: true, value: 'List-Unsubscribe=One-Click' },
  };
}

/** The footer every alert email ends with. */
export function unsubscribeFooter(linkHref: string): string {
  return [
    '--',
    'You get this email because this address is set to receive security alerts from a Wunderland deployment.',
    `Unsubscribe: ${linkHref}`,
  ].join('\n');
}

/**
 * nodemailer DKIM options that sign both list headers: they are added to the
 * signed header names (nodemailer's default list when none is given) and
 * taken out of any skipped ones.
 */
export function dkimSigningUnsubscribeHeaders(dkim: Record<string, unknown>): Record<string, unknown> {
  const named =
    typeof dkim.headerFieldNames === 'string' && dkim.headerFieldNames.trim()
      ? dkim.headerFieldNames
      : NODEMAILER_DKIM_HEADERS;
  const fields = named
    .split(':')
    .map((field) => field.trim())
    .filter(Boolean);
  for (const header of LIST_HEADERS) {
    if (!fields.some((field) => field.toLowerCase() === header.toLowerCase())) fields.push(header);
  }
  const signed: Record<string, unknown> = { ...dkim, headerFieldNames: fields.join(':') };
  if (typeof dkim.skipFields === 'string') {
    const listHeaders = LIST_HEADERS.map((header) => header.toLowerCase());
    signed.skipFields = dkim.skipFields
      .split(':')
      .map((field) => field.trim())
      .filter((field) => field && !listHeaders.includes(field.toLowerCase()))
      .join(':');
  }
  return signed;
}

// ── The unsubscribe route ──────────────────────────────────────────────────

interface Page {
  title: string;
  paragraphs: string[];
  button?: string;
  note?: string;
}

const PAGES = {
  ask: {
    title: 'Stop security alert emails',
    paragraphs: [
      'Unsubscribe this address from the security alert emails this Wunderland deployment sends.',
      'These alerts are the only email it sends, so this stops all of its email to you.',
    ],
    button: 'Unsubscribe',
    note: "The alerts still reach the deployment's audit log and webhooks. No confirmation email is sent.",
  },
  done: {
    title: 'You are unsubscribed',
    paragraphs: [
      'This address gets no more security alert emails from this Wunderland deployment. No confirmation email is sent.',
      'To get the alerts again, ask the person who runs this deployment.',
    ],
  },
  invalid: {
    title: 'This unsubscribe link does not work',
    paragraphs: [
      'This deployment did not issue it, or part of it was lost when it was copied. Open the link from the email again.',
    ],
  },
  unavailable: {
    title: 'Try again in a minute',
    paragraphs: ['The unsubscribe could not be saved, so nothing changed. Open the link from the email again.'],
  },
  method: {
    title: 'Open the link from the email',
    paragraphs: ['This address answers the unsubscribe link in a security alert email.'],
  },
} satisfies Record<string, Page>;

function renderPage(page: Page): string {
  const paragraphs = page.paragraphs.map((text) => `<p>${text}</p>`).join('\n');
  const form = page.button ? `<form method="post"><button type="submit">${page.button}</button></form>` : '';
  const note = page.note ? `<p class="note">${page.note}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${page.title}</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1b1f; --muted: #55555f; --accent: #3b2fc9; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #131316; --fg: #ececf1; --muted: #a7a7b3; --accent: #9d95ff; --on-accent: #131316; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 3rem 1rem; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1rem; }
p { margin: 0 0 1rem; }
.note { color: var(--muted); font-size: 15px; }
button { font: inherit; font-weight: 600; min-height: 44px; padding: 0.6rem 1.4rem; margin: 0.5rem 0 1.5rem; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>${page.title}</h1>
${paragraphs}
${form}
${note}
</main>
</body>
</html>
`;
}

function sendPage(res: ServerResponse, status: number, page: Page): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.end(renderPage(page));
}

function resolveBasePath(options: MailUnsubscribeHandlerOptions): string {
  let base = options.basePath?.trim();
  if (!base) {
    const resolved = resolveUnsubscribeUrl(options);
    if ('problem' in resolved) {
      throw new Error(`createMailUnsubscribeHandler: ${resolved.problem}, or pass basePath`);
    }
    base = resolved.url.pathname;
  }
  base = base.replace(/\/+$/, '');
  return base.startsWith('/') ? base : `/${base}`;
}

/**
 * The route that answers the unsubscribe links, for a `node:http` server or
 * any framework that hands over Node's request and response (Express,
 * Fastify's `raw`, Nest on Express). Mount it at the path of
 * `unsubscribeUrl`, on the host that address names.
 *
 * - GET or HEAD `<path>/<token>`: a page that asks, with an Unsubscribe button. Nothing changes.
 * - POST `<path>/<token>`: the address is suppressed at once and the next
 *   alert skips it. This is the request a mail client sends for
 *   `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, with no cookies and no sign-in.
 * - A token this deployment did not seal: 404. A suppression list that
 *   cannot be written: 503, so the client tries again. Other methods: 405.
 *
 * @throws When neither `basePath` nor a usable `unsubscribeUrl` is given.
 */
export function createMailUnsubscribeHandler(options: MailUnsubscribeHandlerOptions = {}): MailUnsubscribeHandler {
  const prefix = `${resolveBasePath(options)}/`;

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(prefix)) return false;
    const token = pathname.slice(prefix.length);
    if (!token || token.includes('/')) return false;

    // The body (the one-click form field) carries nothing the route needs.
    req.resume();

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendPage(res, 405, PAGES.method);
      return true;
    }

    let address: string | null;
    try {
      address = TOKEN_SHAPE.test(token) ? readUnsubscribeToken(token, await resolveUnsubscribeSecret(options)) : null;
    } catch (err) {
      console.error(`[EMAIL] Unsubscribe link not answered: the key could not be read (${describeError(err)})`);
      sendPage(res, 503, PAGES.unavailable);
      return true;
    }
    if (!address) {
      console.warn('[EMAIL] Unsubscribe link refused: this deployment did not issue its token');
      sendPage(res, 404, PAGES.invalid);
      return true;
    }

    if (method !== 'POST') {
      sendPage(res, 200, PAGES.ask);
      return true;
    }

    try {
      await appendSuppressionLines(options, 'suppress', [hashMailAddress(address)], 'unsubscribe link');
    } catch (err) {
      console.error(`[EMAIL] Unsubscribe not saved: the suppression list could not be written (${describeError(err)})`);
      sendPage(res, 503, PAGES.unavailable);
      return true;
    }
    console.info('[EMAIL] One address unsubscribed from the security alert emails');
    sendPage(res, 200, PAGES.done);
    return true;
  };
}
