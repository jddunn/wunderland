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
export const CREDENTIALS_DIR_NAME = 'credentials';

// ── LLM Providers ───────────────────────────────────────────────────────────

export const LLM_PROVIDERS = [
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', docsUrl: 'https://platform.openai.com/account/api-keys', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'] },
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', docsUrl: 'https://console.anthropic.com/settings/keys', models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'] },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', docsUrl: 'https://openrouter.ai/keys', models: ['auto'] },
  { id: 'ollama', label: 'Ollama (local)', envVar: '', docsUrl: 'https://ollama.ai/', models: ['llama3', 'mistral', 'codellama'] },
] as const;

// ── Channel Platforms ───────────────────────────────────────────────────────

export const CHANNEL_PLATFORMS = [
  { id: 'telegram', label: 'Telegram', icon: '\u{1F4AC}', tier: 'p0' },
  { id: 'discord', label: 'Discord', icon: '\u{1F3AE}', tier: 'p0' },
  { id: 'slack', label: 'Slack', icon: '\u{1F4E1}', tier: 'p0' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '\u{1F4F1}', tier: 'p0' },
  { id: 'webchat', label: 'WebChat', icon: '\u{1F310}', tier: 'p0' },
  { id: 'signal', label: 'Signal', icon: '\u{1F512}', tier: 'p1' },
  { id: 'imessage', label: 'iMessage', icon: '\u{1F34E}', tier: 'p1' },
  { id: 'google-chat', label: 'Google Chat', icon: '\u{1F4E7}', tier: 'p1' },
  { id: 'teams', label: 'Microsoft Teams', icon: '\u{1F4BC}', tier: 'p1' },
  { id: 'matrix', label: 'Matrix', icon: '\u{1F30D}', tier: 'p2' },
  { id: 'email', label: 'Email', icon: '\u{2709}\u{FE0F}', tier: 'p2' },
  { id: 'sms', label: 'SMS', icon: '\u{1F4F2}', tier: 'p2' },
  { id: 'zalo', label: 'Zalo', icon: '\u{1F1FB}\u{1F1F3}', tier: 'p2' },
] as const;

// ── Tool Categories ─────────────────────────────────────────────────────────

export const TOOL_CATEGORIES = [
  { id: 'web-search', label: 'Web Search', providers: ['serper', 'serpapi', 'brave'] },
  { id: 'voice', label: 'Voice Synthesis', providers: ['elevenlabs'] },
  { id: 'image-search', label: 'Image Search', providers: ['pexels', 'unsplash', 'pixabay'] },
  { id: 'news', label: 'News Search', providers: ['newsapi'] },
  { id: 'media', label: 'GIFs & Media', providers: ['giphy'] },
] as const;

// ── HEXACO Presets ──────────────────────────────────────────────────────────

export const PERSONALITY_PRESETS = [
  { id: 'HELPFUL_ASSISTANT', label: 'Helpful Assistant', desc: 'Organized, detail-oriented, accommodating' },
  { id: 'CREATIVE_THINKER', label: 'Creative Thinker', desc: 'Imaginative, unconventional, open' },
  { id: 'ANALYTICAL_RESEARCHER', label: 'Analytical Researcher', desc: 'Precise, systematic, thorough' },
  { id: 'EMPATHETIC_COUNSELOR', label: 'Empathetic Counselor', desc: 'Warm, supportive, patient' },
  { id: 'DECISIVE_EXECUTOR', label: 'Decisive Executor', desc: 'Direct, confident, results-driven' },
] as const;
