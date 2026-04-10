// @ts-nocheck
/**
 * @fileoverview Tests for OAuth CLI commands — login, logout, auth-status
 * @module wunderland/__tests__/cli-oauth-commands.test
 *
 * Tests the three OAuth CLI commands using mocked @framers/agentos/auth
 * to avoid real network calls or filesystem token operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture console.log/warn/error output for testing CLI commands
function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

const globals = { yes: false, verbose: false };

// ── Login ─────────────────────────────────────────────────────────────────────

describe('wunderland login', () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.resetModules();
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('rejects unsupported providers', async () => {
    const { default: cmdLogin } = await import('../cli/commands/auth/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin([], { provider: 'nonexistent-provider' }, globals);
      expect(process.exitCode).toBe(1);
      const output = cap.logs.join('\n');
      expect(output).toContain('Unknown provider');
    } finally {
      cap.restore();
    }
  });

  it('shows the unsupported message when OpenAI subscription auth is selected', async () => {
    // Mock @clack/prompts to auto-select openai-oauth (avoids interactive TTY hang)
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      cancel: vi.fn(),
      isCancel: vi.fn(() => false),
      select: vi.fn(async () => 'openai-oauth'),
    }));

    // Re-import so the mock takes effect
    const { default: cmdLogin } = await import('../cli/commands/auth/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('Not yet supported');
      expect(output).toContain('ChatGPT Plus/Pro');
      expect(output).toContain('Please use an OpenAI API key instead');
      expect(process.exitCode).toBeUndefined();
    } finally {
      cap.restore();
    }
  });

  it('does not attempt the deprecated OpenAI OAuth auth flow', async () => {
    // Mock @clack/prompts to auto-select openai-oauth (avoids interactive TTY hang)
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      cancel: vi.fn(),
      isCancel: vi.fn(() => false),
      select: vi.fn(async () => 'openai-oauth'),
    }));

    const { default: cmdLogin } = await import('../cli/commands/auth/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('Not yet supported');
      expect(output).toContain('registered OAuth application');
      expect(output).not.toContain('Login failed');
      expect(process.exitCode).toBeUndefined();
    } finally {
      cap.restore();
    }
  });

  it('supports LinkedIn OAuth provider', async () => {
    vi.doMock('@framers/agentos/auth', () => ({
      LinkedInOAuthFlow: class {
        authenticate = vi.fn(async () => ({
          accessToken: 'linkedin-token-0123456789012',
          refreshToken: 'refresh-tok',
          expiresAt: Date.now() + 3600_000,
        }));
      },
      FileTokenStore: class {},
    }));

    const { default: cmdLogin } = await import('../cli/commands/auth/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin([], { provider: 'linkedin', 'client-id': 'cid', 'client-secret': 'secret' }, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('LinkedIn');
      expect(output).toContain('Authenticated');
    } finally {
      cap.restore();
    }
  });

  it('supports Farcaster token login and stores token metadata', async () => {
    const saveMock = vi.fn(async () => {});
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        save = saveMock;
      },
    }));

    const { default: cmdLogin } = await import('../cli/commands/auth/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin(
        [],
        { provider: 'farcaster', 'neynar-api-key': 'ney-key', 'signer-uuid': 'signer-123', fid: '42' },
        globals,
      );
      expect(saveMock).toHaveBeenCalledWith(
        'farcaster',
        expect.objectContaining({
          accessToken: 'ney-key',
          metadata: expect.objectContaining({ signerUuid: 'signer-123', fid: '42' }),
        }),
      );
      const output = cap.logs.join('\n');
      expect(output).toContain('Farcaster');
      expect(output).toContain('Authenticated');
    } finally {
      cap.restore();
    }
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('wunderland logout', () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.resetModules();
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('reports when no tokens exist', async () => {
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        load = vi.fn(async () => null);
        clear = vi.fn(async () => {});
      },
    }));

    const { default: cmdLogout } = await import('../cli/commands/auth/logout.js');
    const cap = captureConsole();
    try {
      await cmdLogout([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('No stored tokens');
    } finally {
      cap.restore();
    }
  });

  it('clears existing tokens and shows success', async () => {
    const clearMock = vi.fn(async () => {});
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        load = vi.fn(async () => ({
          accessToken: 'tok',
          expiresAt: Date.now() + 3600_000,
        }));
        clear = clearMock;
      },
    }));

    const { default: cmdLogout } = await import('../cli/commands/auth/logout.js');
    const cap = captureConsole();
    try {
      await cmdLogout([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('Logged out');
      expect(clearMock).toHaveBeenCalledOnce();
    } finally {
      cap.restore();
    }
  });

  it('uses custom provider flag', async () => {
    const loadMock = vi.fn(async () => null);
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        load = loadMock;
        clear = vi.fn(async () => {});
      },
    }));

    const { default: cmdLogout } = await import('../cli/commands/auth/logout.js');
    const cap = captureConsole();
    try {
      await cmdLogout([], { provider: 'custom-provider' }, globals);
      expect(loadMock).toHaveBeenCalledWith('custom-provider');
    } finally {
      cap.restore();
    }
  });
});

// ── Auth-Status ───────────────────────────────────────────────────────────────

describe('wunderland auth-status', () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.resetModules();
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('shows "Not authenticated" when no tokens stored', async () => {
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        load = vi.fn(async () => null);
      },
      isTokenValid: vi.fn(() => false),
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth/auth-status.js');
    const cap = captureConsole();
    try {
      await cmdAuthStatus([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('Not authenticated');
      expect(output).toContain('wunderland login');
    } finally {
      cap.restore();
    }
  });

  it('shows valid token status', async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        load = vi.fn(async () => ({
          accessToken: 'test-tok-01234567890123',
          refreshToken: 'refresh-tok',
          expiresAt,
        }));
      },
      isTokenValid: vi.fn(() => true),
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth/auth-status.js');
    const cap = captureConsole();
    try {
      await cmdAuthStatus([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('Authenticated');
      expect(output).toContain('test-tok');
      expect(output).toContain('Available'); // refresh token exists
    } finally {
      cap.restore();
    }
  });

  it('shows expired token with refresh available', async () => {
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        load = vi.fn(async () => ({
          accessToken: 'expired-tok01234567890',
          refreshToken: 'refresh-tok',
          expiresAt: Date.now() - 1000,
        }));
      },
      isTokenValid: vi.fn(() => false),
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth/auth-status.js');
    const cap = captureConsole();
    try {
      await cmdAuthStatus([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('expired');
      expect(output).toContain('auto-refresh');
    } finally {
      cap.restore();
    }
  });

  it('shows expired token without refresh', async () => {
    vi.doMock('@framers/agentos/auth', () => ({
      FileTokenStore: class {
        load = vi.fn(async () => ({
          accessToken: 'expired-tok01234567890',
          expiresAt: Date.now() - 1000,
        }));
      },
      isTokenValid: vi.fn(() => false),
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth/auth-status.js');
    const cap = captureConsole();
    try {
      await cmdAuthStatus([], {}, globals);
      const output = cap.logs.join('\n');
      expect(output).toContain('expired');
      expect(output).toContain('wunderland login');
    } finally {
      cap.restore();
    }
  });
});
