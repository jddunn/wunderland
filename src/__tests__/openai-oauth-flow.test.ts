// @ts-nocheck
import { get } from 'node:http';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { OpenAIOAuthFlow } from '@framers/agentos/auth';
import type { IOAuthTokenStore, OAuthTokenSet } from '@framers/agentos/auth';

const { execMock } = vi.hoisted(() => ({
  execMock: vi.fn((_cmd: string, cb?: (error: Error | null) => void) => {
    cb?.(null);
    return {} as any;
  }),
}));

vi.mock('node:child_process', () => ({
  exec: execMock,
}));

/** In-memory token store for testing. */
class MemoryTokenStore implements IOAuthTokenStore {
  private store = new Map<string, OAuthTokenSet>();

  async load(providerId: string): Promise<OAuthTokenSet | null> {
    return this.store.get(providerId) ?? null;
  }

  async save(providerId: string, tokens: OAuthTokenSet): Promise<void> {
    this.store.set(providerId, tokens);
  }

  async clear(providerId: string): Promise<void> {
    this.store.delete(providerId);
  }
}

describe('OpenAIOAuthFlow', () => {
  let memStore: MemoryTokenStore;
  let onBrowserOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    memStore = new MemoryTokenStore();
    onBrowserOpen = vi.fn();
    execMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createFlow(opts?: { clientId?: string }) {
    return new OpenAIOAuthFlow({
      tokenStore: memStore,
      clientId: opts?.clientId ?? 'test-client-id',
      onBrowserOpen,
    });
  }

  async function sendCallback(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = get(`http://127.0.0.1:1455${path}`, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', reject);
    });
  }

  it('has providerId "openai"', () => {
    const flow = createFlow();
    expect(flow.providerId).toBe('openai');
  });

  describe('isValid()', () => {
    it('returns true for tokens expiring in the future', () => {
      const flow = createFlow();
      const tokens: OAuthTokenSet = {
        accessToken: 'test',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      };
      expect(flow.isValid(tokens)).toBe(true);
    });

    it('returns false for tokens expiring within 5 minutes', () => {
      const flow = createFlow();
      const tokens: OAuthTokenSet = {
        accessToken: 'test',
        expiresAt: Date.now() + 4 * 60 * 1000, // 4 minutes from now (within 5-min buffer)
      };
      expect(flow.isValid(tokens)).toBe(false);
    });

    it('returns false for expired tokens', () => {
      const flow = createFlow();
      const tokens: OAuthTokenSet = {
        accessToken: 'test',
        expiresAt: Date.now() - 1000,
      };
      expect(flow.isValid(tokens)).toBe(false);
    });
  });

  describe('getAccessToken()', () => {
    it('returns stored access token when valid', async () => {
      const flow = createFlow();
      const tokens: OAuthTokenSet = {
        accessToken: 'valid-token-123',
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
      await memStore.save('openai', tokens);

      const result = await flow.getAccessToken();
      expect(result).toBe('valid-token-123');
    });

    it('throws when no tokens are stored', async () => {
      const flow = createFlow();
      await expect(flow.getAccessToken()).rejects.toThrow(
        /No OpenAI OAuth tokens found/,
      );
    });

    it('refreshes expired tokens automatically', async () => {
      const flow = createFlow();

      // Store expired tokens with a refresh token
      await memStore.save('openai', {
        accessToken: 'expired-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: Date.now() - 1000, // expired
      });

      // Mock fetch for the refresh endpoint
      const fetchMock = vi.fn(async (url: string, opts: any) => {
        if (typeof url === 'string' && url.includes('/oauth/token')) {
          const body = opts?.body as string;
          if (body?.includes('grant_type=refresh_token')) {
            return {
              ok: true,
              json: async () => ({
                access_token: 'refreshed-token-new',
                refresh_token: 'new-refresh-token',
                expires_in: 3600,
              }),
            };
          }
        }
        return { ok: false, text: async () => 'unexpected request' };
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await flow.getAccessToken();
      expect(result).toBe('refreshed-token-new');

      // Verify tokens were saved
      const saved = await memStore.load('openai');
      expect(saved?.accessToken).toBe('refreshed-token-new');
      expect(saved?.refreshToken).toBe('new-refresh-token');
    });
  });

  describe('refresh()', () => {
    it('exchanges refresh token for new access token', async () => {
      const flow = createFlow();

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 7200,
        }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await flow.refresh({
        accessToken: 'old',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1000,
      });

      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
      expect(result.expiresAt).toBeGreaterThan(Date.now());

      // Verify fetch was called with correct params
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/oauth/token');
      expect(opts.body).toContain('grant_type=refresh_token');
      expect(opts.body).toContain('refresh_token=old-refresh');
      expect(opts.body).toContain('client_id=test-client-id');
    });

    it('throws when no refresh token is available', async () => {
      const flow = createFlow();
      await expect(
        flow.refresh({ accessToken: 'old', expiresAt: 0 }),
      ).rejects.toThrow(/No refresh token available/);
    });

    it('throws on HTTP error from token endpoint', async () => {
      const flow = createFlow();

      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      })));

      await expect(
        flow.refresh({
          accessToken: 'old',
          refreshToken: 'invalid',
          expiresAt: 0,
        }),
      ).rejects.toThrow(/Token refresh failed: 401/);
    });

    it('preserves existing refresh token when server omits it', async () => {
      const flow = createFlow();

      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          // no refresh_token in response
          expires_in: 3600,
        }),
      })));

      const result = await flow.refresh({
        accessToken: 'old',
        refreshToken: 'keep-this',
        expiresAt: 0,
      });

      expect(result.refreshToken).toBe('keep-this');
    });
  });

  describe('authenticate()', () => {
    it('performs browser-based PKCE flow and returns tokens', async () => {
      const flow = createFlow();

      onBrowserOpen.mockImplementation((authUrl: string) => {
        const state = new URL(authUrl).searchParams.get('state');
        expect(state).toBeTruthy();
        setTimeout(() => {
          void sendCallback(`/auth/callback?code=auth-code-456&state=${encodeURIComponent(state!)}`);
        }, 10);
      });

      const fetchMock = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/oauth/token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'final-access-token',
              refresh_token: 'final-refresh-token',
              expires_in: 3600,
            }),
          };
        }
        return { ok: false, text: async () => 'unknown endpoint' };
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await flow.authenticate();

      expect(onBrowserOpen).toHaveBeenCalledOnce();

      // Verify tokens
      expect(result.accessToken).toBe('final-access-token');
      expect(result.refreshToken).toBe('final-refresh-token');
      expect(result.expiresAt).toBeGreaterThan(Date.now());

      // Verify tokens were persisted
      const saved = await memStore.load('openai');
      expect(saved?.accessToken).toBe('final-access-token');

      // Verify fetch calls: token exchange only
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/oauth/token');
      expect(String(opts?.body)).toContain('grant_type=authorization_code');
      expect(String(opts?.body)).toContain('code=auth-code-456');
    });

    it('throws on token exchange failure', async () => {
      const flow = createFlow();

      onBrowserOpen.mockImplementation((authUrl: string) => {
        const state = new URL(authUrl).searchParams.get('state');
        setTimeout(() => {
          void sendCallback(`/auth/callback?code=bad-code&state=${encodeURIComponent(state!)}`);
        }, 10);
      });

      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'server error',
      })));

      await expect(flow.authenticate()).rejects.toThrow(
        /Token exchange failed: 500/,
      );
    });
  });

  describe('concurrent refresh mutex', () => {
    it('only refreshes once when called concurrently', async () => {
      const flow = createFlow();
      let refreshCallCount = 0;

      await memStore.save('openai', {
        accessToken: 'expired',
        refreshToken: 'valid-refresh',
        expiresAt: Date.now() - 1000,
      });

      vi.stubGlobal('fetch', vi.fn(async () => {
        refreshCallCount++;
        // Add a small delay to simulate network latency
        await new Promise((r) => setTimeout(r, 10));
        return {
          ok: true,
          json: async () => ({
            access_token: 'refreshed-once',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        };
      }));

      // Fire 3 concurrent getAccessToken calls
      const [r1, r2, r3] = await Promise.all([
        flow.getAccessToken(),
        flow.getAccessToken(),
        flow.getAccessToken(),
      ]);

      // All should return the same refreshed token
      expect(r1).toBe('refreshed-once');
      expect(r2).toBe('refreshed-once');
      expect(r3).toBe('refreshed-once');

      // fetch should only be called once (mutex prevents concurrent refreshes)
      expect(refreshCallCount).toBe(1);
    });
  });
});
