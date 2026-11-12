// @ts-nocheck
export interface ExtensionRecommendation {
  extensionId: string;
  packageName: string;
  reason: 'credential_detected' | 'skill_requires' | 'preset_default';
  displayName: string;
  envVar?: string;
}

/**
 * Credential-to-extension mapping.
 * Each entry maps one or more env vars to an extension that should be suggested.
 */
const CREDENTIAL_MAP: Array<{
  envVars: string[];
  allRequired: boolean;
  extensionId: string;
  packageName: string;
  displayName: string;
}> = [
  {
    envVars: ['NEWSAPI_API_KEY'],
    allRequired: false,
    extensionId: 'news-search',
    packageName: '@framers/agentos-ext-news-search',
    displayName: 'News Search (NewsAPI)',
  },
  {
    envVars: ['SERPER_API_KEY'],
    allRequired: false,
    extensionId: 'web-search',
    packageName: '@framers/agentos-ext-web-search',
    displayName: 'Web Search (Serper)',
  },
  {
    envVars: ['GIPHY_API_KEY'],
    allRequired: false,
    extensionId: 'giphy',
    packageName: '@framers/agentos-ext-giphy',
    displayName: 'Giphy',
  },
  {
    envVars: ['ELEVENLABS_API_KEY'],
    allRequired: false,
    extensionId: 'voice-synthesis',
    packageName: '@framers/agentos-ext-voice-synthesis',
    displayName: 'Voice Synthesis (ElevenLabs)',
  },
  {
    envVars: ['GITHUB_TOKEN'],
    allRequired: false,
    extensionId: 'github',
    packageName: '@framers/agentos-ext-github',
    displayName: 'GitHub',
  },
  {
    envVars: ['TELEGRAM_BOT_TOKEN'],
    allRequired: false,
    extensionId: 'telegram',
    packageName: '@framers/agentos-ext-telegram',
    displayName: 'Telegram',
  },
  {
    envVars: ['DISCORD_BOT_TOKEN'],
    allRequired: false,
    extensionId: 'discord',
    packageName: '@framers/agentos-ext-discord',
    displayName: 'Discord',
  },
  {
    envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    allRequired: true,
    extensionId: 'email-gmail',
    packageName: '@framers/agentos-ext-email-gmail',
    displayName: 'Gmail',
  },
  {
    envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    allRequired: true,
    extensionId: 'calendar-google',
    packageName: '@framers/agentos-ext-calendar-google',
    displayName: 'Google Calendar',
  },
  {
    envVars: ['RUNWAY_API_KEY'],
    allRequired: false,
    extensionId: 'video-generation',
    packageName: '@framers/agentos-ext-video-generation',
    displayName: 'Video Generation (Runway)',
  },
  {
    envVars: ['REPLICATE_API_TOKEN'],
    allRequired: false,
    extensionId: 'video-generation',
    packageName: '@framers/agentos-ext-video-generation',
    displayName: 'Video Generation (Replicate)',
  },
  {
    envVars: ['REPLICATE_API_TOKEN'],
    allRequired: false,
    extensionId: 'audio-generation',
    packageName: '@framers/agentos-ext-audio-generation',
    displayName: 'Audio Generation (Replicate)',
  },
  {
    envVars: ['FAL_API_KEY'],
    allRequired: false,
    extensionId: 'video-generation',
    packageName: '@framers/agentos-ext-video-generation',
    displayName: 'Video Generation (fal.ai)',
  },
  {
    envVars: ['FAL_API_KEY'],
    allRequired: false,
    extensionId: 'audio-generation',
    packageName: '@framers/agentos-ext-audio-generation',
    displayName: 'Audio Generation (fal.ai)',
  },
  {
    envVars: ['SUNO_API_KEY'],
    allRequired: false,
    extensionId: 'audio-generation',
    packageName: '@framers/agentos-ext-audio-generation',
    displayName: 'Audio Generation (Suno)',
  },
  {
    envVars: ['STABILITY_API_KEY'],
    allRequired: false,
    extensionId: 'audio-generation',
    packageName: '@framers/agentos-ext-audio-generation',
    displayName: 'Audio Generation (Stability)',
  },
  {
    envVars: ['BFL_API_KEY'],
    allRequired: false,
    extensionId: 'image-generation',
    packageName: '@framers/agentos-ext-image-generation',
    displayName: 'Image Generation (BFL)',
  },
  {
    envVars: ['OMDB_API_KEY'],
    allRequired: false,
    extensionId: 'omdb',
    packageName: '@framers/agentos-ext-omdb',
    displayName: 'OMDB (Movie Database)',
  },
  {
    envVars: ['CLEARBIT_API_KEY'],
    allRequired: false,
    extensionId: 'clearbit',
    packageName: '@framers/agentos-ext-clearbit',
    displayName: 'Clearbit Enrichment',
  },
];

/**
 * Scans environment for known API keys and recommends matching extensions.
 * Skips extensions that are already enabled.
 */
export async function getRecommendations(opts: {
  env?: Record<string, string | undefined>;
  enabledExtensions?: string[];
}): Promise<ExtensionRecommendation[]> {
  const env = opts.env ?? process.env;
  const enabled = new Set(opts.enabledExtensions ?? []);
  const recs: ExtensionRecommendation[] = [];

  for (const mapping of CREDENTIAL_MAP) {
    if (enabled.has(mapping.extensionId)) continue;

    const hasCredentials = mapping.allRequired
      ? mapping.envVars.every((v) => !!env[v])
      : mapping.envVars.some((v) => !!env[v]);

    if (!hasCredentials) continue;

    recs.push({
      extensionId: mapping.extensionId,
      packageName: mapping.packageName,
      reason: 'credential_detected',
      displayName: mapping.displayName,
      envVar: mapping.envVars[0],
    });
  }

  return recs;
}

/**
 * Formats recommendations as a CLI-friendly table.
 */
export function formatRecommendations(recs: ExtensionRecommendation[]): string {
  if (recs.length === 0) return '';
  const lines = ['', '  Recommended extensions (credentials detected):', ''];
  for (const r of recs) {
    lines.push(`    ${r.displayName} (${r.extensionId}) — ${r.envVar} found`);
  }
  lines.push('');
  return lines.join('\n');
}
