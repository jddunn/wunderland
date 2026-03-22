import { describe, it, expect } from 'vitest';
import { getRecommendations } from '../../src/cli/extensions/recommender.js';

describe('getRecommendations', () => {
  it('recommends news-search when NEWSAPI_API_KEY is set', async () => {
    const recs = await getRecommendations({
      env: { NEWSAPI_API_KEY: 'test-key' },
      enabledExtensions: [],
    });
    const match = recs.find((r) => r.extensionId === 'news-search');
    expect(match).toBeDefined();
    expect(match!.reason).toBe('credential_detected');
  });

  it('skips already-enabled extensions', async () => {
    const recs = await getRecommendations({
      env: { SERPER_API_KEY: 'test-key' },
      enabledExtensions: ['web-search'],
    });
    const match = recs.find((r) => r.extensionId === 'web-search');
    expect(match).toBeUndefined();
  });

  it('returns empty array when no credentials detected', async () => {
    const recs = await getRecommendations({ env: {}, enabledExtensions: [] });
    expect(recs).toEqual([]);
  });

  it('recommends both gmail and calendar for Google credentials', async () => {
    const recs = await getRecommendations({
      env: {
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REFRESH_TOKEN: 'token',
      },
      enabledExtensions: [],
    });
    const ids = recs.map((r) => r.extensionId);
    expect(ids).toContain('email-gmail');
    expect(ids).toContain('calendar-google');
  });
});
