/**
 * @fileoverview `wunderland extensions` — manage agent extensions.
 * @module wunderland/cli/commands/extensions
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { normalizeExtensionName } from '../extensions/aliases.js';

// ── Extension search scoring ────────────────────────────────────────────────

function scoreExtension(ext: { name: string; displayName: string; description: string; category: string }, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  const searchable = [ext.name, ext.displayName, ext.description, ext.category].join(' ').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (ext.name.toLowerCase() === term) { score += 50; continue; }
    if (ext.name.toLowerCase().includes(term)) { score += 30; continue; }
    if (ext.displayName.toLowerCase().includes(term)) { score += 25; continue; }
    if (ext.category.toLowerCase() === term) { score += 20; continue; }
    if (ext.description.toLowerCase().includes(term)) { score += 10; continue; }
    if (searchable.includes(term)) { score += 5; continue; }
  }
  return Math.round(score / terms.length);
}

// ── Config helpers ──────────────────────────────────────────────────────────

async function loadAgentConfig(dir: string): Promise<{ config: Record<string, unknown>; configPath: string } | null> {
  const configPath = path.join(dir, 'agent.config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = await readFile(configPath, 'utf8');
    return { config: JSON.parse(raw), configPath };
  } catch {
    return null;
  }
}

async function saveAgentConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Command handler for `wunderland extensions <subcommand>`.
 */
export default async function cmdExtensions(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'list') {
    return listExtensions(flags);
  }

  if (subcommand === 'search') {
    return searchExtensions(args.slice(1), flags);
  }

  if (subcommand === 'info') {
    return showExtensionInfo(args[1], flags);
  }

  if (subcommand === 'configure') {
    const name = args[1];
    if (!name) {
      return configureProviderDefaults(_globals);
    }
    return configureExtension(name, _globals);
  }

  if (subcommand === 'set-default') {
    return setDefaultExtensions(args.slice(1), _globals);
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const name = args[1];
    if (!name) {
      fmt.errorBlock('Missing extension name', `Usage: wunderland extensions ${subcommand} <name>`);
      process.exitCode = 1;
      return;
    }
    if (subcommand === 'enable') {
      await enableExtension(name);
      return;
    }
    await disableExtension(name);
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${subcommand}" is not a valid extensions subcommand.\nUsage: wunderland extensions <list|search|info|enable|disable> [options]`);
  process.exitCode = 1;
}

function ensureStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

function resolveConfigBucketForCategory(category: string): 'tools' | 'voice' | 'productivity' | null {
  // NOTE: channel adapters are configured via `wunderland channels`, not agent.config.json.
  if (category === 'voice') return 'voice';
  if (category === 'productivity') return 'productivity';
  if (category === 'tool' || category === 'integration' || category === 'provenance') return 'tools';
  return 'tools'; // default bucket for unknown categories
}

async function getRegistryExtensionByName(name: string): Promise<any | null> {
  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();
    const canonical = normalizeExtensionName(name);
    const ext = available.find((e) => e.name === canonical);
    return ext || null;
  } catch {
    return null;
  }
}

async function enableExtension(name: string): Promise<void> {
  const canonicalName = normalizeExtensionName(name);
  const ext = await getRegistryExtensionByName(canonicalName);
  if (!ext) {
    fmt.errorBlock('Extension not found', `No extension named "${name}" in the registry.\nRun ${accent('wunderland extensions list')} to see available extensions.`);
    process.exitCode = 1;
    return;
  }

  if (ext.category === 'channel') {
    fmt.errorBlock(
      'Channel extensions are configured separately',
      `Extension "${name}" is a channel adapter.\nUse ${accent('wunderland channels add')} to configure channels.`,
    );
    process.exitCode = 1;
    return;
  }

  const sealedPath = path.join(process.cwd(), 'sealed.json');
  if (existsSync(sealedPath)) {
    fmt.errorBlock(
      'Agent is sealed',
      `Refusing to modify agent.config.json because ${sealedPath} exists.\nUse ${accent('wunderland verify-seal')} to verify integrity.`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await loadAgentConfig(process.cwd());
  if (!result) {
    fmt.errorBlock('Missing agent config', `No agent.config.json in current directory.\nRun ${accent('wunderland init <dir>')} first.`);
    process.exitCode = 1;
    return;
  }

  const { config, configPath } = result;
  const extensions = (config.extensions && typeof config.extensions === 'object') ? (config.extensions as Record<string, unknown>) : {};

  const bucket = resolveConfigBucketForCategory(String(ext.category || 'tool'));
  if (!bucket) {
    fmt.errorBlock('Unsupported extension category', `Extension "${name}" has unsupported category "${ext.category}".`);
    process.exitCode = 1;
    return;
  }

  const current = ensureStringArray(extensions[bucket]);
  if (current.includes(canonicalName)) {
    fmt.warning(`Extension "${canonicalName}" is already enabled.`);
    return;
  }

  extensions[bucket] = [...current, canonicalName];
  config.extensions = extensions;
  await saveAgentConfig(configPath, config);

  fmt.ok(`Enabled extension ${accent(ext.displayName || canonicalName)} (${canonicalName})`);
  fmt.blank();
}

async function disableExtension(name: string): Promise<void> {
  const canonicalName = normalizeExtensionName(name);
  const sealedPath = path.join(process.cwd(), 'sealed.json');
  if (existsSync(sealedPath)) {
    fmt.errorBlock(
      'Agent is sealed',
      `Refusing to modify agent.config.json because ${sealedPath} exists.\nUse ${accent('wunderland verify-seal')} to verify integrity.`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await loadAgentConfig(process.cwd());
  if (!result) {
    fmt.errorBlock('Missing agent config', `No agent.config.json in current directory.\nRun ${accent('wunderland init <dir>')} first.`);
    process.exitCode = 1;
    return;
  }

  const { config, configPath } = result;
  const extensions = (config.extensions && typeof config.extensions === 'object') ? (config.extensions as Record<string, unknown>) : {};

  let changed = false;
  for (const bucket of ['tools', 'voice', 'productivity'] as const) {
    const arr = ensureStringArray(extensions[bucket]);
    const next = arr.filter((x) => x !== canonicalName);
    if (next.length !== arr.length) {
      extensions[bucket] = next;
      changed = true;
    }
  }

  if (!changed) {
    fmt.warning(`Extension "${canonicalName}" is not enabled in this agent.`);
    return;
  }

  config.extensions = extensions;
  await saveAgentConfig(configPath, config);

  fmt.ok(`Disabled extension ${accent(canonicalName)}`);
  fmt.blank();
}

/**
 * List all available extensions.
 */
async function searchExtensions(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    fmt.errorBlock('Missing search query', 'Usage: wunderland extensions search <query>\n\nExamples:\n  wunderland extensions search "browser"\n  wunderland extensions search voice\n  wunderland extensions search search');
    process.exitCode = 1;
    return;
  }

  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();
    const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

    const scored = available
      .map((ext: any) => ({ ext, score: scoreExtension(ext, query) }))
      .filter((r: any) => r.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 10);

    if (format === 'json') {
      console.log(JSON.stringify({ query, results: scored.map((r: any) => ({ ...r.ext, relevance: r.score })) }, null, 2));
      return;
    }

    if (scored.length === 0) {
      fmt.warning(`No extensions match "${query}".`);
      fmt.note(`Try: ${accent('wunderland extensions list')} to see all available extensions.`);
      return;
    }

    const g = glyphs();
    const maxScore = scored[0].score;
    fmt.section(`Extensions matching "${query}"`);
    fmt.blank();

    for (const { ext, score } of scored) {
      const pct = Math.min(100, Math.round((score / maxScore) * 100));
      const bar = pct >= 80 ? sColor(`(${pct}%)`) : pct >= 50 ? wColor(`(${pct}%)`) : dim(`(${pct}%)`);
      const status = ext.available ? sColor(g.ok) : muted(g.circle);
      console.log(`  ${status} ${accent(((ext as any).name || '').padEnd(24))} ${muted(ext.category.padEnd(14))} ${bar}  ${muted(ext.description)}`);
    }
    fmt.blank();
    fmt.note(`Enable: ${accent('wunderland extensions enable <name>')}`);
    fmt.blank();
  } catch {
    fmt.errorBlock('Extensions registry not available', 'Install @framers/agentos-extensions-registry to use this command.');
    process.exitCode = 1;
  }
}

async function listExtensions(flags: Record<string, string | boolean>): Promise<void> {
  const categoryFilter = typeof flags['category'] === 'string' ? flags['category'].toLowerCase() : null;

  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();

    // Group by category
    const cat = (e: { category: string }) => e.category;
    const tools = available.filter((e) => cat(e) === 'tool' || cat(e) === 'integration');
    const voice = available.filter((e) => cat(e) === 'voice');
    const productivity = available.filter((e) => cat(e) === 'productivity');
    const channels = available.filter((e) => cat(e) === 'channel');

    // Apply category filter
    const showTools = !categoryFilter || 'tool'.includes(categoryFilter) || 'integration'.includes(categoryFilter);
    const showVoice = !categoryFilter || 'voice'.includes(categoryFilter);
    const showProductivity = !categoryFilter || 'productivity'.includes(categoryFilter);
    const showChannels = !categoryFilter || 'channel'.includes(categoryFilter);

    const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

    if (format === 'json') {
      const output: Record<string, unknown> = {};
      if (showTools) output.tools = tools;
      if (showVoice) output.voice = voice;
      if (showProductivity) output.productivity = productivity;
      if (showChannels) output.channels = channels;
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    const g = glyphs();
    fmt.section('Available Extensions');

    // Category summary
    const summaryParts: string[] = [];
    if (showTools) summaryParts.push(`Tools (${tools.length})`);
    if (showVoice) summaryParts.push(`Voice (${voice.length})`);
    if (showProductivity) summaryParts.push(`Productivity (${productivity.length})`);
    if (showChannels) summaryParts.push(`Channels (${channels.length})`);
    fmt.blank();
    fmt.note(summaryParts.join('  |  '));

    // Table format
    if (showTools && tools.length > 0) {
      fmt.blank();
      fmt.note(accent('Tools:'));
      for (const ext of tools) {
        const status = ext.available ? g.ok : dim(g.fail);
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
    }

    if (showVoice && voice.length > 0) {
      fmt.blank();
      fmt.note(accent('Voice:'));
      for (const ext of voice) {
        const status = ext.available ? g.ok : dim(g.fail);
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
    }

    if (showProductivity && productivity.length > 0) {
      fmt.blank();
      fmt.note(accent('Productivity:'));
      for (const ext of productivity) {
        const status = ext.available ? g.ok : dim(g.fail);
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
    }

    if (showChannels && channels.length > 0) {
      fmt.blank();
      fmt.note(accent('Channels:'));
      for (const ext of channels.slice(0, 10)) {
        const status = ext.available ? g.ok : dim(g.fail);
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
      if (channels.length > 10) {
        fmt.note(dim(`  ... and ${channels.length - 10} more channels`));
      }
    }

    fmt.blank();
    fmt.note(`Total: ${available.length} extensions (${available.filter((e: any) => e.available).length} installed)`);
    fmt.note(`Search: ${accent('wunderland extensions search <query>')}`);
  } catch (err) {
    fmt.errorBlock('Extensions registry not available', 'Install @framers/agentos-extensions-registry to use this command.');
    process.exitCode = 1;
  }
}

/**
 * Show details for a specific extension.
 */
async function showExtensionInfo(
  name: string | undefined,
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const g = glyphs();
  if (!name) {
    fmt.errorBlock('Missing extension name', 'Usage: wunderland extensions info <name>');
    process.exitCode = 1;
    return;
  }

  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();
    const canonicalName = normalizeExtensionName(name);
    const ext = available.find((e) => e.name === canonicalName);

    if (!ext) {
      fmt.errorBlock('Extension not found', `No extension named "${canonicalName}" in the registry.`);
      process.exitCode = 1;
      return;
    }

    fmt.section(`Extension: ${ext.displayName}`);
    fmt.kvPair('Name', ext.name);
    fmt.kvPair('Category', ext.category);
    fmt.kvPair('Package', ext.packageName);
    fmt.kvPair('Description', ext.description);
    fmt.kvPair('Status', ext.available ? `${g.ok} Installed` : `${g.fail} Not installed`);
    fmt.kvPair('Default Priority', String(ext.defaultPriority));

    if (ext.requiredSecrets.length > 0) {
      fmt.kvPair('Required Secrets', ext.requiredSecrets.join(', '));
    }

    const envVars = (ext as any).envVars as string[] | undefined;
    const docsUrl = (ext as any).docsUrl as string | undefined;
    if (envVars && envVars.length > 0) {
      fmt.blank();
      fmt.note(accent('API Keys / Environment Variables:'));
      for (const envVar of envVars) {
        const value = process.env[envVar];
        const status = value ? sColor(`${g.ok} set`) : wColor(`${g.fail} not set`);
        fmt.kvPair(`  ${envVar}`, status);
      }
      if (docsUrl) {
        fmt.note(`  Get keys: ${accent(docsUrl)}`);
      }
    }

    fmt.blank();
  } catch (err) {
    fmt.errorBlock('Extensions registry not available', 'Install @framers/agentos-extensions-registry to use this command.');
    process.exitCode = 1;
  }
}

// ── Provider defaults configuration ────────────────────────────────────

async function configureProviderDefaults(globals: GlobalFlags): Promise<void> {
  const p = await import('@clack/prompts');
  const { loadConfig, updateConfig } = await import('../config/config-manager.js');
  const config = await loadConfig(globals.config);
  const current = config.providerDefaults ?? {};

  fmt.section('Provider Defaults (Global)');
  fmt.note('These preferences apply to all agents unless overridden per-agent.');
  fmt.blank();

  const imageGen = await p.select({
    message: 'Image generation provider:',
    options: [
      { value: 'openai', label: 'OpenAI (DALL-E 3)', hint: current.imageGeneration === 'openai' ? 'current' : undefined },
      { value: 'stability', label: 'Stability AI (SDXL)', hint: current.imageGeneration === 'stability' ? 'current' : undefined },
      { value: '_none', label: 'No preference (auto-detect)' },
    ],
  });
  if (p.isCancel(imageGen)) return;

  const tts = await p.select({
    message: 'Text-to-speech provider:',
    options: [
      { value: 'openai', label: 'OpenAI TTS', hint: current.tts === 'openai' ? 'current' : undefined },
      { value: 'elevenlabs', label: 'ElevenLabs', hint: current.tts === 'elevenlabs' ? 'current' : undefined },
      { value: '_none', label: 'No preference' },
    ],
  });
  if (p.isCancel(tts)) return;

  const stt = await p.select({
    message: 'Speech-to-text provider:',
    options: [
      { value: 'openai', label: 'OpenAI Whisper', hint: current.stt === 'openai' ? 'current' : undefined },
      { value: 'deepgram', label: 'Deepgram', hint: current.stt === 'deepgram' ? 'current' : undefined },
      { value: '_none', label: 'No preference' },
    ],
  });
  if (p.isCancel(stt)) return;

  const webSearch = await p.select({
    message: 'Web search provider:',
    options: [
      { value: 'serper', label: 'Serper (Google)', hint: current.webSearch === 'serper' ? 'current' : undefined },
      { value: 'brave', label: 'Brave Search', hint: current.webSearch === 'brave' ? 'current' : undefined },
      { value: 'duckduckgo', label: 'DuckDuckGo', hint: current.webSearch === 'duckduckgo' ? 'current' : undefined },
      { value: '_none', label: 'No preference' },
    ],
  });
  if (p.isCancel(webSearch)) return;

  const providerDefaults: Record<string, string> = {};
  if (imageGen && imageGen !== '_none') providerDefaults.imageGeneration = imageGen as string;
  if (tts && tts !== '_none') providerDefaults.tts = tts as string;
  if (stt && stt !== '_none') providerDefaults.stt = stt as string;
  if (webSearch && webSearch !== '_none') providerDefaults.webSearch = webSearch as string;

  await updateConfig({ providerDefaults } as any, globals.config);
  fmt.blank();
  fmt.ok('Provider defaults saved to global config (~/.wunderland/config.json).');
}

async function configureExtension(name: string, globals: GlobalFlags): Promise<void> {
  const canonicalName = normalizeExtensionName(name);
  const ext = await getRegistryExtensionByName(canonicalName);
  if (!ext) {
    fmt.errorBlock('Extension not found', `No extension named "${canonicalName}".`);
    process.exitCode = 1;
    return;
  }

  const g = glyphs();
  fmt.section(`Configure: ${ext.displayName}`);
  fmt.kvPair('Description', ext.description);

  const extEnvVars = (ext as any).envVars as string[] | undefined;
  const extDocsUrl = (ext as any).docsUrl as string | undefined;
  if (extEnvVars && extEnvVars.length > 0) {
    fmt.blank();
    fmt.note(accent('Required API Keys:'));
    for (const envVar of extEnvVars) {
      const value = process.env[envVar];
      const status = value ? sColor(`${g.ok} set`) : wColor(`${g.fail} not set`);
      fmt.kvPair(`  ${envVar}`, status);
    }
    if (extDocsUrl) {
      fmt.note(`  Get keys: ${accent(extDocsUrl)}`);
    }
  }

  fmt.blank();
  const p = await import('@clack/prompts');
  const scope = await p.select({
    message: 'Save configuration to:',
    options: [
      { value: 'global', label: 'Global (~/.wunderland/config.json)', hint: 'applies to all agents' },
      { value: 'agent', label: 'This agent (agent.config.json)', hint: 'this agent only' },
    ],
  });
  if (p.isCancel(scope)) return;

  const priority = await p.text({
    message: `Priority (default: ${ext.defaultPriority}):`,
    placeholder: String(ext.defaultPriority),
    validate: (v: string) => (v && isNaN(Number(v)) ? 'Must be a number' : undefined),
  });
  if (p.isCancel(priority)) return;

  const override: Record<string, unknown> = {};
  if (priority && String(priority).trim()) override.priority = Number(priority);

  if (scope === 'global') {
    const { loadConfig, updateConfig } = await import('../config/config-manager.js');
    const config = await loadConfig(globals.config);
    const overrides = ((config as any).extensionOverrides ?? {}) as Record<string, any>;
    overrides[canonicalName] = { ...overrides[canonicalName], ...override };
    await updateConfig({ extensionOverrides: overrides } as any, globals.config);
    fmt.ok(`Saved ${canonicalName} config to global settings.`);
  } else {
    const result = await loadAgentConfig(process.cwd());
    if (!result) {
      fmt.errorBlock('No agent config', `Run from an agent directory or use ${accent('wunderland init')}.`);
      return;
    }
    const overrides = (result.config.extensionOverrides ?? {}) as Record<string, any>;
    overrides[canonicalName] = { ...overrides[canonicalName], ...override };
    result.config.extensionOverrides = overrides;
    await saveAgentConfig(result.configPath, result.config);
    fmt.ok(`Saved ${canonicalName} config to agent settings.`);
  }
}

async function setDefaultExtensions(names: string[], globals: GlobalFlags): Promise<void> {
  if (names.length === 0) {
    fmt.errorBlock('Missing extension names', 'Usage: wunderland extensions set-default <name1> <name2> ...');
    process.exitCode = 1;
    return;
  }

  const { loadConfig, updateConfig } = await import('../config/config-manager.js');
  const config = await loadConfig(globals.config);
  const existing = (config.extensions ?? { tools: [], voice: [], productivity: [] }) as Record<string, string[]>;

  for (const name of names) {
    const canonicalName = normalizeExtensionName(name);
    const ext = await getRegistryExtensionByName(canonicalName);
    if (!ext) {
      fmt.warning(`Extension "${canonicalName}" not found in registry — skipping.`);
      continue;
    }
    const bucket = resolveConfigBucketForCategory(String(ext.category || 'tool'));
    if (!bucket) continue;
    const arr = existing[bucket] ?? [];
    if (!arr.includes(canonicalName)) {
      arr.push(canonicalName);
      existing[bucket] = arr;
      fmt.ok(`Added ${accent(canonicalName)} to global default ${bucket}`);
    } else {
      fmt.note(`${canonicalName} already in global defaults.`);
    }
  }

  await updateConfig({ extensions: existing } as any, globals.config);
  fmt.ok('Global default extensions updated.');
}
