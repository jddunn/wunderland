/**
 * @fileoverview TUI drill-down view: memory & cognitive mechanisms dashboard.
 * Shows memory types, cognitive mechanisms status, personality traits,
 * retrieval budget, and infinite context configuration.
 * @module wunderland/cli/tui/views/memory-view
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, warn as wColor, info as iColor } from '../../ui/theme.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { glyphs } from '../../ui/glyphs.js';

/** Mechanism names and their cognitive science citations. */
const MECHANISMS = [
  { key: 'reconsolidation', label: 'Reconsolidation', cite: 'Nader et al., 2000', trait: 'emotionality' },
  { key: 'retrievalInducedForgetting', label: 'Retrieval-Induced Forgetting', cite: 'Anderson et al., 1994', trait: 'conscientiousness' },
  { key: 'involuntaryRecall', label: 'Involuntary Recall', cite: 'Berntsen, 2009', trait: 'openness' },
  { key: 'metacognitiveFOK', label: 'Metacognitive FOK', cite: 'Nelson & Narens, 1990', trait: 'extraversion' },
  { key: 'temporalGist', label: 'Temporal Gist', cite: 'Reyna & Brainerd, 1995', trait: 'conscientiousness' },
  { key: 'schemaEncoding', label: 'Schema Encoding', cite: 'Bartlett, 1932', trait: 'openness' },
  { key: 'sourceConfidenceDecay', label: 'Source Confidence Decay', cite: 'Johnson et al., 1993', trait: 'honesty' },
  { key: 'emotionRegulation', label: 'Emotion Regulation', cite: 'Gross, 1998', trait: 'agreeableness' },
] as const;

const MEMORY_TYPES = [
  { type: 'episodic', desc: 'Conversation events, interactions' },
  { type: 'semantic', desc: 'Learned facts, preferences, schemas' },
  { type: 'procedural', desc: 'Workflows, tool usage patterns' },
  { type: 'prospective', desc: 'Goals, reminders, planned actions' },
  { type: 'working', desc: 'Current session state (7±2 slots)' },
];

export class MemoryView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'memory-view',
      bindings: {
        q: () => this.back(),
        escape: () => { if (this.modal) { this.modal = null; void this.paint(); } else { this.back(); } },
      },
    });
  }

  private back(): void {
    this.keys.pop();
    this.onBack();
  }

  async enter(): Promise<void> {
    await this.paint();
  }

  private async paint(): Promise<void> {
    const g = glyphs();
    const lines: string[] = [];

    lines.push(bright('Memory & Cognitive Mechanisms'));
    lines.push(dim('Cognitive memory modeled on biological neuroscience'));
    lines.push('');

    // Load agent config
    const cfgPath = path.resolve(process.cwd(), 'agent.config.json');
    let mem: Record<string, any> | undefined;
    let personality: Record<string, number> | undefined;

    if (existsSync(cfgPath)) {
      try {
        const raw = JSON.parse(await readFile(cfgPath, 'utf8'));
        mem = raw.memory;
        personality = raw.personality;
      } catch { /* ignore */ }
    }

    // ── Memory Types ──────────────────────────────────────────────────
    lines.push(accent(' Memory Types'));
    for (const mt of MEMORY_TYPES) {
      lines.push(`  ${g.bullet} ${bright(mt.type.padEnd(14))} ${dim(mt.desc)}`);
    }
    lines.push('');

    // ── Configuration ─────────────────────────────────────────────────
    lines.push(accent(' Configuration'));
    if (!mem) {
      lines.push(`  ${muted(g.circle)} No memory config found`);
    } else {
      const enabled = mem.enabled !== false;
      lines.push(`  ${enabled ? sColor(g.ok) : wColor(g.warn)} Memory: ${enabled ? sColor('enabled') : wColor('disabled')}`);
      if (enabled) {
        lines.push(`  ${g.bullet} Retrieval budget: ${accent(String(mem.retrievalBudgetTokens ?? 4000))} tokens`);
        const ic = mem.infiniteContext;
        lines.push(`  ${g.bullet} Infinite context: ${ic?.enabled ? sColor('on') : muted('off')}${ic?.strategy ? dim(` (${ic.strategy})`) : ''}`);
        lines.push(`  ${g.bullet} Auto-ingest: ${mem.autoIngest?.enabled !== false ? sColor('on') : muted('off')}`);
      }
    }
    lines.push('');

    // ── Cognitive Mechanisms ──────────────────────────────────────────
    lines.push(accent(' Cognitive Mechanisms'));
    const mechCfg = mem?.cognitiveMechanisms as Record<string, any> | undefined;
    if (!mechCfg) {
      lines.push(`  ${muted(g.circle)} Not configured ${dim('(add "cognitiveMechanisms": {} to enable all)')}`);
    } else {
      for (const m of MECHANISMS) {
        const cfg = mechCfg[m.key] as Record<string, any> | undefined;
        const enabled = cfg?.enabled !== false;
        const icon = enabled ? sColor(g.ok) : muted(g.circle);
        const traitLabel = personality?.[m.trait] != null
          ? dim(` [${m.trait}=${(personality[m.trait] as number).toFixed(1)}]`)
          : '';
        lines.push(`  ${icon} ${bright(m.label.padEnd(30))} ${dim(m.cite)}${traitLabel}`);
      }
    }
    lines.push('');

    // ── Personality ───────────────────────────────────────────────────
    lines.push(accent(' HEXACO Personality'));
    if (!personality || Object.keys(personality).length === 0) {
      lines.push(`  ${muted(g.circle)} Not configured ${dim('(uniform weights, objective mode)')}`);
    } else {
      const traits = ['honesty', 'emotionality', 'extraversion', 'agreeableness', 'conscientiousness', 'openness'];
      for (const t of traits) {
        const val = personality[t] as number | undefined;
        if (val != null) {
          const bar = '█'.repeat(Math.round(val * 10)).padEnd(10, '░');
          lines.push(`  ${bright(t.padEnd(18))} ${iColor(bar)} ${accent(val.toFixed(2))}`);
        } else {
          lines.push(`  ${bright(t.padEnd(18))} ${muted('░'.repeat(10))} ${muted('0.50')} ${dim('(default)')}`);
        }
      }
    }
    lines.push('');
    lines.push(dim(`  ${g.bullet} q/Esc: back`));


    const { cols, rows } = this.screen.getSize();
    const framed = wrapInFrame(lines, cols, 'MEMORY');
    if (this.modal) {
      const stamped = stampOverlay({
        screenLines: framed,
        overlayLines: renderOverlayBox({
          title: this.modal.title,
          width: Math.min(60, cols - 4),
          lines: this.modal.lines,
        }),
        cols,
        rows,
      });
      this.screen.render(stamped.join('\n'));
    } else {
      this.screen.render(framed.join('\n'));
    }
  }
}
