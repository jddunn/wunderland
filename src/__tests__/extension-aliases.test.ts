import { describe, expect, it } from 'vitest';

import {
  normalizeExtensionList,
  normalizeExtensionName,
} from '../cli/extensions/aliases.js';
import { createEnvSecretResolver } from '../cli/security/env-secrets.js';

describe('extension aliases', () => {
  it('normalizes google-calendar to calendar-google', () => {
    expect(normalizeExtensionName('google-calendar')).toBe('calendar-google');
  });

  it('deduplicates lists after normalization', () => {
    expect(
      normalizeExtensionList(['google-calendar', 'calendar-google', 'email-gmail']),
    ).toEqual(['calendar-google', 'email-gmail']);
  });
});

describe('env secret aliases', () => {
  it('resolves Gmail OAuth aliases for Google secrets', () => {
    const getSecret = createEnvSecretResolver({
      env: {
        GMAIL_CLIENT_ID: 'gmail-client-id',
        GMAIL_CLIENT_SECRET: 'gmail-client-secret',
        GMAIL_REFRESH_TOKEN: 'gmail-refresh-token',
      },
    });

    expect(getSecret('google.clientId')).toBe('gmail-client-id');
    expect(getSecret('google.clientSecret')).toBe('gmail-client-secret');
    expect(getSecret('google.refreshToken')).toBe('gmail-refresh-token');
  });

  it('resolves the Google Calendar refresh token alias', () => {
    const getSecret = createEnvSecretResolver({
      env: {
        GOOGLE_CALENDAR_REFRESH_TOKEN: 'calendar-refresh-token',
      },
    });

    expect(getSecret('google.refreshToken')).toBe('calendar-refresh-token');
  });
});
