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
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('rejects unsupported providers', async () => {
    const { default: cmdLogin } = await import('../cli/commands/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin([], { provider: 'anthropic' }, globals);
      expect(process.exitCode).toBe(1);
      const output = cap.logs.join('\n');
      expect(output).toContain('Unsupported provider');
      expect(output).toContain('anthropic');
    } finally {
      cap.restore();
    }
  });

  it('defaults provider to openai when no flag given', async () => {
    // Mock the auth module to verify it's called
    vi.doMock('@framers/agentos/auth', () => ({
      OpenAIOAuthFlow: class {
        authenticate = vi.fn(async () => ({
          accessToken: 'test-token-01234567890123456789',
          refreshToken: 'refresh-tok',
          expiresAt: Date.now() + 3600_000,
        }));
      },
      FileTokenStore: class {},
    }));

    // Re-import so the mock takes effect
    const { default: cmdLogin } = await import('../cli/commands/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin([], {}, globals);
      const output = cap.logs.join('\n');
      // Should show OpenAI OAuth Login header
      expect(output).toContain('OpenAI');
      // Should show success with token info
      expect(output).toContain('Authenticated');
    } finally {
      cap.restore();
    }
  });

  it('shows error on auth failure', async () => {
    vi.doMock('@framers/agentos/auth', () => ({
      OpenAIOAuthFlow: class {
        authenticate = vi.fn(async () => {
          throw new Error('Network timeout');
        });
      },
      FileTokenStore: class {},
    }));

    const { default: cmdLogin } = await import('../cli/commands/login.js');
    const cap = captureConsole();
    try {
      await cmdLogin([], {}, globals);
      expect(process.exitCode).toBe(1);
      const output = cap.logs.join('\n');
      expect(output).toContain('Login failed');
      expect(output).toContain('Network timeout');
    } finally {
      cap.restore();
    }
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('wunderland logout', () => {
  let exitCode: number | undefined;

  beforeEach(() => {
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

    const { default: cmdLogout } = await import('../cli/commands/logout.js');
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

    const { default: cmdLogout } = await import('../cli/commands/logout.js');
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

    const { default: cmdLogout } = await import('../cli/commands/logout.js');
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
      OpenAIOAuthFlow: class {
        isValid = vi.fn(() => false);
      },
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth-status.js');
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
      OpenAIOAuthFlow: class {
        isValid = vi.fn(() => true);
      },
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth-status.js');
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
      OpenAIOAuthFlow: class {
        isValid = vi.fn(() => false);
      },
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth-status.js');
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
      OpenAIOAuthFlow: class {
        isValid = vi.fn(() => false);
      },
    }));

    const { default: cmdAuthStatus } = await import('../cli/commands/auth-status.js');
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
