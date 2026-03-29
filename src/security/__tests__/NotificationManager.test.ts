import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationManager } from '../NotificationManager.js';

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn().mockRejectedValue(new Error('SMTP down')),
  })),
}));

describe('NotificationManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports webhook delivery failures during notification tests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Webhook offline')),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const manager = new NotificationManager({
      webhooks: [{ url: 'https://example.com/webhook', retries: 1 }],
      enableConsoleWarnings: false,
    });

    const result = await manager.testNotifications();

    expect(result.webhooks).toEqual([
      {
        url: 'https://example.com/webhook',
        success: false,
        error: 'Webhook offline',
      },
    ]);
  });

  it('reports SMTP delivery failures during notification tests', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const manager = new NotificationManager({
      emailConfig: {
        to: 'security@example.com',
        smtpHost: 'smtp.example.com',
        smtpUser: 'mailer',
        smtpPass: 'secret',
      },
      enableConsoleWarnings: false,
    });

    const result = await manager.testNotifications();

    expect(result.email).toEqual({
      success: false,
      error: 'SMTP down',
    });
  });
});
