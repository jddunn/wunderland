/**
 * @fileoverview TUI drill-down view: list known agents.
 * Sources: running daemons, agent history, local directory scan.
 * @module wunderland/cli/tui/views/agents-view
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, info as iColor } from '../../ui/theme.js';
import { wrapInFrame } from '../layout.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { readAllDaemons, cleanStaleDaemons, isDaemonAlive } from '../../daemon/daemon-state.js';
import { readAgentHistory } from '../../config/agent-history.js';
import { glyphs } from '../../ui/glyphs.js';

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
  const rel = path.relative(process.cwd(), p);
  if (!rel.startsWith('..')) return './' + rel;
  return p;
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

async function scanLocalAgents(): Promise<{ configPath: string; seedId: string; displayName: string }[]> {
  const results: { configPath: string; seedId: string; displayName: string }[] = [];
  const cwdConfig = path.join(process.cwd(), 'agent.config.json');
  if (existsSync(cwdConfig)) {
    const cfg = await tryParseConfig(cwdConfig);
    if (cfg) results.push({ configPath: cwdConfig, seedId: cfg.seedId, displayName: cfg.displayName });
  }
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

export class AgentsView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private configDir?: string;
  private modal: null | { title: string; lines: string[] } = null;
  private lastLines: string[] = [];

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void; configDir?: string }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;
    this.configDir = opts.configDir;

    this.keys.push({
      name: 'agents-view',
      bindings: {
        '__text__': () => { return true; },
        '?': () => {
          if (this.modal?.title === 'Help') { this.modal = null; this.render(this.lastLines); return; }
          if (this.modal) return;
          this.modal = { title: 'Help', lines: this.getHelpLines() };
          this.render(this.lastLines);
        },
        'escape': () => { if (this.modal) { this.modal = null; this.render(this.lastLines); return; } this.back(); },
        'backspace': () => { if (this.modal) { this.modal = null; this.render(this.lastLines); return; } this.back(); },
        'q': () => { if (this.modal) { this.modal = null; this.render(this.lastLines); return; } this.back(); },
        'r': () => { if (this.modal) return; this.run(); },
      },
    });
  }

  async run(): Promise<void> {
    const g = glyphs();

    await cleanStaleDaemons();

    const daemons = await readAllDaemons();
    const aliveDaemons = daemons.filter((d) => isDaemonAlive(d.pid));
    const history = readAgentHistory(this.configDir);
    const localAgents = await scanLocalAgents();

    // Build unified list, deduplicating by configPath
    const seen = new Map<string, AgentEntry>();

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

    for (const h of history) {
      const resolved = path.resolve(h.configPath);
      if (seen.has(resolved)) continue;
      if (!existsSync(resolved)) continue;
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

    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('Agents')}`);
    lines.push('');

    if (agents.length === 0) {
      lines.push(`  ${muted('No agents found.')}`);
      lines.push(`  ${dim(`Create one with ${accent('wunderland init <name>')}`)}`);
    } else {
      // Header
      const hdrName   = muted('NAME'.padEnd(22));
      const hdrStatus = muted('STATUS'.padEnd(12));
      const hdrPort   = muted('PORT'.padEnd(8));
      const hdrDir    = muted('DIRECTORY');
      lines.push(`  ${hdrName} ${hdrStatus} ${hdrPort} ${hdrDir}`);
      lines.push(`  ${dim('\u2500'.repeat(66))}`);

      for (const agent of agents) {
        const statusIcon = agent.status === 'running' ? sColor(g.ok) : muted(g.circle);
        const statusStr  = agent.status === 'running' ? sColor('running') : dim('stopped');
        const portStr    = agent.port ? accent(String(agent.port)) : dim('\u2014');
        lines.push(`  ${statusIcon} ${accent(agent.name.padEnd(20))} ${statusStr.padEnd(20)} ${portStr.padEnd(8)} ${dim(agent.dir)}`);
      }

      lines.push('');
      lines.push(`  ${iColor(g.bulletHollow)} ${dim(`${agents.length} agent${agents.length !== 1 ? 's' : ''} found`)}`);
    }

    lines.push('');
    lines.push(`  ${dim('r')} refresh  ${dim('?')} help  ${dim('esc')} back  ${dim('q')} quit`);

    this.lastLines = lines;
    this.render(lines);
  }

  private render(lines: string[]): void {
    const { rows, cols } = this.screen.getSize();
    const framed = wrapInFrame(lines, cols, 'AGENTS');
    if (!this.modal) {
      this.screen.render(framed.join('\n'));
      return;
    }
    const stamped = stampOverlay({
      screenLines: framed,
      overlayLines: renderOverlayBox({
        title: this.modal.title,
        width: Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4)),
        lines: this.modal.lines,
      }),
      cols,
      rows,
    });
    this.screen.render(stamped.join('\n'));
  }

  private getHelpLines(): string[] {
    return [
      `${bright('Agents')}`,
      `${dim('-')} Shows running daemons, local configs, and agent history.`,
      `${dim('-')} Running agents show a port number.`,
      '',
      `${bright('Shortcuts')}`,
      `${accent('r')} refresh  ${accent('esc')} back`,
    ];
  }

  private back(): void {
    this.dispose();
    this.onBack();
  }

  private disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.keys.pop();
  }
}
