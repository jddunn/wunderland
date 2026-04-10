// @ts-nocheck
/**
 * @fileoverview `wunderland agents` / `wunderland ls` — list known agents.
 * Sources: running daemons, agent history, local directory scan.
 * @module wunderland/cli/commands/agents
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GlobalFlags } from '../../types.js';
import { accent, dim, success as sColor } from '../../ui/theme.js';
import * as fmt from '../../ui/format.js';
import { readAllDaemons, cleanStaleDaemons, isDaemonAlive } from '../../daemon/daemon-state.js';
import { readAgentHistory } from '../../config/agent-history.js';

interface AgentEntry {
  name: string;
  seedId: string;
  status: 'running' | 'stopped';
  port: number | null;
  dir: string;
  configPath: string;
}

/** Shorten an absolute path for display: replace homedir with ~. */
function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  // Show relative to cwd if it's a descendant
  const rel = path.relative(process.cwd(), p);
  if (!rel.startsWith('..')) return './' + rel;
  return p;
}

/** Scan current directory for agent.config.json files (max depth 2). */
async function scanLocalAgents(): Promise<{ configPath: string; seedId: string; displayName: string }[]> {
  const results: { configPath: string; seedId: string; displayName: string }[] = [];

  // Check cwd itself
  const cwdConfig = path.join(process.cwd(), 'agent.config.json');
  if (existsSync(cwdConfig)) {
    const cfg = await tryParseConfig(cwdConfig);
    if (cfg) results.push({ configPath: cwdConfig, seedId: cfg.seedId, displayName: cfg.displayName });
  }

  // Check immediate subdirectories
  try {
    const entries = await readdir(process.cwd(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const subConfig = path.join(process.cwd(), entry.name, 'agent.config.json');
      if (existsSync(subConfig)) {
        const cfg = await tryParseConfig(subConfig);
        if (cfg) results.push({ configPath: subConfig, seedId: cfg.seedId, displayName: cfg.displayName });
      }
    }
  } catch {
    // Can't read directory — skip
  }

  return results;
}

async function tryParseConfig(configPath: string): Promise<{ seedId: string; displayName: string } | null> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    return { seedId: cfg.seedId || 'unknown', displayName: cfg.displayName || path.basename(path.dirname(configPath)) };
  } catch {
    return null;
  }
}

export default async function cmdAgents(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // Clean stale daemon entries
  await cleanStaleDaemons();

  // Gather from all sources
  const daemons = await readAllDaemons();
  const aliveDaemons = daemons.filter((d) => isDaemonAlive(d.pid));
  const history = readAgentHistory(globals.config);
  const localAgents = await scanLocalAgents();

  // Build unified list, deduplicating by configPath (resolved)
  const seen = new Map<string, AgentEntry>();

  // Running daemons first (highest priority)
  for (const d of aliveDaemons) {
    const resolved = path.resolve(d.configPath);
    seen.set(resolved, {
      name: d.displayName,
      seedId: d.seedId,
      status: 'running',
      port: d.port,
      dir: shortenPath(path.dirname(resolved)),
      configPath: resolved,
    });
  }

  // Local directory scan
  for (const local of localAgents) {
    const resolved = path.resolve(local.configPath);
    if (seen.has(resolved)) continue;
    seen.set(resolved, {
      name: local.displayName,
      seedId: local.seedId,
      status: 'stopped',
      port: null,
      dir: shortenPath(path.dirname(resolved)),
      configPath: resolved,
    });
  }

  // History (lowest priority — may reference dirs that no longer exist)
  for (const h of history) {
    const resolved = path.resolve(h.configPath);
    if (seen.has(resolved)) continue;
    if (!existsSync(resolved)) continue; // Skip if config file was deleted
    seen.set(resolved, {
      name: h.displayName,
      seedId: h.seedId,
      status: 'stopped',
      port: null,
      dir: shortenPath(path.dirname(resolved)),
      configPath: resolved,
    });
  }

  const agents = Array.from(seen.values());

  // JSON output
  if (flags['format'] === 'json') {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }

  if (agents.length === 0) {
    fmt.note(`No agents found. Create one with ${accent('wunderland init <name>')}`);
    return;
  }

  fmt.section('Agents');

  const header = padRow('NAME', 'STATUS', 'PORT', 'DIRECTORY');
  console.log(`  ${dim(header)}`);

  for (const agent of agents) {
    const statusStr = agent.status === 'running' ? sColor('running') : dim('stopped');
    const portStr = agent.port ? String(agent.port) : dim('—');
    console.log(`  ${padRow(agent.name, statusStr, portStr, dim(agent.dir))}`);
  }

  fmt.blank();
  fmt.note(`cd into an agent directory and run ${accent('wunderland start')}`);
  fmt.blank();
}

function padRow(name: string, status: string, port: string, dir: string): string {
  return `${name.padEnd(22)} ${status.padEnd(18)} ${port.padEnd(8)} ${dir}`;
}
