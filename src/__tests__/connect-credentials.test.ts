/**
 * @fileoverview Tests for the Google credentials file parser.
 *
 * Validates that `parseGoogleCredentialsFile()` correctly handles:
 * - Standard "installed" format (Desktop app OAuth client)
 * - Standard "web" format (Web application OAuth client)
 * - Invalid JSON input
 * - Missing required fields (client_id, client_secret)
 *
 * Uses temporary files created in os.tmpdir() to avoid touching the real
 * filesystem. All temp files are cleaned up in afterEach.
 *
 * @module wunderland/__tests__/connect-credentials
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseGoogleCredentialsFile } from '../cli/commands/connect.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tracks temp files so afterEach can clean them up. */
const tempFiles: string[] = [];

/**
 * Creates a temp file with the given content and returns its path.
 * The file is automatically cleaned up after each test.
 */
function writeTempFile(content: string, ext = '.json'): string {
  const name = `test-creds-${randomBytes(6).toString('hex')}${ext}`;
  const filePath = join(tmpdir(), name);
  writeFileSync(filePath, content, 'utf-8');
  tempFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tempFiles) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore cleanup failures */ }
    }
  }
  tempFiles.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Google credentials file parser', () => {
  it('parses "installed" format (Desktop app)', () => {
    const filePath = writeTempFile(JSON.stringify({
      installed: {
        client_id: '123456789.apps.googleusercontent.com',
        client_secret: 'GOCSPX-test-secret-installed',
        project_id: 'my-project',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    }));

    const result = parseGoogleCredentialsFile(filePath);

    expect(result.clientId).toBe('123456789.apps.googleusercontent.com');
    expect(result.clientSecret).toBe('GOCSPX-test-secret-installed');
  });

  it('parses "web" format (Web application)', () => {
    const filePath = writeTempFile(JSON.stringify({
      web: {
        client_id: '987654321.apps.googleusercontent.com',
        client_secret: 'GOCSPX-test-secret-web',
        project_id: 'my-web-project',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        redirect_uris: ['http://localhost:19832/callback'],
      },
    }));

    const result = parseGoogleCredentialsFile(filePath);

    expect(result.clientId).toBe('987654321.apps.googleusercontent.com');
    expect(result.clientSecret).toBe('GOCSPX-test-secret-web');
  });

  it('throws on invalid JSON', () => {
    const filePath = writeTempFile('this is not valid json {{{');

    expect(() => parseGoogleCredentialsFile(filePath)).toThrow();
  });

  it('throws when client_id is missing', () => {
    const filePath = writeTempFile(JSON.stringify({
      installed: {
        client_secret: 'GOCSPX-test-secret',
      },
    }));

    expect(() => parseGoogleCredentialsFile(filePath)).toThrow(
      /missing client_id or client_secret/i
    );
  });

  it('throws when client_secret is missing', () => {
    const filePath = writeTempFile(JSON.stringify({
      installed: {
        client_id: '123456789.apps.googleusercontent.com',
      },
    }));

    expect(() => parseGoogleCredentialsFile(filePath)).toThrow(
      /missing client_id or client_secret/i
    );
  });

  it('throws when neither installed nor web wrapper is present', () => {
    const filePath = writeTempFile(JSON.stringify({
      desktop: {
        client_id: '123456789.apps.googleusercontent.com',
        client_secret: 'GOCSPX-test',
      },
    }));

    expect(() => parseGoogleCredentialsFile(filePath)).toThrow(
      /missing client_id or client_secret/i
    );
  });

  it('throws when the file does not exist', () => {
    expect(() => parseGoogleCredentialsFile('/nonexistent/path/creds.json')).toThrow();
  });

  it('prefers "installed" over "web" when both are present', () => {
    const filePath = writeTempFile(JSON.stringify({
      installed: {
        client_id: 'installed-id.apps.googleusercontent.com',
        client_secret: 'GOCSPX-installed',
      },
      web: {
        client_id: 'web-id.apps.googleusercontent.com',
        client_secret: 'GOCSPX-web',
      },
    }));

    const result = parseGoogleCredentialsFile(filePath);

    // Should pick "installed" because of the `json.installed || json.web` logic
    expect(result.clientId).toBe('installed-id.apps.googleusercontent.com');
    expect(result.clientSecret).toBe('GOCSPX-installed');
  });
});
