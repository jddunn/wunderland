/**
 * Channel subscription handler — lets Pioneer+ users toggle visibility of
 * individual feed channels in THE LOOKING GLASS via button clicks.
 *
 * Each channel has a hidden Discord role (e.g. "sub:tech-news"). When a user
 * clicks a button, the role is toggled on/off, which controls channel visibility
 * via permission overwrites set by setup_server.py.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHANNEL_SUBS = [
  { slug: 'tech-news',       label: 'Tech News',     emoji: '\u{1F4BB}', group: 'news'    },
  { slug: 'finance-news',    label: 'Finance',        emoji: '\u{1F4B0}', group: 'news'    },
  { slug: 'science-news',    label: 'Science',        emoji: '\u{1F52C}', group: 'news'    },
  { slug: 'media-news',      label: 'Media',          emoji: '\u{1F3AC}', group: 'news'    },
  { slug: 'threat-intel',    label: 'Threat Intel',   emoji: '\u{1F6E1}', group: 'news'    },
  { slug: 'ai-papers',       label: 'AI Papers',      emoji: '\u{1F4C4}', group: 'news'    },
  { slug: 'jobs-ai-ml',      label: 'AI/ML Jobs',     emoji: '\u{1F916}', group: 'jobs'    },
  { slug: 'jobs-web3',       label: 'Web3 Jobs',      emoji: '\u26D3',    group: 'jobs'    },
  { slug: 'jobs-creative',   label: 'Creative Jobs',  emoji: '\u{1F3A8}', group: 'jobs'    },
  { slug: 'jobs-marketing',  label: 'Marketing Jobs', emoji: '\u{1F4E2}', group: 'jobs'    },
  { slug: 'udemy-deals',     label: 'Udemy Deals',    emoji: '\u{1F393}', group: 'markets' },
  { slug: 'crypto-trending', label: 'Crypto',         emoji: '\u{1F4C8}', group: 'markets' },
  { slug: 'short-squeeze',   label: 'Short Squeeze',  emoji: '\u{1F4CA}', group: 'markets' },
  { slug: 'uniswap-sniper',  label: 'Uniswap',        emoji: '\u{1F52B}', group: 'markets' },
] as const;

const BUTTON_PREFIX = 'sub:';
const BRAND_COLOR = 0x8b6914;

export interface ChannelSubsConfig {
  guildId: string;
  channelSettingsId: string;
}

export function createChannelSubsHandler(config: ChannelSubsConfig) {
  // Dynamically import discord.js to avoid compile-time dependency.
  let djs: any = null;

  async function ensureDiscordJs(): Promise<any> {
    if (!djs) {
      djs = await import('discord.js');
    }
    return djs;
  }

  // ── Interaction handler ────────────────────────────────────────────────

  async function handleInteraction(interaction: any): Promise<boolean> {
    if (!interaction.isButton?.()) return false;
    const id: string = interaction.customId ?? '';
    if (!id.startsWith(BUTTON_PREFIX)) return false;

    const action = id.slice(BUTTON_PREFIX.length); // 'toggle:tech-news' | 'all' | 'none'

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      return true; // interaction expired
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: 'This only works in a server.' });
      return true;
    }

    let member: any;
    try {
      member = await guild.members.fetch(interaction.user.id);
    } catch {
      await interaction.editReply({ content: 'Could not fetch your member data.' });
      return true;
    }

    if (action === 'all') {
      await handleSubscribeAll(interaction, guild, member);
    } else if (action === 'none') {
      await handleUnsubscribeAll(interaction, guild, member);
    } else if (action.startsWith('toggle:')) {
      const slug = action.slice('toggle:'.length);
      await handleToggle(interaction, guild, member, slug);
    } else {
      return false;
    }
    return true;
  }

  async function handleToggle(
    i: any,
    guild: any,
    member: any,
    slug: string,
  ): Promise<void> {
    const ch = CHANNEL_SUBS.find((c) => c.slug === slug);
    if (!ch) {
      await i.editReply({ content: `Unknown channel: ${slug}` });
      return;
    }

    const roleName = `sub:${slug}`;
    const role = guild.roles.cache.find((r: any) => r.name === roleName);
    if (!role) {
      await i.editReply({
        content: `Role \`${roleName}\` not found. An admin needs to run the setup script.`,
      });
      return;
    }

    const hasSub = member.roles.cache.has(role.id);
    try {
      if (hasSub) {
        await member.roles.remove(role, 'Channel subscription toggle');
      } else {
        await member.roles.add(role, 'Channel subscription toggle');
      }
    } catch (err: any) {
      console.error('[ChannelSubs] Role toggle error:', err?.message ?? err);
    }

    // Force re-fetch to get accurate state after role change.
    const refreshed = await guild.members.fetch({ user: member.id, force: true });
    const action = hasSub ? 'Unsubscribed from' : 'Subscribed to';
    await i.editReply({
      content: `${hasSub ? '\u274C' : '\u2705'} **${action}** ${ch.emoji} ${ch.label}`,
      embeds: [buildStatusEmbed(refreshed, guild)],
    });
  }

  async function handleSubscribeAll(
    i: any,
    guild: any,
    member: any,
  ): Promise<void> {
    const rolesToAdd = CHANNEL_SUBS
      .map((ch) => guild.roles.cache.find((r: any) => r.name === `sub:${ch.slug}`))
      .filter((r: any) => r != null && !member.roles.cache.has(r.id));

    await Promise.allSettled(
      rolesToAdd.map((r: any) => member.roles.add(r, 'Subscribe all channels')),
    );

    // Force re-fetch to get accurate state after role changes.
    const refreshed = await guild.members.fetch({ user: member.id, force: true });
    await i.editReply({
      content: '\u2705 **Subscribed to all channels**',
      embeds: [buildStatusEmbed(refreshed, guild)],
    });
  }

  async function handleUnsubscribeAll(
    i: any,
    guild: any,
    member: any,
  ): Promise<void> {
    const rolesToRemove = CHANNEL_SUBS
      .map((ch) => guild.roles.cache.find((r: any) => r.name === `sub:${ch.slug}`))
      .filter((r: any) => r != null && member.roles.cache.has(r.id));

    await Promise.allSettled(
      rolesToRemove.map((r: any) => member.roles.remove(r, 'Unsubscribe all channels')),
    );

    // Force re-fetch to get accurate state after role changes.
    const refreshed = await guild.members.fetch({ user: member.id, force: true });
    await i.editReply({
      content: '\u274C **Unsubscribed from all channels**',
      embeds: [buildStatusEmbed(refreshed, guild)],
    });
  }

  // ── Status embed (shown in ephemeral reply) ────────────────────────────

  function buildStatusEmbed(member: any, guild: any): Record<string, any> {
    const groups: Record<string, typeof CHANNEL_SUBS[number][]> = {
      news: [],
      jobs: [],
      markets: [],
    };
    for (const ch of CHANNEL_SUBS) {
      groups[ch.group]?.push(ch);
    }

    const groupLabels: Record<string, string> = {
      news: '\u{1F4F0} News & Intel',
      jobs: '\u{1F4BC} Jobs',
      markets: '\u{1F4C8} Markets & Deals',
    };

    const lines: string[] = [];
    for (const [groupKey, channels] of Object.entries(groups)) {
      lines.push(`**${groupLabels[groupKey] ?? groupKey}**`);
      for (const ch of channels) {
        const role = guild.roles.cache.find((r: any) => r.name === `sub:${ch.slug}`);
        const subscribed = role ? member.roles.cache.has(role.id) : false;
        lines.push(`${subscribed ? '\u2705' : '\u274C'} ${ch.emoji} ${ch.label}`);
      }
      lines.push('');
    }

    return {
      title: 'Your Channel Subscriptions',
      description: lines.join('\n').trim(),
      color: BRAND_COLOR,
      footer: { text: 'Changes take effect immediately | Only you can see this' },
    };
  }

  // ── Persistent post (posted to #channel-settings on startup) ───────────

  async function ensureSubsPost(client: any): Promise<void> {
    if (!config.channelSettingsId || !config.guildId) {
      console.warn('[ChannelSubs] Missing channelSettingsId or guildId — skipping post');
      return;
    }

    const discord = await ensureDiscordJs();

    try {
      const guild = await client.guilds.fetch(config.guildId);
      if (!guild) {
        console.warn('[ChannelSubs] Guild not found:', config.guildId);
        return;
      }

      const ch = guild.channels.cache.get(config.channelSettingsId);
      if (!ch?.isTextBased?.()) {
        console.warn('[ChannelSubs] Channel not found or not text-based:', config.channelSettingsId);
        return;
      }

      // Check for existing post.
      const messages = await ch.messages.fetch({ limit: 15 });
      const existing = messages.find(
        (m: any) =>
          m.author.id === client.user?.id &&
          m.components?.some?.((row: any) =>
            row.components?.some?.((c: any) => c.customId?.startsWith('sub:')),
          ),
      );

      const embed = buildSubsEmbed();
      const rows = buildButtonRows(discord);

      if (existing) {
        await existing.edit({ embeds: [embed], components: rows });
        if (!existing.pinned) {
          try { await existing.pin(); } catch { /* already pinned or no perms */ }
        }
        console.log('[ChannelSubs] Updated existing subscription post');
      } else {
        const sent = await ch.send({ embeds: [embed], components: rows });
        try { await sent.pin(); } catch { /* no perms */ }
        console.log('[ChannelSubs] Created new subscription post');
      }
    } catch (err: any) {
      console.error('[ChannelSubs] ensureSubsPost error:', err?.message ?? err);
    }
  }

  function buildSubsEmbed(): Record<string, any> {
    return {
      title: '\u{1F52D} The Looking Glass \u2014 Channel Settings',
      description: [
        'Choose which feed channels appear in your sidebar.',
        'Click a button to **subscribe** or **unsubscribe**.',
        'Your changes take effect immediately.',
        '',
        'After each click you\'ll see your updated subscriptions.',
      ].join('\n'),
      color: BRAND_COLOR,
      fields: [
        {
          name: '\u{1F4F0} News & Intel',
          value: 'Tech \u2022 Finance \u2022 Science \u2022 Media \u2022 Threat Intel \u2022 AI Papers',
          inline: false,
        },
        {
          name: '\u{1F4BC} Jobs',
          value: 'AI/ML \u2022 Web3 \u2022 Creative \u2022 Marketing',
          inline: false,
        },
        {
          name: '\u{1F4C8} Markets & Deals',
          value: 'Udemy Deals \u2022 Crypto Trending \u2022 Short Squeeze \u2022 Uniswap Sniper',
          inline: false,
        },
      ],
      footer: { text: 'Pioneer+ only | Powered by Wunderbots | rabbithole.inc' },
    };
  }

  function buildButtonRows(discord: any): any[] {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;

    // Row 1 — News (5 buttons, max per ActionRow)
    const newsRow = new ActionRowBuilder().addComponents(
      ...['tech-news', 'finance-news', 'science-news', 'media-news', 'threat-intel'].map(
        (slug) => {
          const ch = CHANNEL_SUBS.find((c) => c.slug === slug)!;
          return new ButtonBuilder()
            .setCustomId(`sub:toggle:${slug}`)
            .setLabel(ch.label)
            .setEmoji(ch.emoji)
            .setStyle(ButtonStyle.Secondary);
        },
      ),
    );

    // Row 2 — AI Papers + Jobs (5 buttons)
    const papersJobsRow = new ActionRowBuilder().addComponents(
      ...['ai-papers', 'jobs-ai-ml', 'jobs-web3', 'jobs-creative', 'jobs-marketing'].map(
        (slug) => {
          const ch = CHANNEL_SUBS.find((c) => c.slug === slug)!;
          return new ButtonBuilder()
            .setCustomId(`sub:toggle:${slug}`)
            .setLabel(ch.label)
            .setEmoji(ch.emoji)
            .setStyle(ButtonStyle.Secondary);
        },
      ),
    );

    // Row 3 — Markets (4 buttons)
    const marketsRow = new ActionRowBuilder().addComponents(
      ...['udemy-deals', 'crypto-trending', 'short-squeeze', 'uniswap-sniper'].map(
        (slug) => {
          const ch = CHANNEL_SUBS.find((c) => c.slug === slug)!;
          return new ButtonBuilder()
            .setCustomId(`sub:toggle:${slug}`)
            .setLabel(ch.label)
            .setEmoji(ch.emoji)
            .setStyle(ButtonStyle.Secondary);
        },
      ),
    );

    // Row 4 — Bulk actions
    const bulkRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sub:all')
        .setLabel('Subscribe All')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('sub:none')
        .setLabel('Unsubscribe All')
        .setStyle(ButtonStyle.Danger),
    );

    return [newsRow, papersJobsRow, marketsRow, bulkRow];
  }

  return { handleInteraction, ensureSubsPost };
}
