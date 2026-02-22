/**
 * @fileoverview `wunderland plugins` — list installed extension packs.
 * @module wunderland/cli/commands/plugins
 */

import type { GlobalFlags } from '../types.js';
import { accent, muted, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { printTable } from '../ui/table.js';

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

  // Collect all categories in order
  const allCats = [...CATEGORY_ORDER, ...[...grouped.keys()].filter((c) => !CATEGORY_ORDER.includes(c))];

  for (const cat of allCats) {
    const group = grouped.get(cat);
    if (!group || group.length === 0) continue;

    for (const ext of group) {
      totalAvailable++;
      if (ext.available) totalInstalled++;
    }

    const catLabel = CATEGORY_LABELS[cat] || cat;
    printTable({
      title: catLabel,
      compact: true,
      zebra: false,
      columns: [
        { label: '', width: 4 },
        { label: 'Name', width: 28 },
        { label: 'Display Name', width: 24 },
        { label: 'Status', width: 16 },
      ],
      rows: group.map((ext) => [
        ext.available ? sColor('\u2713') : muted('\u25CB'),
        accent(ext.name),
        ext.displayName,
        ext.available ? sColor('installed') : muted('not installed'),
      ]),
    });
    console.log();
  }

  fmt.kvPair('Installed', `${totalInstalled} / ${totalAvailable}`);
  fmt.blank();
}
