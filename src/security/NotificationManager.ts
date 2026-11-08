// @ts-nocheck
/**
 * @fileoverview Notification manager for permission violations
 * @module wunderland/security/NotificationManager
 *
 * Sends notifications for high-severity permission violations via:
 * - Webhooks (HTTP POST)
 * - Email (SMTP, or any nodemailer transporter)
 * - Console warnings (fallback)
 *
 * Every email goes to one recipient, ends with an Unsubscribe link and carries
 * `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058). Before each send
 * the suppression list and the do-not-contact addresses are read, and a
 * listed address gets nothing. Without an https unsubscribe address no email
 * is sent. The link, the list and the route are in `mail-unsubscribe.ts`.
 */

import type { PermissionViolation } from './SafeGuardrails.js';
import {
  createUnsubscribeToken,
  dkimSigningUnsubscribeHeaders,
  hashMailAddress,
  normalizeMailAddress,
  readSuppressedAddressHashes,
  resolveDoNotContact,
  resolveUnsubscribeSecret,
  resolveUnsubscribeUrl,
  splitMailRecipients,
  unsubscribeFooter,
  unsubscribeHeaders,
  unsubscribeLink,
  type MailUnsubscribeOptions,
} from './mail-unsubscribe.js';

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  retries?: number;
}

/**
 * Email configuration. The unsubscribe settings it inherits decide where the
 * links point (`unsubscribeUrl`, required to send), how they are sealed
 * (`unsubscribeSecret`), where the suppression list lives (`suppressionFile`)
 * and which addresses are never mailed (`doNotContact`).
 */
export interface EmailConfig extends MailUnsubscribeOptions {
  /** Recipients, separated by commas. Each gets an email of its own with its own unsubscribe link. */
  to: string;
  /** Sender address. Default: `SMTP_FROM`, else `security@wunderland.sh`. */
  from?: string;
  /** SMTP host. Default: `SMTP_HOST`. */
  smtpHost?: string;
  /** SMTP port; 465 connects with TLS. Default: `SMTP_PORT`, else 587. */
  smtpPort?: number;
  /** SMTP user. Default: `SMTP_USER`. */
  smtpUser?: string;
  /** SMTP password. Default: `SMTP_PASS`. */
  smtpPass?: string;
  /**
   * A nodemailer transporter, or anything with the same `sendMail`, to send
   * through instead of the SMTP settings (SES, a pooled connection, a test transport).
   */
  transport?: { sendMail(message: Record<string, unknown>): Promise<unknown> };
  /**
   * nodemailer DKIM options (`domainName`, `keySelector`, `privateKey`, ...)
   * applied to each email, with List-Unsubscribe and List-Unsubscribe-Post
   * added to the signed headers, as RFC 8058 section 4 requires.
   */
  dkim?: Record<string, unknown>;
}

/**
 * Notification manager configuration
 */
export interface NotificationManagerConfig {
  webhooks?: string[] | WebhookConfig[];
  emailConfig?: EmailConfig;
  enableConsoleWarnings?: boolean;
}

interface NotificationDeliveryResult {
  success: boolean;
  error?: string;
}

/**
 * Notification manager for permission violations
 */
export class NotificationManager {
  private webhooks: WebhookConfig[];
  private emailConfig?: EmailConfig;
  private enableConsoleWarnings: boolean;

  constructor(config: NotificationManagerConfig = {}) {
    // Parse webhooks
    this.webhooks = [];
    if (config.webhooks) {
      for (const webhook of config.webhooks) {
        if (typeof webhook === 'string') {
          this.webhooks.push({ url: webhook, retries: 3 });
        } else {
          this.webhooks.push({ retries: 3, ...webhook });
        }
      }
    }

    this.emailConfig = config.emailConfig;
    this.enableConsoleWarnings = config.enableConsoleWarnings !== false;
  }

  /**
   * Send notification for violation
   */
  async notify(violation: PermissionViolation): Promise<void> {
    const message = this.formatMessage(violation);
    const payload = this.formatPayload(violation);

    // 1. Webhook notifications
    if (this.webhooks.length > 0) {
      await Promise.allSettled(
        this.webhooks.map((webhook) => this.sendWebhook(webhook, payload))
      );
    }

    // 2. Email notifications (if configured + severity high/critical)
    if (
      this.emailConfig &&
      (violation.severity === 'high' || violation.severity === 'critical')
    ) {
      await this.sendEmail(
        this.emailConfig.to,
        `[SECURITY] Permission Violation - ${violation.agentId}`,
        message
      );
    }

    // 3. Console warnings (fallback)
    if (this.enableConsoleWarnings) {
      console.warn(`[SECURITY VIOLATION] ${message}`);
    }
  }

  /**
   * Format message for human consumption
   */
  private formatMessage(violation: PermissionViolation): string {
    return `
Security Violation Detected

Agent: ${violation.agentId}
Tool: ${violation.toolId}
Operation: ${violation.operation}
Attempted Path: ${violation.attemptedPath || 'N/A'}
Reason: ${violation.reason}
Severity: ${violation.severity.toUpperCase()}
Time: ${violation.timestamp.toISOString()}
    `.trim();
  }

  /**
   * Format payload for webhooks/APIs
   */
  private formatPayload(violation: PermissionViolation): Record<string, unknown> {
    return {
      event: 'security.violation',
      severity: violation.severity,
      agent: violation.agentId,
      user: violation.userId,
      tool: violation.toolId,
      operation: violation.operation,
      path: violation.attemptedPath,
      reason: violation.reason,
      timestamp: violation.timestamp.toISOString(),
    };
  }

  /**
   * Send webhook notification
   */
  private async sendWebhook(
    webhook: WebhookConfig,
    payload: Record<string, unknown>
  ): Promise<NotificationDeliveryResult> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < (webhook.retries || 3); attempt++) {
      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Wunderland/1.0',
            ...webhook.headers,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
        }

        // Success
        return { success: true };
      } catch (err) {
        lastError = err as Error;

        // Exponential backoff
        if (attempt < (webhook.retries || 3) - 1) {
          await this.sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    // All retries failed
    console.error(`Failed to send webhook to ${webhook.url}:`, lastError);
    return {
      success: false,
      error: lastError?.message ?? `Failed to send webhook to ${webhook.url}`,
    };
  }

  /**
   * Send email notification
   *
   * Sends one email per recipient, each with its own unsubscribe link and the
   * one-click headers; a refused recipient does not stop the others. Skips an
   * address on the suppression list (read before each send) or the
   * do-not-contact list, and sends nothing without an https unsubscribe
   * address. With no transport and no SMTP host and user, the email is only
   * written to the console.
   */
  private async sendEmail(
    to: string,
    subject: string,
    body: string,
  ): Promise<NotificationDeliveryResult> {
    if (!this.emailConfig) {
      console.warn('Email config not set, skipping email notification');
      return { success: false, error: 'Email config not set' };
    }
    const config = this.emailConfig;

    try {
      const smtpHost = config.smtpHost ?? process.env.SMTP_HOST;
      const smtpPort = config.smtpPort ?? process.env.SMTP_PORT ?? 587;
      const smtpUser = config.smtpUser ?? process.env.SMTP_USER;
      const smtpPass = config.smtpPass ?? process.env.SMTP_PASS;
      const fromAddress = config.from ?? process.env.SMTP_FROM ?? 'security@wunderland.sh';

      if (!config.transport && !(smtpHost && smtpUser)) {
        console.log(`[EMAIL NOTIFICATION] (SMTP not configured — logging only)`);
        console.log(`To: ${to} | Subject: ${subject}`);
        console.log(`Body:\n${body}`);
        return { success: true };
      }

      // Every email carries a link that works, so without an address for it nothing is sent.
      const unsubscribe = resolveUnsubscribeUrl(config);
      if ('problem' in unsubscribe) {
        console.warn(`[EMAIL] Not sent: ${unsubscribe.problem}`);
        return { success: false, error: `Email not sent: ${unsubscribe.problem}` };
      }

      const doNotContact = resolveDoNotContact(config);
      const skipped: string[] = [];
      const failures: string[] = [];
      let transporter = config.transport;
      let secret: string | undefined;
      let sent = 0;

      for (const recipient of splitMailRecipients(to)) {
        const address = normalizeMailAddress(recipient);
        if (!address) {
          skipped.push('not an email address');
          continue;
        }
        if (doNotContact.has(address)) {
          skipped.push('on the do-not-contact list');
          continue;
        }
        // Read before each send, so an address unsubscribed a moment ago, even while an
        // earlier recipient's email was being delivered, gets nothing.
        const suppressed = await readSuppressedAddressHashes(config);
        if (suppressed.has(hashMailAddress(address))) {
          skipped.push('unsubscribed');
          continue;
        }

        secret ??= await resolveUnsubscribeSecret(config);
        if (!transporter) {
          const { createTransport } = await import('nodemailer');
          transporter = createTransport({
            host: smtpHost,
            port: Number(smtpPort),
            secure: Number(smtpPort) === 465,
            auth: { user: smtpUser, pass: smtpPass },
          });
        }

        const link = unsubscribeLink(unsubscribe.url, createUnsubscribeToken(address, secret));
        try {
          await transporter.sendMail({
            from: fromAddress,
            to: recipient,
            subject,
            text: `${body}\n\n${unsubscribeFooter(link)}\n`,
            headers: unsubscribeHeaders(link),
            ...(config.dkim ? { dkim: dkimSigningUnsubscribeHeaders(config.dkim) } : {}),
          });
          sent += 1;
        } catch (err) {
          // One recipient's server refusing the email does not stop the alert to the others.
          console.error('Failed to send email notification to one recipient:', err);
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }

      const reasons = [...new Set(skipped)].join(', ');
      if (skipped.length > 0) {
        console.warn(`[EMAIL] Skipped ${skipped.length} recipient(s): ${reasons}`);
      }
      if (sent > 0) {
        console.log(`[EMAIL] Sent to ${sent} recipient(s): ${subject}`);
      }
      if (failures.length > 0) {
        // The transport's own words, as a single-recipient send has always reported them.
        return { success: false, error: [...new Set(failures)].join('; ') };
      }
      if (sent === 0) {
        return {
          success: false,
          error: `No email sent: ${reasons ? `every recipient was skipped (${reasons})` : 'no recipients'}`,
        };
      }
      return { success: true };
    } catch (err) {
      console.error('Failed to send email notification:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Sleep utility for retry backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Test notifications (for setup verification)
   */
  async testNotifications(): Promise<{
    webhooks: { url: string; success: boolean; error?: string }[];
    email: { success: boolean; error?: string };
  }> {
    const results = {
      webhooks: [] as { url: string; success: boolean; error?: string }[],
      email: { success: false, error: undefined as string | undefined },
    };

    // Test webhooks
    for (const webhook of this.webhooks) {
      const delivery = await this.sendWebhook(webhook, {
        event: 'test',
        message: 'Wunderland notification test',
        timestamp: new Date().toISOString(),
      });
      results.webhooks.push({
        url: webhook.url,
        success: delivery.success,
        error: delivery.error,
      });
    }

    // Test email
    if (this.emailConfig) {
      const delivery = await this.sendEmail(
        this.emailConfig.to,
        '[TEST] Wunderland Security Notification',
        'This is a test notification from Wunderland security system.'
      );
      results.email.success = delivery.success;
      results.email.error = delivery.error;
    }

    return results;
  }
}
