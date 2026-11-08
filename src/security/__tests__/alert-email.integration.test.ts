// @ts-nocheck
/**
 * @fileoverview Integration tests for the security alert emails.
 * @module wunderland/security/__tests__/alert-email.integration.test
 *
 * A high or critical violation reaches NotificationManager through
 * SafeGuardrails, which composes the email with nodemailer. Every email
 * carries a visible unsubscribe link and the RFC 8058 one-click headers, goes
 * to one recipient at a time, and never goes to an address on the
 * do-not-contact list. These tests send through nodemailer's stream transport
 * and read the raw messages it produces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createTransport } from 'nodemailer';

import { SafeGuardrails } from '../SafeGuardrails.js';
import { NotificationManager } from '../NotificationManager.js';

const UNSUBSCRIBE_URL = 'https://alerts.example.test/mail/unsubscribe';
const SECRET = 'alert-email-test-secret-0123456789abcdef';
const MAIL_ENV = [
  'WUNDERLAND_MAIL_UNSUBSCRIBE_URL',
  'WUNDERLAND_MAIL_UNSUBSCRIBE_SECRET',
  'WUNDERLAND_MAIL_SUPPRESSION_FILE',
  'WUNDERLAND_MAIL_DO_NOT_CONTACT',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
];

/** A read of /etc/shadow by an agent with no allowed folders: a critical violation. */
const CRITICAL_READ = {
  toolId: 'file_read',
  toolName: 'file_read',
  args: { file_path: '/etc/shadow' },
  agentId: 'agent-alerts',
};

interface ParsedMail {
  header(name: string): string | undefined;
  body: string;
}

/** Splits a raw message into unfolded headers and its decoded text body. */
function parseMail(raw: string): ParsedMail {
  const split = raw.indexOf('\n\n');
  const head = raw.slice(0, split).replace(/\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim());
  }
  let body = raw.slice(split + 2);
  if ((headers.get('content-transfer-encoding') ?? '').toLowerCase() === 'quoted-printable') {
    body = body
      .replace(/=\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return { header: (name) => headers.get(name.toLowerCase()), body };
}

/** A transport that renders each message with nodemailer and keeps it. */
function captureTransport() {
  const renderer = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const sent: ParsedMail[] = [];
  return {
    sent,
    transport: {
      async sendMail(message) {
        const info = await renderer.sendMail(message);
        sent.push(parseMail(info.message.toString('utf8')));
        return info;
      },
    },
  };
}

/** The https link inside a List-Unsubscribe header. */
function linkOf(mail: ParsedMail): string {
  const match = /^<(https:\/\/[^>]+)>$/.exec(mail.header('list-unsubscribe') ?? '');
  return match ? match[1] : '';
}

describe('security alert emails', () => {
  let dir: string;
  let suppressionFile: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wunderland-alert-email-'));
    suppressionFile = path.join(dir, 'mail-suppressions.jsonl');
    for (const name of MAIL_ENV) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function guardrailsSendingTo(to: string, transport, extra = {}) {
    const guardrails = new SafeGuardrails({
      enableAuditLogging: false,
      emailConfig: {
        to,
        from: 'wunderland@example.test',
        transport,
        unsubscribeUrl: UNSUBSCRIBE_URL,
        unsubscribeSecret: SECRET,
        suppressionFile,
        ...extra,
      },
    });
    guardrails.setFolderPermissions('agent-alerts', {
      defaultPolicy: 'deny',
      inheritFromTier: false,
      rules: [],
    });
    return guardrails;
  }

  it('carries a visible unsubscribe link and both one-click headers', async () => {
    const { sent, transport } = captureTransport();
    const guardrails = guardrailsSendingTo('security@example.test', transport);

    const result = await guardrails.validateBeforeExecution(CRITICAL_READ);

    expect(result.allowed).toBe(false);
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail.header('to')).toBe('security@example.test');
    expect(mail.body).toContain('Security Violation Detected');

    const link = linkOf(mail);
    expect(link).toMatch(/^https:\/\/alerts\.example\.test\/mail\/unsubscribe\/[A-Za-z0-9_-]{40,}$/);
    expect(mail.header('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    expect(mail.body).toContain(`Unsubscribe: ${link}`);
    // The token names no one to a reader of the link.
    expect(link).not.toContain('security');
    expect(link).not.toContain(Buffer.from('security@example.test').toString('base64url'));
  });

  it('sends each recipient a message of its own with its own link', async () => {
    const { sent, transport } = captureTransport();
    const guardrails = guardrailsSendingTo('"Doe, Jane" <Jane@Example.test>, ops@example.test', transport);

    await guardrails.validateBeforeExecution(CRITICAL_READ);

    expect(sent).toHaveLength(2);
    expect(sent[0].header('to')?.toLowerCase()).toContain('jane@example.test');
    expect(sent[0].header('to')).not.toContain('ops@example.test');
    expect(sent[1].header('to')).toBe('ops@example.test');
    expect(linkOf(sent[0])).not.toBe('');
    expect(linkOf(sent[0])).not.toBe(linkOf(sent[1]));
  });

  it('never mails an address on the do-not-contact list, from the config or the environment', async () => {
    const { sent, transport } = captureTransport();
    process.env.WUNDERLAND_MAIL_DO_NOT_CONTACT = 'Env.Blocked@Example.test, other@example.test';
    const guardrails = guardrailsSendingTo(
      'blocked@example.test, env.blocked@example.test, allowed@example.test',
      transport,
      { doNotContact: ['BLOCKED@example.test'] },
    );

    await guardrails.validateBeforeExecution(CRITICAL_READ);

    expect(sent.map((mail) => mail.header('to'))).toEqual(['allowed@example.test']);
  });

  it('still mails the other recipients when one is refused, and reports the refusal', async () => {
    const { sent, transport } = captureTransport();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refusing = {
      async sendMail(message) {
        if (String(message.to).includes('refused@')) throw new Error('550 mailbox unavailable');
        return transport.sendMail(message);
      },
    };
    const manager = new NotificationManager({
      enableConsoleWarnings: false,
      emailConfig: {
        to: 'refused@example.test, ops@example.test',
        transport: refusing,
        unsubscribeUrl: UNSUBSCRIBE_URL,
        unsubscribeSecret: SECRET,
        suppressionFile,
      },
    });

    const result = await manager.testNotifications();

    expect(sent.map((mail) => mail.header('to'))).toEqual(['ops@example.test']);
    expect(result.email.success).toBe(false);
    expect(result.email.error).toMatch(/550 mailbox unavailable/);
  });

  it('refuses to send without an https unsubscribe address', async () => {
    const { sent, transport } = captureTransport();
    for (const unsubscribeUrl of [undefined, 'http://alerts.example.test/mail/unsubscribe', 'https://alerts.example.test/u?x=1']) {
      const manager = new NotificationManager({
        enableConsoleWarnings: false,
        emailConfig: {
          to: 'security@example.test',
          transport,
          unsubscribeUrl,
          unsubscribeSecret: SECRET,
          suppressionFile,
        },
      });

      const result = await manager.testNotifications();

      expect(result.email.success).toBe(false);
      expect(result.email.error).toMatch(/unsubscribe/i);
    }
    expect(sent).toHaveLength(0);
  });

  it('takes the unsubscribe address from the environment', async () => {
    const { sent, transport } = captureTransport();
    process.env.WUNDERLAND_MAIL_UNSUBSCRIBE_URL = 'https://env.example.test/stop/';
    const manager = new NotificationManager({
      enableConsoleWarnings: false,
      emailConfig: { to: 'security@example.test', transport, unsubscribeSecret: SECRET, suppressionFile },
    });

    await manager.testNotifications();

    expect(sent).toHaveLength(1);
    expect(linkOf(sent[0])).toMatch(/^https:\/\/env\.example\.test\/stop\/[A-Za-z0-9_-]{40,}$/);
  });

  it('keeps a generated key beside the suppression list when no secret is given', async () => {
    const { sent, transport } = captureTransport();
    const manager = new NotificationManager({
      enableConsoleWarnings: false,
      emailConfig: { to: 'security@example.test', transport, unsubscribeUrl: UNSUBSCRIBE_URL, suppressionFile },
    });

    await manager.testNotifications();
    await manager.testNotifications();

    const keyFile = path.join(dir, 'mail-unsubscribe.key');
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, 'utf8').trim().length).toBeGreaterThanOrEqual(32);
    expect(sent).toHaveLength(2);
  });

  it('signs both list headers when the email is signed with DKIM', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    for (const dkim of [
      { domainName: 'example.test', keySelector: 'mail', privateKey },
      { domainName: 'example.test', keySelector: 'mail', privateKey, headerFieldNames: 'From:Subject', skipFields: 'List-Unsubscribe-Post' },
    ]) {
      const { sent, transport } = captureTransport();
      const guardrails = guardrailsSendingTo('security@example.test', transport, { dkim });

      await guardrails.validateBeforeExecution(CRITICAL_READ);

      expect(sent).toHaveLength(1);
      const signature = sent[0].header('dkim-signature') ?? '';
      const signed = (/\bh=([^;]+)/.exec(signature)?.[1] ?? '').replace(/\s+/g, '').toLowerCase().split(':');
      expect(signed).toContain('list-unsubscribe');
      expect(signed).toContain('list-unsubscribe-post');
      expect(signed).toContain('from');
    }
  });
});
