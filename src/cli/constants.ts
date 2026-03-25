/**
 * @fileoverview CLI constants — version, URLs, channel metadata.
 * @module wunderland/cli/constants
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

/** Package version, read from package.json at runtime. */
export const VERSION = pkg.version;

// ── URLs ────────────────────────────────────────────────────────────────────

export const URLS = {
  website: 'https://wunderland.sh',
  saas: 'https://rabbithole.inc',
  docs: 'https://docs.wunderland.sh',
  github: 'https://github.com/framersai/wunderland',
} as const;

// ── Config paths ────────────────────────────────────────────────────────────

export const CONFIG_DIR_NAME = '.wunderland';
export const CONFIG_FILE_NAME = 'config.json';
export const ENV_FILE_NAME = '.env';
export const USAGE_LEDGER_FILE_NAME = 'usage-ledger.jsonl';
export const CREDENTIALS_DIR_NAME = 'credentials';

// ── LLM Providers ───────────────────────────────────────────────────────────

export const LLM_PROVIDERS = [
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', signupUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://developers.openai.com/api/docs', validationUrl: 'https://api.openai.com/v1/models', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'] },
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', signupUrl: 'https://console.anthropic.com/settings/keys', docsUrl: 'https://platform.claude.com/docs/en/api/overview', validationUrl: 'https://api.anthropic.com/v1/messages', models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'] },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', signupUrl: 'https://openrouter.ai/keys', docsUrl: 'https://openrouter.ai/docs/quickstart', validationUrl: 'https://openrouter.ai/api/v1/models', models: ['auto'] },
  { id: 'ollama', label: 'Ollama (local)', envVar: '', signupUrl: 'https://ollama.ai/download', docsUrl: 'https://docs.ollama.com/', validationUrl: '', models: ['qwen2.5:7b', 'qwen2.5:3b', 'llama3.3', 'gemma3:4b', 'mistral'] },
  { id: 'bedrock', label: 'AWS Bedrock', envVar: 'AWS_ACCESS_KEY_ID', signupUrl: 'https://console.aws.amazon.com/bedrock/', docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/', validationUrl: '', models: ['anthropic.claude-sonnet', 'anthropic.claude-haiku'] },
  { id: 'gemini', label: 'Google Gemini', envVar: 'GEMINI_API_KEY', signupUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs', validationUrl: 'https://generativelanguage.googleapis.com/v1beta/models', models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-pro'] },
  { id: 'github-copilot', label: 'GitHub Copilot', envVar: 'GITHUB_COPILOT_TOKEN', signupUrl: 'https://github.com/settings/copilot', docsUrl: 'https://docs.github.com/en/copilot', validationUrl: '', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'minimax', label: 'Minimax', envVar: 'MINIMAX_API_KEY', signupUrl: 'https://platform.minimaxi.com/', docsUrl: 'https://platform.minimaxi.com/docs/llms.txt', validationUrl: '', models: ['MiniMax-M2.1', 'MiniMax-VL-01'] },
  { id: 'qwen', label: 'Qwen', envVar: 'QWEN_API_KEY', signupUrl: 'https://qwen.ai/home', docsUrl: 'https://qwen.ai/home', validationUrl: '', models: ['qwen-max', 'qwen-turbo'] },
  { id: 'moonshot', label: 'Moonshot', envVar: 'MOONSHOT_API_KEY', signupUrl: 'https://platform.moonshot.cn/', docsUrl: 'https://platform.moonshot.cn/docs/overview', validationUrl: '', models: ['kimi-k2.5', 'kimi-k2-instant'] },
  { id: 'venice', label: 'Venice', envVar: 'VENICE_API_KEY', signupUrl: 'https://venice.ai/settings/api', docsUrl: 'https://venice.ai/', validationUrl: '', models: ['venice-default', 'venice-fast'] },
  { id: 'cloudflare-ai', label: 'Cloudflare AI Gateway', envVar: 'CLOUDFLARE_API_TOKEN', signupUrl: 'https://dash.cloudflare.com/', docsUrl: 'https://developers.cloudflare.com/ai-gateway/', validationUrl: '', models: ['(configurable)'] },
  { id: 'xiaomi-mimo', label: 'Xiaomi Mimo', envVar: 'XIAOMI_API_KEY', signupUrl: 'https://dev.mi.com/mimo', docsUrl: 'https://dev.mi.com/mimo', validationUrl: '', models: ['mimo-v2-flash'] },
] as const;

// ── Tool API Key Providers ─────────────────────────────────────────────────

export const TOOL_KEY_PROVIDERS = [
  { id: 'serper', label: 'Serper (Google Search)', envVar: 'SERPER_API_KEY', category: 'search', signupUrl: 'https://serper.dev/api-key', validationUrl: 'https://google.serper.dev/search' },
  { id: 'brave', label: 'Brave Search', envVar: 'BRAVE_API_KEY', category: 'search', signupUrl: 'https://brave.com/search/api/', validationUrl: 'https://api.search.brave.com/res/v1/web/search' },
  { id: 'newsapi', label: 'NewsAPI', envVar: 'NEWSAPI_API_KEY', category: 'search', signupUrl: 'https://newsapi.org/register', validationUrl: 'https://newsapi.org/v2/top-headlines' },
  { id: 'giphy', label: 'Giphy', envVar: 'GIPHY_API_KEY', category: 'media', signupUrl: 'https://developers.giphy.com/dashboard/', validationUrl: '' },
  { id: 'pexels', label: 'Pexels', envVar: 'PEXELS_API_KEY', category: 'media', signupUrl: 'https://www.pexels.com/api/new/', validationUrl: '' },
  { id: 'unsplash', label: 'Unsplash', envVar: 'UNSPLASH_ACCESS_KEY', category: 'media', signupUrl: 'https://unsplash.com/developers', validationUrl: '' },
  { id: 'pixabay', label: 'Pixabay', envVar: 'PIXABAY_API_KEY', category: 'media', signupUrl: 'https://pixabay.com/api/docs/', validationUrl: '' },
  { id: 'elevenlabs', label: 'ElevenLabs (TTS)', envVar: 'ELEVENLABS_API_KEY', category: 'voice', signupUrl: 'https://elevenlabs.io/app/settings/api-keys', validationUrl: 'https://api.elevenlabs.io/v1/user' },
  { id: 'github', label: 'GitHub', envVar: 'GITHUB_TOKEN', category: 'devtools', signupUrl: 'https://github.com/settings/tokens', validationUrl: 'https://api.github.com/user' },
] as const;

// ── Channel Platforms ───────────────────────────────────────────────────────

export const CHANNEL_PLATFORMS = [
  { id: 'telegram', label: 'Telegram', icon: '\u{1F4AC}', tier: 'p0' },
  { id: 'discord', label: 'Discord', icon: '\u{1F3AE}', tier: 'p0' },
  { id: 'slack', label: 'Slack', icon: '\u{1F4E1}', tier: 'p0' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '\u{1F4F1}', tier: 'p0' },
  { id: 'webchat', label: 'WebChat', icon: '\u{1F310}', tier: 'p0' },
  { id: 'twitter', label: 'Twitter / X', icon: '\u{1F426}', tier: 'p0' },
  { id: 'instagram', label: 'Instagram', icon: '\u{1F4F7}', tier: 'p0' },
  { id: 'linkedin', label: 'LinkedIn', icon: '\u{1F4BC}', tier: 'p0' },
  { id: 'facebook', label: 'Facebook', icon: '\u{1F4D8}', tier: 'p0' },
  { id: 'threads', label: 'Threads', icon: '\u{1F9F5}', tier: 'p1' },
  { id: 'bluesky', label: 'Bluesky', icon: '\u{2601}\u{FE0F}', tier: 'p1' },
  { id: 'mastodon', label: 'Mastodon', icon: '\u{1F418}', tier: 'p1' },
  { id: 'farcaster', label: 'Farcaster', icon: '\u{1F680}', tier: 'p1' },
  { id: 'lemmy', label: 'Lemmy', icon: '\u{1F30D}', tier: 'p2' },
  { id: 'google-business', label: 'Google Business', icon: '\u{1F4CD}', tier: 'p1' },
  { id: 'devto', label: 'Blog Publisher', icon: '\u{270D}\u{FE0F}', tier: 'p2' },
  { id: 'reddit', label: 'Reddit', icon: '\u{1F47D}', tier: 'p0' },
  { id: 'youtube', label: 'YouTube', icon: '\u{1F3A5}', tier: 'p0' },
  { id: 'signal', label: 'Signal', icon: '\u{1F512}', tier: 'p1' },
  { id: 'imessage', label: 'iMessage', icon: '\u{1F34E}', tier: 'p1' },
  { id: 'google-chat', label: 'Google Chat', icon: '\u{1F4E7}', tier: 'p1' },
  { id: 'teams', label: 'Microsoft Teams', icon: '\u{1F4BC}', tier: 'p1' },
  { id: 'pinterest', label: 'Pinterest', icon: '\u{1F4CC}', tier: 'p1' },
  { id: 'tiktok', label: 'TikTok', icon: '\u{1F3B5}', tier: 'p1' },
  { id: 'matrix', label: 'Matrix', icon: '\u{1F30D}', tier: 'p2' },
  { id: 'email', label: 'Email', icon: '\u{2709}\u{FE0F}', tier: 'p2' },
  { id: 'sms', label: 'SMS', icon: '\u{1F4F2}', tier: 'p2' },
  { id: 'zalo', label: 'Zalo', icon: '\u{1F1FB}\u{1F1F3}', tier: 'p2' },
  { id: 'nostr', label: 'Nostr', icon: '\u{1F5A7}', tier: 'p3' },
  { id: 'twitch', label: 'Twitch', icon: '\u{1F3AC}', tier: 'p3' },
  { id: 'line', label: 'LINE', icon: '\u{1F4AC}', tier: 'p3' },
  { id: 'feishu', label: 'Feishu / Lark', icon: '\u{1F426}', tier: 'p3' },
  { id: 'mattermost', label: 'Mattermost', icon: '\u{1F4E8}', tier: 'p3' },
  { id: 'nextcloud-talk', label: 'NextCloud Talk', icon: '\u{2601}\u{FE0F}', tier: 'p3' },
  { id: 'tlon', label: 'Tlon (Urbit)', icon: '\u{1F30A}', tier: 'p3' },
  { id: 'irc', label: 'IRC', icon: '\u{1F4AC}', tier: 'p3' },
  { id: 'zalouser', label: 'Zalo Personal', icon: '\u{1F464}', tier: 'p3' },
] as const;

// ── Tool Categories ─────────────────────────────────────────────────────────

export const TOOL_CATEGORIES = [
  { id: 'web-search', label: 'Web Search', providers: ['serper', 'serpapi', 'brave'] },
  { id: 'voice-synthesis', label: 'Voice Synthesis', providers: ['elevenlabs'] },
  { id: 'image-search', label: 'Image Search', providers: ['pexels', 'unsplash', 'pixabay'] },
  { id: 'news', label: 'News Search', providers: ['newsapi'] },
  { id: 'media', label: 'GIFs & Media', providers: ['giphy'] },
] as const;

// ── Voice Telephony Providers ────────────────────────────────────────────────

export const VOICE_PROVIDERS = [
  { id: 'twilio', label: 'Twilio', icon: '\u{1F4DE}', tier: 'p0' },
  { id: 'telnyx', label: 'Telnyx', icon: '\u{1F4DE}', tier: 'p0' },
  { id: 'plivo', label: 'Plivo', icon: '\u{1F4DE}', tier: 'p0' },
] as const;

// ── Productivity Integrations ────────────────────────────────────────────────

export const PRODUCTIVITY_INTEGRATIONS = [
  { id: 'calendar-google', label: 'Google Calendar', icon: '\u{1F4C5}', providers: ['calendar-google'] },
  { id: 'email-gmail', label: 'Gmail', icon: '\u{2709}\u{FE0F}', providers: ['email-gmail'] },
] as const;

// ── Cloud Hosting Providers ─────────────────────────────────────────────────

export const CLOUD_PROVIDERS = [
  { id: 'vercel', label: 'Vercel', icon: '\u{25B2}', tier: 'p0', secretEnv: ['VERCEL_TOKEN', 'VERCEL_ORG_ID'], toolCount: 6, bestFor: 'Next.js, React, frontend frameworks' },
  { id: 'cloudflare', label: 'Cloudflare Pages', icon: '\u{2601}\u{FE0F}', tier: 'p0', secretEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], toolCount: 6, bestFor: 'Static sites, Workers, edge-first apps' },
  { id: 'netlify', label: 'Netlify', icon: '\u{1F310}', tier: 'p0', secretEnv: ['NETLIFY_AUTH_TOKEN'], toolCount: 5, bestFor: 'JAMstack, static sites, form handling' },
  { id: 'digitalocean', label: 'DigitalOcean App Platform', icon: '\u{1F30A}', tier: 'p1', secretEnv: ['DIGITALOCEAN_TOKEN'], toolCount: 5, bestFor: 'Full-stack apps, managed databases' },
  { id: 'railway', label: 'Railway', icon: '\u{1F682}', tier: 'p1', secretEnv: ['RAILWAY_TOKEN'], toolCount: 5, bestFor: 'Backend services, databases, quick deploys' },
  { id: 'fly', label: 'Fly.io', icon: '\u{1F680}', tier: 'p1', secretEnv: ['FLY_API_TOKEN'], toolCount: 5, bestFor: 'Containers, global edge, low-latency APIs' },
  { id: 'aws', label: 'AWS (S3 + CloudFront)', icon: '\u{1F4E6}', tier: 'p2', secretEnv: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], toolCount: 4, bestFor: 'Enterprise, static hosting, CDN at scale' },
  { id: 'heroku', label: 'Heroku', icon: '\u{1F7E3}', tier: 'p2', secretEnv: ['HEROKU_API_KEY'], toolCount: 4, bestFor: 'Prototypes, simple backend services' },
  { id: 'linode', label: 'Linode (Akamai)', icon: '\u{1F5A5}\u{FE0F}', tier: 'p2', secretEnv: ['LINODE_TOKEN'], toolCount: 4, bestFor: 'VPS hosting, self-managed infrastructure' },
] as const;

// ── Domain Registrars ──────────────────────────────────────────────────────

export const DOMAIN_REGISTRARS = [
  { id: 'porkbun', label: 'Porkbun', icon: '\u{1F437}', secretEnv: ['PORKBUN_API_KEY', 'PORKBUN_SECRET_KEY'], toolCount: 5, dnsRecords: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'] },
  { id: 'namecheap', label: 'Namecheap', icon: '\u{1F4B0}', secretEnv: ['NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME'], toolCount: 5, dnsRecords: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'] },
  { id: 'godaddy', label: 'GoDaddy', icon: '\u{1F30D}', secretEnv: ['GODADDY_API_KEY', 'GODADDY_API_SECRET'], toolCount: 4, dnsRecords: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV'] },
  { id: 'cloudflare', label: 'Cloudflare Registrar', icon: '\u{2601}\u{FE0F}', secretEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], toolCount: 5, dnsRecords: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'] },
] as const;

// ── HEXACO Presets ──────────────────────────────────────────────────────────

export const PERSONALITY_PRESETS = [
  { id: 'HELPFUL_ASSISTANT', label: 'Helpful Assistant', desc: 'Organized, detail-oriented, accommodating' },
  { id: 'CREATIVE_THINKER', label: 'Creative Thinker', desc: 'Imaginative, unconventional, open' },
  { id: 'ANALYTICAL_RESEARCHER', label: 'Analytical Researcher', desc: 'Precise, systematic, thorough' },
  { id: 'EMPATHETIC_COUNSELOR', label: 'Empathetic Counselor', desc: 'Warm, supportive, patient' },
  { id: 'DECISIVE_EXECUTOR', label: 'Decisive Executor', desc: 'Direct, confident, results-driven' },
] as const;
