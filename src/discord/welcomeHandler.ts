/**
 * Welcome handler — generates personalized, on-brand welcome messages for new
 * Discord members using OpenAI (gpt-4o-mini) and the Rabbit Hole AI personality.
 *
 * Posts a branded embed to a configurable channel when guildMemberAdd fires.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const BRAND_COLOR = 0x8b6914;

const WELCOME_ADDENDUM = `
You are welcoming a new member to the Rabbit Hole Discord. Be warm, brief (1-2 sentences), and on-brand. Reference their name naturally. Don't be cheesy or generic. Don't use excessive emojis. Make them feel like they just stumbled into something interesting.`.trim();

export interface WelcomeConfig {
  channelId: string;
  openaiApiKey: string;
  systemPrompt: string;
  model?: string;
}

export function createWelcomeHandler(config: WelcomeConfig) {
  const model = config.model || 'gpt-4o-mini';

  async function generateWelcome(displayName: string, username: string, accountAge: string): Promise<string | null> {
    const systemPrompt = `${config.systemPrompt}\n\n${WELCOME_ADDENDUM}`;
    const userPrompt = `New member just joined: ${displayName} (@${username}). Account created ${accountAge}. Write a brief, warm welcome (1-2 sentences max). Reference their name naturally. Stay in character.`;

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
          max_tokens: 150,
          temperature: 0.9,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[Welcome] OpenAI API error ${res.status}: ${text}`);
        return null;
      }

      const data = await res.json() as any;
      const content = data?.choices?.[0]?.message?.content?.trim();
      return content || null;
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

  function registerOnService(service: any): void {
    if (typeof service.onMemberJoin !== 'function') {
      console.warn('[Welcome] DiscordService does not have onMemberJoin — skipping');
      return;
    }

    service.onMemberJoin(async (member: any) => {
      try {
        const username = member.user?.username ?? 'unknown';
        const userId = member.user?.id ?? member.id;
        const displayName = member.displayName ?? username;
        const createdAt = member.user?.createdAt ?? new Date();
        const accountAge = timeAgo(createdAt);

        const message = await generateWelcome(displayName, username, accountAge);
        if (!message) {
          console.warn('[Welcome] No message generated, skipping welcome for', username);
          return;
        }

        const embed = {
          description: message,
          color: BRAND_COLOR,
          footer: {
            text: 'Use /ask — I can search the web, answer questions, look things up, and more \u2022 #info for the full rundown \u2022 rabbithole.inc',
          },
        };

        // Find the system join message to reply to it
        let replyToId: string | undefined;
        try {
          const client = service.getClient?.();
          const channel = client?.channels?.cache?.get(config.channelId);
          if (channel && typeof channel.messages?.fetch === 'function') {
            // Brief pause for the system join message to appear
            await new Promise(r => setTimeout(r, 1500));
            const recent = await channel.messages.fetch({ limit: 10 });
            // Type 7 = GUILD_MEMBER_JOIN
            const joinMsg = recent.find((m: any) => m.type === 7 && m.author?.id === userId);
            if (joinMsg) replyToId = joinMsg.id;
          }
        } catch { /* fall back to no reply */ }

        const mention = `<@${userId}>`;
        await service.sendMessage(config.channelId, mention, {
          embeds: [embed],
          ...(replyToId ? { replyToMessageId: replyToId } : {}),
        });
        console.log(`[Welcome] Welcomed ${displayName} (@${username})`);
      } catch (err: any) {
        console.error('[Welcome] Failed to welcome member:', err?.message ?? err);
      }
    });

    console.log('[Welcome] Registered guildMemberAdd handler');
  }

  return { registerOnService };
}
