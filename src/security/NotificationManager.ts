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
   * Note: This is a basic implementation. For production, use a proper
   * email service like SendGrid, AWS SES, or Mailgun.
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

    try {
      const smtpHost = (this as any).emailConfig?.smtpHost ?? process.env.SMTP_HOST;
      const smtpPort = (this as any).emailConfig?.smtpPort ?? process.env.SMTP_PORT ?? 587;
      const smtpUser = (this as any).emailConfig?.smtpUser ?? process.env.SMTP_USER;
      const smtpPass = (this as any).emailConfig?.smtpPass ?? process.env.SMTP_PASS;
      const fromAddress = (this as any).emailConfig?.from ?? process.env.SMTP_FROM ?? 'security@wunderland.sh';

      if (smtpHost && smtpUser) {
        const { createTransport } = await import('nodemailer');
        const transporter = createTransport({
          host: smtpHost,
          port: Number(smtpPort),
          secure: Number(smtpPort) === 465,
          auth: { user: smtpUser, pass: smtpPass },
        });
        await transporter.sendMail({ from: fromAddress, to, subject, text: body });
        console.log(`[EMAIL] Sent to ${to}: ${subject}`);
        return { success: true };
      } else {
        console.log(`[EMAIL NOTIFICATION] (SMTP not configured — logging only)`);
        console.log(`To: ${to} | Subject: ${subject}`);
        console.log(`Body:\n${body}`);
        return { success: true };
      }
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
