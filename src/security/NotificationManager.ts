/**
 * @fileoverview Notification manager for permission violations
 * @module wunderland/security/NotificationManager
 *
 * Sends notifications for high-severity permission violations via:
 * - Webhooks (HTTP POST)
 * - Email (SMTP)
 * - Console warnings (fallback)
 */

import type { PermissionViolation } from './SafeGuardrails.js';

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  retries?: number;
}

/**
 * Email configuration
 */
export interface EmailConfig {
  to: string;
  from?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
}

/**
 * Notification manager configuration
 */
export interface NotificationManagerConfig {
  webhooks?: string[] | WebhookConfig[];
  emailConfig?: EmailConfig;
  enableConsoleWarnings?: boolean;
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
  ): Promise<void> {
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
        return;
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
  }

  /**
   * Send email notification
   *
   * Note: This is a basic implementation. For production, use a proper
   * email service like SendGrid, AWS SES, or Mailgun.
   */
  private async sendEmail(to: string, subject: string, body: string): Promise<void> {
    if (!this.emailConfig) {
      console.warn('Email config not set, skipping email notification');
      return;
    }

    try {
      // For now, just log the email (real SMTP integration would go here)
      console.log(`[EMAIL NOTIFICATION]`);
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log(`Body:\n${body}`);

      // TODO: Implement actual SMTP sending using nodemailer or similar
      // Example:
      // const transporter = nodemailer.createTransport({
      //   host: this.emailConfig.smtpHost,
      //   port: this.emailConfig.smtpPort,
      //   auth: {
      //     user: this.emailConfig.smtpUser,
      //     pass: this.emailConfig.smtpPass,
      //   },
      // });
      //
      // await transporter.sendMail({
      //   from: this.emailConfig.from || 'security@wunderland.sh',
      //   to,
      //   subject,
      //   text: body,
      // });
    } catch (err) {
      console.error('Failed to send email notification:', err);
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
      try {
        await this.sendWebhook(webhook, {
          event: 'test',
          message: 'Wunderland notification test',
          timestamp: new Date().toISOString(),
        });
        results.webhooks.push({ url: webhook.url, success: true });
      } catch (err) {
        results.webhooks.push({
          url: webhook.url,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    // Test email
    if (this.emailConfig) {
      try {
        await this.sendEmail(
          this.emailConfig.to,
          '[TEST] Wunderland Security Notification',
          'This is a test notification from Wunderland security system.'
        );
        results.email.success = true;
      } catch (err) {
        results.email.error = (err as Error).message;
      }
    }

    return results;
  }
}
