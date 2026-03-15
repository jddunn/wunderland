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
  'onboard:ai':            ['#ai-papers — Daily AI research digests from arXiv', '#tech-news — AI and tech headlines'],
  'onboard:web3':          ['#crypto-trending — Trending tokens and market data', '#finance-news — Market analysis'],
  'onboard:cybersecurity': ['#threat-intel — Real-time feeds from 25+ security sources'],
  'onboard:startup':       ['#founders-welcome — Gamified build-in-public program with XP', '#cofounder-matching — Find your next co-founder'],
  'onboard:jobs':          ['#jobs-ai-ml — AI/ML roles', '#jobs-software — Software roles', '#jobs-web3 — Web3 roles'],
  'onboard:exploring':     ['#general — Where the action is'],
};

/** Command suggestions keyed by onboarding role. */
const COMMAND_SUGGESTIONS: Record<string, string[]> = {
  'onboard:ai':            ['`/ask` — Ask the AI agent about ML, papers, or code', '`/deepdive` — Deep research on any AI topic'],
  'onboard:web3':          ['`/ask` — Ask about DeFi, tokens, or Web3 dev', '`/deepdive` — Research any crypto topic in depth'],
  'onboard:cybersecurity': ['`/ask` — Ask about CVEs, threats, or security', '`/deepdive` — Deep research on any security topic'],
  'onboard:startup':       ['`/join_founders` — Join The Founders program and start earning XP', '`/daily` — Post daily updates for streak XP', '`/cofounder_search` — Find cofounders in the community'],
  'onboard:jobs':          ['`/ask` — Get interview prep tips or resume feedback', '`/faq` — Browse FAQs about the community'],
  'onboard:exploring':     ['`/ask` — Ask the AI agent anything', '`/faq` — Browse common questions'],
  'onboard:founder':       ['`/join_founders` — Join The Founders build-in-public program', '`/daily` — Post daily updates to build your streak', '`/profile` — View your Founders profile and XP'],
  'onboard:engineer':      ['`/ask` — Technical questions on AI, Web3, security, DevOps', '`/deepdive` — Deep research on any engineering topic'],
  'onboard:investor':      ['`/ask` — Market analysis and investment research', '`/deepdive` — Deep-dive on trends and sectors'],
  'onboard:student':       ['`/ask` — Get help with any topic', '`/faq` — Learn about the community'],
  'onboard:creative':      ['`/ask` — Creative projects, design, and content questions'],
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
    for (const role of [...interests, ...professions]) {
      for (const line of (COMMAND_SUGGESTIONS[role] ?? [])) {
        const cmd = line.split(' — ')[0];
        if (!cmdSet.has(cmd)) {
          cmdSet.add(cmd);
          cmdLines.push(line);
        }
      }
    }
    // Always include /verify and /faq at the end if not already present
    if (!cmdSet.has('`/verify`')) {
      cmdLines.push('`/verify` — Link your RabbitHole account to unlock premium channels');
    }
    if (!cmdSet.has('`/faq`')) {
      cmdLines.push('`/faq` — Search FAQs about the community and platform');
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
      ? `\nTheir interests: ${interestLabels.join(', ') || 'exploring'}.\nTheir profession: ${professionLabels.join(', ') || 'unknown'}.`
      : '';

    // Build context about what's relevant based on their roles
    const interestContext: string[] = [];
    if (interests.includes('onboard:ai')) interestContext.push('our AI paper digests in #ai-papers and tech news feeds');
    if (interests.includes('onboard:web3')) interestContext.push('crypto trending data and finance news channels');
    if (interests.includes('onboard:cybersecurity')) interestContext.push('#threat-intel which aggregates 25+ security sources');
    if (interests.includes('onboard:startup')) interestContext.push('The Founders program — a gamified build-in-public system with XP, levels, and co-founder matching');
    if (interests.includes('onboard:jobs')) interestContext.push('our curated job boards with AI/ML, Web3, and software roles');
    if (professions.includes('onboard:engineer')) interestContext.push('the /ask and /deepdive commands for AI-powered research');
    if (professions.includes('onboard:founder')) interestContext.push('/join_founders to start tracking your startup journey');

    const contextStr = interestContext.length > 0
      ? `\nRelevant features for them: ${interestContext.join('; ')}.`
      : '';

    const systemPrompt = `${config.systemPrompt}\n\nYou are Wunderland News — welcoming a new member to Rabbit Hole Inc's Discord. The community is Alice in Wonderland themed (curiosity, rabbit holes, wonder). It's AI-powered with autonomous agents that curate news, research, jobs, threat intel, and more.\n\nWrite a SHORT, punchy, highly personalized welcome (2 sentences MAX) that:\n1. Greets them by name and makes a specific, interesting observation or provocative comment about their interests/profession — be edgy, witty, maybe slightly inflammatory but always respectful. Make them feel like they just walked into the most interesting room they've ever been in.\n2. Tells them to drop an intro in #general — who they are, what they're building/working on, a hot take, anything. Make it sound like the community actually wants to hear from them specifically.\n\nTone: Think "that one brilliant friend who's always slightly provocative but you love them for it." Be opinionated. Be specific. Reference their actual interests, not generic fluff. No corporate speak. No "we're so glad you're here" energy. More like "oh, you're into X? you're going to lose your mind when you see what we've got." Keep it TIGHT — every word should earn its place. No filler.\n\nDo NOT mention commands, bots, or features — the embed fields handle that. Just the vibe.`;

    const userPrompt = `New member: ${displayName} (@${username}). Account created ${accountAge}.${personalization}${contextStr}\n\nWrite their personalized welcome message.`;

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
          temperature: 0.95,
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

    console.log(`[Welcome] Generating welcome for ${displayName} (@${username}), account age: ${accountAge}`);
    const message = await generateWelcome(displayName, username, accountAge, interests, professions);
    if (!message) {
      console.warn('[Welcome] No message generated, skipping welcome for', username);
      return;
    }
    console.log(`[Welcome] Generated message for ${displayName}, posting to channel ${config.channelId}`);

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
    // Encourage intro in #general
    fields.push({
      name: 'Say Hello',
      value: 'Drop into **#general** and introduce yourself — who you are, what you\'re building, a hot take, whatever. We want to hear it.',
      inline: false,
    });
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
        text: 'Wunderland News | rabbithole.inc',
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

    const mention = `<@${userId}> just fell down the rabbit hole.`;
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
    // Discord's new Onboarding system doesn't use the `pending` flag, so
    // guildMemberUpdate (pending → not pending) never fires. Instead, use
    // guildMemberAdd and poll for onboarding roles to appear.
    if (typeof service.onMemberJoin === 'function') {
      const welcomed = new Set<string>();

      service.onMemberJoin(async (member: any) => {
        const username = member.user?.username ?? member.displayName ?? 'unknown';
        console.log(`[Welcome] guildMemberAdd fired for ${username} (bot=${member.user?.bot})`);
        try {
          const userId = member.user?.id ?? member.id;
          if (member.user?.bot) return;
          if (welcomed.has(userId)) return;

          // Poll for onboarding roles — every 3s for up to 30s
          const guild = member.guild;
          let foundRoles = false;
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
              member = await guild.members.fetch(userId);
            } catch (fetchErr: any) {
              console.warn(`[Welcome] guild.members.fetch failed for ${username}: ${fetchErr?.message}`);
              return; // member left
            }
            const { interests, professions } = detectOnboardingRoles(member);
            if (interests.length > 0 || professions.length > 0) {
              console.log(`[Welcome] Found roles for ${username} after ${(i + 1) * 3}s: interests=[${interests}], professions=[${professions}]`);
              foundRoles = true;
              break;
            }
          }
          if (!foundRoles) {
            console.log(`[Welcome] No onboarding roles found for ${username} after 30s — posting generic welcome`);
          }

          welcomed.add(userId);
          // Keep set bounded
          if (welcomed.size > 1000) {
            const first = welcomed.values().next().value;
            if (first) welcomed.delete(first);
          }

          await postWelcome(member, service);
        } catch (err: any) {
          console.error('[Welcome] Failed to welcome member:', err?.message ?? err);
          if (err?.stack) console.error('[Welcome] Stack:', err.stack.split('\n').slice(0, 3).join('\n'));
        }
      });
      console.log('[Welcome] Registered guildMemberAdd handler (polls for onboarding roles)');
    } else {
      console.warn('[Welcome] DiscordService has no onMemberJoin hook — skipping');
    }
  }

  return { registerOnService };
}
