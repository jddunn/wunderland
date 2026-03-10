/**
 * Welcome handler — generates personalized, on-brand welcome messages for new
 * Discord members using OpenAI (gpt-4o) and the Rabbit Hole AI personality.
 *
 * Fires AFTER onboarding completes (guildMemberUpdate: pending → not pending)
 * so we can read the member's onboarding roles and personalize the message.
 *
 * Also reacts to the system join message with random Wonderland-themed emojis.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const BRAND_COLOR = 0x8b6914;

/** Pool of welcome-appropriate emoji reactions — picked at random per join. */
const WELCOME_REACTIONS = [
  '👋', '🐇', '🕳️', '✨', '🎩', '🍄', '🫖', '🃏',
  '🪄', '🌀', '🔮', '💫', '🎉', '🙌', '🤝', '🦊',
];

// ---------------------------------------------------------------------------
// Onboarding role → human label mapping
// ---------------------------------------------------------------------------
const INTEREST_LABELS: Record<string, [string, string]> = {
  'onboard:ai':            ['AI & Machine Learning', '🤖'],
  'onboard:web3':          ['Web3 & Crypto', '🪙'],
  'onboard:cybersecurity': ['Cybersecurity', '🛡️'],
  'onboard:startup':       ['Building a Startup', '🚀'],
  'onboard:jobs':          ['Job Hunting', '💼'],
  'onboard:exploring':     ['Just Exploring', '🐇'],
};

const PROFESSION_LABELS: Record<string, [string, string]> = {
  'onboard:engineer':  ['Engineer / Developer', '💻'],
  'onboard:creative':  ['Designer / Creative', '🎨'],
  'onboard:founder':   ['Founder / Entrepreneur', '🏗️'],
  'onboard:investor':  ['Investor / Analyst', '📊'],
  'onboard:student':   ['Student / Learner', '📚'],
  'onboard:other':     ['Other', '✨'],
};

/** Channel suggestions keyed by onboarding role. */
const CHANNEL_SUGGESTIONS: Record<string, string[]> = {
  'onboard:ai':            ['#ai-papers — Daily AI research digests', '#us-news — AI and tech headlines'],
  'onboard:web3':          ['#us-news — Crypto and DeFi headlines', '#token-chat — Token discussion'],
  'onboard:cybersecurity': ['#threat-intel — Real-time threat feeds', '#us-news — Security headlines'],
  'onboard:startup':       ['#founders-welcome — Join the build-in-public program', '#daily-standups — Post your daily progress'],
  'onboard:jobs':          ['#jobs-software — Software engineering roles', '#us-news — Industry headlines'],
  'onboard:exploring':     ['#general — Chat with the community', '#us-news — AI-curated news feeds'],
};

/** Command suggestions keyed by onboarding role. */
const COMMAND_SUGGESTIONS: Record<string, string[]> = {
  'onboard:ai':            ['`/ask` — Ask the AI agent about ML, papers, or code', '`/research` — Deep-dive on any AI topic'],
  'onboard:web3':          ['`/ask` — Ask about DeFi, tokens, or Web3 dev'],
  'onboard:cybersecurity': ['`/ask` — Ask about CVEs, threats, or security'],
  'onboard:startup':       ['`/join_founders` — Join The Founders program', '`/daily` — Post daily updates for streak XP', '`/cofounder_search` — Find cofounders'],
  'onboard:jobs':          ['`/ask` — Interview prep tips or resume feedback'],
  'onboard:exploring':     ['`/ask` — Ask the AI agent anything', '`/trivia` — Test your knowledge'],
  'onboard:founder':       ['`/join_founders` — Join The Founders program', '`/daily` — Daily build updates', '`/profile` — View your XP and level'],
  'onboard:engineer':      ['`/ask` — Technical questions on AI, Web3, security', '`/research` — Deep research on any topic'],
};

export interface WelcomeConfig {
  channelId: string;
  openaiApiKey: string;
  systemPrompt: string;
  model?: string;
}

export function createWelcomeHandler(config: WelcomeConfig) {
  const model = config.model || 'gpt-4o';

  /** Detect onboarding roles on a member. */
  function detectOnboardingRoles(member: any): { interests: string[]; professions: string[] } {
    const interests: string[] = [];
    const professions: string[] = [];
    const roles = member.roles?.cache ?? member.roles;
    if (!roles) return { interests, professions };

    const roleNames: string[] = [];
    if (typeof roles.forEach === 'function') {
      roles.forEach((r: any) => roleNames.push(r.name));
    } else if (Array.isArray(roles)) {
      for (const r of roles) roleNames.push(typeof r === 'string' ? r : r.name);
    }

    for (const name of roleNames) {
      if (name in INTEREST_LABELS) interests.push(name);
      if (name in PROFESSION_LABELS) professions.push(name);
    }
    return { interests, professions };
  }

  /** Build suggestion text from roles. */
  function buildSuggestions(interests: string[], professions: string[]): { channels: string; commands: string } {
    const channelSet = new Set<string>();
    const channelLines: string[] = [];
    for (const role of interests) {
      for (const line of (CHANNEL_SUGGESTIONS[role] ?? [])) {
        if (!channelSet.has(line)) {
          channelSet.add(line);
          channelLines.push(line);
        }
      }
    }

    const cmdSet = new Set<string>();
    const cmdLines: string[] = [];
    // Always suggest /verify first
    cmdLines.push('`/verify` — Link your subscription to unlock premium channels');
    cmdSet.add('/verify');
    for (const role of [...interests, ...professions]) {
      for (const line of (COMMAND_SUGGESTIONS[role] ?? [])) {
        const cmd = line.split(' — ')[0];
        if (!cmdSet.has(cmd)) {
          cmdSet.add(cmd);
          cmdLines.push(line);
        }
      }
    }

    return { channels: channelLines.join('\n'), commands: cmdLines.join('\n') };
  }

  async function generateWelcome(
    displayName: string,
    username: string,
    accountAge: string,
    interests: string[],
    professions: string[],
  ): Promise<string | null> {
    const interestLabels = interests.map(r => INTEREST_LABELS[r]?.[0]).filter(Boolean);
    const professionLabels = professions.map(r => PROFESSION_LABELS[r]?.[0]).filter(Boolean);

    const personalization = interestLabels.length || professionLabels.length
      ? `\nTheir interests: ${interestLabels.join(', ') || 'exploring'}.\nTheir role: ${professionLabels.join(', ') || 'unknown'}.`
      : '';

    const systemPrompt = `${config.systemPrompt}\n\nYou are welcoming a new member to the Rabbit Hole Discord. Be warm, witty, and concise (2-3 sentences). The community is Alice in Wonderland themed — curiosity, wonder, discovery. It's AI-powered with autonomous agents that curate news, papers, jobs, and more. Reference their interests naturally if provided. Don't use hashtags. Don't be cringey. Make them want to explore.`;

    const userPrompt = `New member: ${displayName} (@${username}). Account created ${accountAge}.${personalization}\n\nWrite a personalized welcome (2-3 sentences). Reference their interests naturally.`;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 200,
          temperature: 0.8,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[Welcome] OpenAI API error ${res.status}: ${text}`);
        return null;
      }

      const data = await res.json() as any;
      const content = data?.choices?.[0]?.message?.content?.trim();
      return content ? content.replace(/^["']|["']$/g, '') : null;
    } catch (err: any) {
      console.error('[Welcome] OpenAI fetch failed:', err?.message ?? err);
      return null;
    }
  }

  function timeAgo(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days < 1) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return '1 month ago';
    if (months < 12) return `${months} months ago`;
    const years = Math.floor(months / 12);
    if (years === 1) return '1 year ago';
    return `${years} years ago`;
  }

  /** Post the personalized welcome embed. */
  async function postWelcome(member: any, service: any): Promise<void> {
    const username = member.user?.username ?? 'unknown';
    const userId = member.user?.id ?? member.id;
    const displayName = member.displayName ?? username;
    const createdAt = member.user?.createdAt ?? new Date();
    const accountAge = timeAgo(createdAt);

    const { interests, professions } = detectOnboardingRoles(member);

    const message = await generateWelcome(displayName, username, accountAge, interests, professions);
    if (!message) {
      console.warn('[Welcome] No message generated, skipping welcome for', username);
      return;
    }

    // Build interest/profession tags
    const tags: string[] = [];
    for (const r of interests) {
      const [label, emoji] = INTEREST_LABELS[r] ?? [r, ''];
      tags.push(`${emoji} ${label}`);
    }
    for (const r of professions) {
      const [label, emoji] = PROFESSION_LABELS[r] ?? [r, ''];
      tags.push(`${emoji} ${label}`);
    }

    const { channels: channelText, commands: commandText } = buildSuggestions(interests, professions);

    // Build embed with fields
    const fields: any[] = [];
    if (tags.length > 0) {
      fields.push({ name: 'Interests & Role', value: tags.join(' | '), inline: false });
    }
    if (channelText) {
      fields.push({ name: 'Channels For You', value: channelText, inline: false });
    }
    if (commandText) {
      fields.push({ name: 'Try These Commands', value: commandText, inline: false });
    }

    const embed: any = {
      title: `Welcome, ${displayName}!`,
      description: message,
      color: BRAND_COLOR,
      fields,
      footer: {
        text: 'Powered by Wunderbots | rabbithole.inc',
      },
    };

    // Set avatar as thumbnail
    const avatarUrl = member.user?.displayAvatarURL?.({ size: 128 }) ?? member.user?.avatarURL?.();
    if (avatarUrl) {
      embed.thumbnail = { url: avatarUrl };
    }

    // Find the system join message to reply to it
    let replyToId: string | undefined;
    try {
      const client = service.getClient?.();
      const channel = client?.channels?.cache?.get(config.channelId);
      if (channel && typeof channel.messages?.fetch === 'function') {
        const recent = await channel.messages.fetch({ limit: 15 });
        // Type 7 = GUILD_MEMBER_JOIN
        const joinMsg = recent.find((m: any) => m.type === 7 && m.author?.id === userId);
        if (joinMsg) replyToId = joinMsg.id;
      }
    } catch { /* fall back to no reply */ }

    const mention = `Everyone say hi to <@${userId}>!`;
    await service.sendMessage(config.channelId, mention, {
      embeds: [embed],
      ...(replyToId ? { replyToMessageId: replyToId } : {}),
    });

    // React to the system join message with 1-3 random on-brand emojis
    if (replyToId) {
      try {
        const client = service.getClient?.();
        const channel = client?.channels?.cache?.get(config.channelId);
        const joinMsg = channel && await channel.messages.fetch(replyToId).catch(() => null);
        if (joinMsg) {
          const count = 1 + Math.floor(Math.random() * 3);
          const shuffled = [...WELCOME_REACTIONS].sort(() => Math.random() - 0.5);
          for (let i = 0; i < count; i++) {
            await joinMsg.react(shuffled[i]).catch(() => {});
          }
        }
      } catch { /* non-critical */ }
    }

    console.log(`[Welcome] Welcomed ${displayName} (@${username}) — interests: [${interests.join(', ')}], profession: [${professions.join(', ')}]`);
  }

  function registerOnService(service: any): void {
    // Use guildMemberUpdate (pending → not pending) to fire AFTER onboarding
    if (typeof service.onMemberUpdate === 'function') {
      service.onMemberUpdate(async (before: any, after: any) => {
        try {
          // pending=true means member hasn't completed onboarding/screening
          const wasPending = before.pending === true;
          const isNowActive = after.pending === false;

          if (!wasPending || !isNowActive) return;

          // Member just completed onboarding — post personalized welcome
          await postWelcome(after, service);
        } catch (err: any) {
          console.error('[Welcome] Failed to welcome member (update):', err?.message ?? err);
        }
      });
      console.log('[Welcome] Registered guildMemberUpdate handler (fires after onboarding)');
    } else if (typeof service.onMemberJoin === 'function') {
      // Fallback: fire on join if onMemberUpdate not available
      service.onMemberJoin(async (member: any) => {
        try {
          // Brief delay to let onboarding roles propagate
          await new Promise(r => setTimeout(r, 3000));
          await postWelcome(member, service);
        } catch (err: any) {
          console.error('[Welcome] Failed to welcome member (join):', err?.message ?? err);
        }
      });
      console.log('[Welcome] Registered guildMemberAdd handler (fallback — no onMemberUpdate)');
    } else {
      console.warn('[Welcome] DiscordService has no member event hooks — skipping');
    }
  }

  return { registerOnService };
}
