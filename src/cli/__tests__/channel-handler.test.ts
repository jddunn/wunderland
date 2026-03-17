import { describe, expect, it } from 'vitest';

import { resolveCuratedPicksChannelId } from '../commands/start/channel-handler';

describe('resolveCuratedPicksChannelId', () => {
  it('prefers an explicit curated picks channel id when configured', async () => {
    const channelId = await resolveCuratedPicksChannelId(
      {
        feeds: {
          channels: {
            curated_picks: 'curated-123',
            welcome: 'welcome-123',
          },
        },
      },
      null,
    );

    expect(channelId).toBe('curated-123');
  });

  it('discovers the general channel from the Discord service when no explicit id exists', async () => {
    const fetchedChannels = {
      find(predicate: (channel: any) => boolean) {
        const channels = [
          { id: 'welcome-123', name: 'welcome', send: () => undefined },
          { id: 'general-456', name: '💬-general', send: () => undefined },
        ];
        return channels.find(predicate);
      },
    };

    const channelId = await resolveCuratedPicksChannelId(
      { feeds: { channels: { welcome: 'welcome-123' } } },
      {
        getClient() {
          return {
            guilds: {
              cache: new Map([
                ['guild-1', {
                  channels: {
                    async fetch() {
                      return fetchedChannels;
                    },
                  },
                }],
              ]),
            },
          };
        },
      },
    );

    expect(channelId).toBe('general-456');
  });

  it('falls back to the info channel before welcome when discovery fails', async () => {
    const channelId = await resolveCuratedPicksChannelId(
      {
        feeds: {
          channels: {
            info: 'info-123',
            welcome: 'welcome-123',
          },
        },
      },
      null,
    );

    expect(channelId).toBe('info-123');
  });
});
