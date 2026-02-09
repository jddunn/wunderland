/**
 * @fileoverview `wunderland plugins` — list installed extension packs.
 * @module wunderland/cli/commands/plugins
 */

import chalk from 'chalk';
import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

// ── Fallback catalog when the registry is not available ─────────────────────

interface ExtensionEntry {
  name: string;
  category: string;
  available: boolean;
  displayName: string;
  description: string;
}

const FALLBACK_EXTENSIONS: ExtensionEntry[] = [
  { name: 'cli-executor', category: 'tool', available: false, displayName: 'CLI Executor', description: 'Execute shell commands in a sandboxed environment' },
  { name: 'web-search', category: 'tool', available: false, displayName: 'Web Search', description: 'Web search via Serper.dev or similar providers' },
  { name: 'web-browser', category: 'tool', available: false, displayName: 'Web Browser', description: 'Headless browser for page fetching and scraping' },
  { name: 'giphy', category: 'tool', available: false, displayName: 'Giphy', description: 'Search and share GIFs' },
  { name: 'image-search', category: 'tool', available: false, displayName: 'Image Search', description: 'Search for images via web APIs' },
  { name: 'voice-synthesis', category: 'tool', available: false, displayName: 'Voice Synthesis', description: 'Text-to-speech synthesis' },
  { name: 'news-search', category: 'tool', available: false, displayName: 'News Search', description: 'Search recent news articles' },
  { name: 'skills', category: 'tool', available: false, displayName: 'Skills Registry', description: 'Curated SKILL.md prompt modules' },
  { name: 'auth', category: 'tool', available: false, displayName: 'Authentication', description: 'User authentication and session management' },
  { name: 'telegram', category: 'channel', available: false, displayName: 'Telegram', description: 'Telegram bot channel adapter' },
  { name: 'discord', category: 'channel', available: false, displayName: 'Discord', description: 'Discord bot channel adapter' },
  { name: 'slack', category: 'channel', available: false, displayName: 'Slack', description: 'Slack bot channel adapter' },
  { name: 'whatsapp', category: 'channel', available: false, displayName: 'WhatsApp', description: 'WhatsApp Business API adapter' },
  { name: 'voice-twilio', category: 'voice', available: false, displayName: 'Twilio Voice', description: 'Phone call integration via Twilio' },
  { name: 'voice-telnyx', category: 'voice', available: false, displayName: 'Telnyx Voice', description: 'Phone call integration via Telnyx' },
  { name: 'voice-plivo', category: 'voice', available: false, displayName: 'Plivo Voice', description: 'Phone call integration via Plivo' },
  { name: 'calendar-google', category: 'productivity', available: false, displayName: 'Google Calendar', description: 'Google Calendar API integration' },
  { name: 'email-gmail', category: 'productivity', available: false, displayName: 'Gmail', description: 'Gmail API integration' },
];

// ── Catalog loading ─────────────────────────────────────────────────────────

async function loadExtensions(): Promise<{ entries: ExtensionEntry[]; source: string }> {
  try {
    const registry = await import('@framers/agentos-extensions-registry');
    const extensions = await registry.getAvailableExtensions();
    const entries: ExtensionEntry[] = extensions.map((ext: any) => ({
      name: ext.name,
      category: ext.category,
      available: ext.available,
      displayName: ext.displayName,
      description: ext.description,
    }));
    return { entries, source: 'registry' };
  } catch {
    return { entries: FALLBACK_EXTENSIONS, source: 'fallback' };
  }
}

// ── Category grouping ───────────────────────────────────────────────────────

const CATEGORY_ORDER = ['tool', 'channel', 'voice', 'productivity', 'integration', 'provenance'];
const CATEGORY_LABELS: Record<string, string> = {
  tool: 'Tools',
  channel: 'Channels',
  voice: 'Voice Providers',
  productivity: 'Productivity',
  integration: 'Integrations',
  provenance: 'Provenance',
};

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdPlugins(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const { entries, source } = await loadExtensions();

  if (format === 'json') {
    console.log(JSON.stringify({ source, extensions: entries }, null, 2));
    return;
  }

  fmt.section('Extension Packs');
  if (source === 'fallback') {
    fmt.note('Showing fallback catalog (install @framers/agentos-extensions-registry for live detection)');
  }
  fmt.blank();

  // Group by category
  const grouped = new Map<string, ExtensionEntry[]>();
  for (const entry of entries) {
    const cat = entry.category || 'other';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(entry);
  }

  let totalInstalled = 0;
  let totalAvailable = 0;

  // Print in category order
  for (const cat of CATEGORY_ORDER) {
    const group = grouped.get(cat);
    if (!group || group.length === 0) continue;

    const catLabel = CATEGORY_LABELS[cat] || cat;
    console.log(`    ${chalk.white(catLabel)}`);
    console.log(`    ${dim('\u2500'.repeat(60))}`);

    for (const ext of group) {
      const statusIcon = ext.available ? sColor('\u2713') : muted('\u25CB');
      const statusLabel = ext.available ? sColor('installed') : muted('not installed');
      console.log(`    ${statusIcon} ${accent(ext.name.padEnd(22))} ${ext.displayName.padEnd(22)} ${statusLabel}`);
      totalAvailable++;
      if (ext.available) totalInstalled++;
    }
    console.log();
  }

  // Print any remaining categories not in the order list
  for (const [cat, group] of grouped) {
    if (CATEGORY_ORDER.includes(cat)) continue;
    const catLabel = CATEGORY_LABELS[cat] || cat;
    console.log(`    ${chalk.white(catLabel)}`);
    console.log(`    ${dim('\u2500'.repeat(60))}`);
    for (const ext of group) {
      const statusIcon = ext.available ? sColor('\u2713') : muted('\u25CB');
      const statusLabel = ext.available ? sColor('installed') : muted('not installed');
      console.log(`    ${statusIcon} ${accent(ext.name.padEnd(22))} ${ext.displayName.padEnd(22)} ${statusLabel}`);
      totalAvailable++;
      if (ext.available) totalInstalled++;
    }
    console.log();
  }

  fmt.kvPair('Installed', `${totalInstalled} / ${totalAvailable}`);
  fmt.blank();
}
