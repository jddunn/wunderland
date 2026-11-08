// @ts-nocheck
/**
 * @fileoverview Integration tests for the unsubscribe route of the security alert emails.
 * @module wunderland/security/__tests__/mail-unsubscribe.integration.test
 *
 * The link in each alert email opens createMailUnsubscribeHandler mounted on a
 * real HTTP server. A GET shows a page that asks and changes nothing, since
 * link scanners follow links. A POST, the mail client's one-click request or
 * the page's button, puts the address on the suppression list at once, and
 * the next alert skips it. No confirmation email is sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createTransport } from 'nodemailer';

import { SafeGuardrails } from '../SafeGuardrails.js';
import { NotificationManager } from '../NotificationManager.js';
import {
  createMailUnsubscribeHandler,
  isMailRecipientSuppressed,
  resumeMailRecipient,
  suppressMailRecipients,
} from '../mail-unsubscribe.js';

const UNSUBSCRIBE_URL = 'https://alerts.example.test/mail/unsubscribe';
const SECRET = 'unsubscribe-route-test-secret-0123456789';
const MAIL_ENV = [
  'WUNDERLAND_MAIL_UNSUBSCRIBE_URL',
  'WUNDERLAND_MAIL_UNSUBSCRIBE_SECRET',
  'WUNDERLAND_MAIL_SUPPRESSION_FILE',
  'WUNDERLAND_MAIL_DO_NOT_CONTACT',
  'SMTP_HOST',
  'SMTP_USER',
];

const CRITICAL_READ = {
  toolId: 'file_read',
  toolName: 'file_read',
  args: { file_path: '/etc/shadow' },
  agentId: 'agent-alerts',
};

/** Sends through nodemailer's stream transport and keeps each recipient and link. */
function captureTransport() {
  const renderer = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const sent: { to: string; link: string }[] = [];
  return {
    sent,
    transport: {
      async sendMail(message) {
        const info = await renderer.sendMail(message);
        const raw = info.message.toString('utf8');
        const head = raw.slice(0, raw.indexOf('\n\n')).replace(/\n[ \t]+/g, ' ');
        const to = /^To: (.*)$/im.exec(head)?.[1] ?? '';
        const link = /^List-Unsubscribe: <([^>]+)>$/im.exec(head)?.[1] ?? '';
        sent.push({ to, link });
        return info;
      },
    },
  };
}

describe('the unsubscribe route', () => {
  let dir: string;
  let suppressionFile: string;
  let server: Server | undefined;
  let origin: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wunderland-unsubscribe-'));
    suppressionFile = path.join(dir, 'mail-suppressions.jsonl');
    for (const name of MAIL_ENV) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Serves the handler; any path it leaves alone answers 418. */
  async function serve(options = {}) {
    const handler = createMailUnsubscribeHandler({
      unsubscribeUrl: UNSUBSCRIBE_URL,
      unsubscribeSecret: SECRET,
      suppressionFile,
      ...options,
    });
    server = createServer(async (req, res) => {
      if (!(await handler(req, res))) {
        res.statusCode = 418;
        res.end('not the unsubscribe route');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }

  /** The request a link in an email turns into on this test server. */
  function local(link: string): string {
    return `${origin}${new URL(link).pathname}`;
  }

  function guardrailsSendingTo(to: string, transport, extra = {}) {
    const guardrails = new SafeGuardrails({
      enableAuditLogging: false,
      emailConfig: {
        to,
        transport,
        unsubscribeUrl: UNSUBSCRIBE_URL,
        unsubscribeSecret: SECRET,
        suppressionFile,
        ...extra,
      },
    });
    guardrails.setFolderPermissions('agent-alerts', { defaultPolicy: 'deny', inheritFromTier: false, rules: [] });
    return guardrails;
  }

  const oneClick = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  };

  it('asks on a GET and changes nothing', async () => {
    await serve();
    const { sent, transport } = captureTransport();
    const guardrails = guardrailsSendingTo('security@example.test', transport);
    await guardrails.validateBeforeExecution(CRITICAL_READ);

    const response = await fetch(local(sent[0].link));
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page).toMatch(/<form method="post"/);
    expect(page).toContain('Unsubscribe');
    expect(page).toContain('name="viewport"');
    expect(page).not.toContain('security@example.test');
    expect(await isMailRecipientSuppressed('security@example.test', { suppressionFile })).toBe(false);

    await guardrails.validateBeforeExecution(CRITICAL_READ);
    expect(sent).toHaveLength(2);
  });

  it('suppresses at once on the one-click POST, sends no confirmation, and the next alert skips the address', async () => {
    await serve();
    const { sent, transport } = captureTransport();
    const guardrails = guardrailsSendingTo('security@example.test', transport);
    await guardrails.validateBeforeExecution(CRITICAL_READ);
    expect(sent).toHaveLength(1);

    const response = await fetch(local(sent[0].link), oneClick);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('unsubscribed');
    expect(sent).toHaveLength(1);
    expect(await isMailRecipientSuppressed('Security@Example.test', { suppressionFile })).toBe(true);

    const result = await guardrails.validateBeforeExecution(CRITICAL_READ);
    expect(result.allowed).toBe(false);
    expect(sent).toHaveLength(1);
    expect(readFileSync(suppressionFile, 'utf8')).not.toMatch(/example\.test/i);
  });

  it('reads the suppression list again before each recipient', async () => {
    const { sent, transport } = captureTransport();
    // The second address unsubscribes while the first one's email is being delivered.
    const unsubscribedDuringDelivery = {
      async sendMail(message) {
        const info = await transport.sendMail(message);
        if (sent.length === 1) await suppressMailRecipients(['second@example.test'], { suppressionFile });
        return info;
      },
    };

    await guardrailsSendingTo('first@example.test, second@example.test', unsubscribedDuringDelivery).validateBeforeExecution(
      CRITICAL_READ,
    );

    expect(sent.map((mail) => mail.to)).toEqual(['first@example.test']);
  });

  it('keeps an unsubscribe that follows a line a crash cut short', async () => {
    await serve();
    const { sent, transport } = captureTransport();
    await guardrailsSendingTo('security@example.test', transport).validateBeforeExecution(CRITICAL_READ);
    writeFileSync(suppressionFile, '{"v":1,"op":"suppress","address":"ab');

    expect((await fetch(local(sent[0].link), oneClick)).status).toBe(200);

    expect(await isMailRecipientSuppressed('security@example.test', { suppressionFile })).toBe(true);
    expect(await suppressMailRecipients(['ops@example.test'], { suppressionFile })).toBe(1);
    expect(await isMailRecipientSuppressed('ops@example.test', { suppressionFile })).toBe(true);
  });

  it('stops only the address whose link was used, whatever its case or display name', async () => {
    await serve();
    const { sent, transport } = captureTransport();
    await guardrailsSendingTo('"Doe, Jane" <Jane@Example.test>, ops@example.test', transport).validateBeforeExecution(CRITICAL_READ);
    expect(sent).toHaveLength(2);

    const response = await fetch(local(sent[0].link), { method: 'POST' });
    expect(response.status).toBe(200);

    await guardrailsSendingTo('"Doe, Jane" <Jane@Example.test>, ops@example.test', transport).validateBeforeExecution(CRITICAL_READ);
    await guardrailsSendingTo('JANE@EXAMPLE.TEST', transport).validateBeforeExecution(CRITICAL_READ);

    expect(sent).toHaveLength(3);
    expect(sent[0].to.toLowerCase()).toContain('jane@example.test');
    expect(sent.slice(1).map((mail) => mail.to)).toEqual(['ops@example.test', 'ops@example.test']);
  });

  it('answers 404 to a token this deployment did not issue and suppresses nothing', async () => {
    const { sent, transport } = captureTransport();
    await guardrailsSendingTo('security@example.test', transport, {
      unsubscribeSecret: 'a-different-deployment-secret-0123456789',
    }).validateBeforeExecution(CRITICAL_READ);
    await serve();
    const token = new URL(sent[0].link).pathname.split('/').pop();
    const truncated = `${origin}/mail/unsubscribe/${token.slice(0, 30)}`;

    for (const url of [local(sent[0].link), truncated]) {
      expect((await fetch(url)).status).toBe(404);
      expect((await fetch(url, oneClick)).status).toBe(404);
    }
    expect(existsSync(suppressionFile)).toBe(false);
  });

  it('works across a sender and a handler that share only the suppression list and its generated key', async () => {
    const { sent, transport } = captureTransport();
    await guardrailsSendingTo('security@example.test', transport, { unsubscribeSecret: undefined }).validateBeforeExecution(CRITICAL_READ);
    expect(existsSync(path.join(dir, 'mail-unsubscribe.key'))).toBe(true);
    await serve({ unsubscribeSecret: undefined });

    expect((await fetch(local(sent[0].link), oneClick)).status).toBe(200);

    expect(await isMailRecipientSuppressed('security@example.test', { suppressionFile })).toBe(true);
  });

  it('leaves other paths to the host and answers 405 to other methods', async () => {
    await serve();
    const { sent, transport } = captureTransport();
    await guardrailsSendingTo('security@example.test', transport).validateBeforeExecution(CRITICAL_READ);

    expect((await fetch(`${origin}/health`)).status).toBe(418);
    expect((await fetch(`${origin}/mail/unsubscribed`)).status).toBe(418);
    const put = await fetch(local(sent[0].link), { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD, POST');
    expect(await isMailRecipientSuppressed('security@example.test', { suppressionFile })).toBe(false);
  });

  it('serves the links behind a proxy that rewrites the path', async () => {
    await serve({ basePath: '/internal/unsubscribe/' });
    const { sent, transport } = captureTransport();
    await guardrailsSendingTo('security@example.test', transport).validateBeforeExecution(CRITICAL_READ);
    const token = new URL(sent[0].link).pathname.split('/').pop();

    expect((await fetch(`${origin}/internal/unsubscribe/${token}`, oneClick)).status).toBe(200);
    expect(await isMailRecipientSuppressed('security@example.test', { suppressionFile })).toBe(true);
  });

  it('answers links at the root of the host and leaves the host its other paths', async () => {
    const rootUrl = 'https://alerts.example.test/';
    await serve({ unsubscribeUrl: rootUrl });
    const { sent, transport } = captureTransport();
    await guardrailsSendingTo('security@example.test', transport, { unsubscribeUrl: rootUrl }).validateBeforeExecution(
      CRITICAL_READ,
    );
    expect(sent[0].link).toMatch(/^https:\/\/alerts\.example\.test\/[A-Za-z0-9_-]{40,}$/);

    expect((await fetch(`${origin}/health`)).status).toBe(418);
    expect((await fetch(local(sent[0].link))).status).toBe(200);
    expect((await fetch(local(sent[0].link), oneClick)).status).toBe(200);

    expect(await isMailRecipientSuppressed('security@example.test', { suppressionFile })).toBe(true);
  });

  it('lets the operator suppress and resume addresses, and the test notification reports a suppressed address', async () => {
    const { sent, transport } = captureTransport();
    const manager = new NotificationManager({
      enableConsoleWarnings: false,
      emailConfig: {
        to: 'security@example.test',
        transport,
        unsubscribeUrl: UNSUBSCRIBE_URL,
        unsubscribeSecret: SECRET,
        suppressionFile,
      },
    });

    expect(await suppressMailRecipients(['Security@Example.test', 'not an address'], { suppressionFile })).toBe(1);
    const suppressedResult = await manager.testNotifications();
    expect(suppressedResult.email.success).toBe(false);
    expect(suppressedResult.email.error).toMatch(/unsubscribed/);
    expect(sent).toHaveLength(0);

    expect(await resumeMailRecipient('security@example.test', { suppressionFile })).toBe(true);
    expect((await manager.testNotifications()).email.success).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('refuses to start without an address or a path to answer at', () => {
    expect(() => createMailUnsubscribeHandler({ suppressionFile })).toThrow(/unsubscribe/i);
  });
});
