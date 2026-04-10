// @ts-nocheck
/**
 * @fileoverview TUI drill-down view: discovery & catalog dashboard.
 *
 * Displays platform knowledge statistics, capability catalog index counts,
 * QueryRouter status, and recent recommendations made by the discovery engine.
 *
 * @module wunderland/cli/tui/views/discovery-view
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import {
  accent,
  dim,
  muted,
  bright,
  success as sColor,
  warn as wColor,
  info as iColor,
} from '../../ui/theme.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { loadConfig } from '../../config/config-manager.js';
import { loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';
import { resolveEffectiveAgentConfig } from '../../../config/effective-agent-config.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Resolved discovery stats from agent config + defaults. */
interface DiscoveryStats {
  enabled: boolean;
  recallProfile: string;
  capabilityCount: number;
  graphNodes: number;
  graphEdges: number;
  presetCoOccurrences: number;
  manifestDirs: string[];
}

/** Platform knowledge breakdown. */
interface PlatformKnowledge {
  total: number;
  tools: number;
  skills: number;
  faq: number;
  api: number;
  troubleshooting: number;
}

// ── DiscoveryView ──────────────────────────────────────────────────────────

export class DiscoveryView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private configDir?: string;
  private modal: null | { title: string; lines: string[] } = null;
  private lastLines: string[] = [];

  constructor(opts: {
    screen: Screen;
    keys: KeybindingManager;
    onBack: () => void;
    configDir?: string;
  }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;
    this.configDir = opts.configDir;

    this.keys.push({
      name: 'discovery-view',
      bindings: {
        '__text__': () => { return true; },
        '?': () => {
          if (this.modal?.title === 'Help') {
            this.modal = null;
            this.render(this.lastLines);
            return;
          }
          if (this.modal) return;
          this.modal = { title: 'Help', lines: this.getHelpLines() };
          this.render(this.lastLines);
        },
        'escape': () => {
          if (this.modal) { this.modal = null; this.render(this.lastLines); return; }
          this.back();
        },
        'backspace': () => {
          if (this.modal) { this.modal = null; this.render(this.lastLines); return; }
          this.back();
        },
        'q': () => {
          if (this.modal) { this.modal = null; this.render(this.lastLines); return; }
          this.back();
        },
        'r': () => {
          if (this.modal) return;
          this.run();
        },
      },
    });
  }

  /** Build and display the discovery dashboard. */
  async run(): Promise<void> {
    const g = glyphs();
    void getUiRuntime(); // touch UI runtime for side-effect initialization

    await loadDotEnvIntoProcessUpward({
      startDir: process.cwd(),
      configDirOverride: this.configDir,
    });
    const config = await loadConfig(this.configDir);

    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('Discovery & Catalog')}`);
    lines.push('');

    // ── Agent discovery config ───────────────────────────────────────
    const discoveryStats = await this.resolveDiscoveryStats(config);

    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Capability Discovery')}`);
    lines.push(
      `    ${muted('Status'.padEnd(20))} ${discoveryStats.enabled ? sColor('enabled') : wColor('disabled')}`,
    );
    lines.push(
      `    ${muted('Recall Profile'.padEnd(20))} ${accent(discoveryStats.recallProfile)}`,
    );
    lines.push(
      `    ${muted('Capabilities'.padEnd(20))} ${discoveryStats.capabilityCount > 0 ? String(discoveryStats.capabilityCount) : muted('not indexed yet')}`,
    );
    lines.push(
      `    ${muted('Graph Nodes'.padEnd(20))} ${discoveryStats.graphNodes > 0 ? String(discoveryStats.graphNodes) : muted('0')}`,
    );
    lines.push(
      `    ${muted('Graph Edges'.padEnd(20))} ${discoveryStats.graphEdges > 0 ? String(discoveryStats.graphEdges) : muted('0')}`,
    );
    lines.push(
      `    ${muted('Co-occurrences'.padEnd(20))} ${discoveryStats.presetCoOccurrences > 0 ? String(discoveryStats.presetCoOccurrences) : muted('0')}`,
    );
    if (discoveryStats.manifestDirs.length > 0) {
      lines.push(
        `    ${muted('Manifest Dirs'.padEnd(20))} ${dim(discoveryStats.manifestDirs.join(', '))}`,
      );
    }
    lines.push('');

    // ── Platform Knowledge ───────────────────────────────────────────
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Platform Knowledge')}`);
    const pk = this.getStaticPlatformKnowledge();
    lines.push(
      `    ${muted('Entries'.padEnd(20))} ${accent(String(pk.total))} ${dim(`(${pk.tools} tools, ${pk.skills} skills, ${pk.faq} FAQ, ${pk.api} API, ${pk.troubleshooting} troubleshooting)`)}`,
    );
    lines.push('');

    // ── Capability Catalog ───────────────────────────────────────────
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Capability Catalog')}`);
    const catalogStats = this.getCatalogStats();
    lines.push(
      `    ${muted('Extensions'.padEnd(20))} ${accent(String(catalogStats.extensions))} indexed`,
    );
    lines.push(
      `    ${muted('Skills'.padEnd(20))} ${accent(String(catalogStats.skills))} curated`,
    );
    lines.push('');

    // ── QueryRouter Status ───────────────────────────────────────────
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('QueryRouter')}`);
    const ragAny = config.rag as Record<string, unknown> | undefined;
    const routerEnabled = (ragAny?.queryRouter as Record<string, unknown> | undefined)?.enabled !== false;
    if (routerEnabled) {
      lines.push(
        `    ${muted('Status'.padEnd(20))} ${sColor('enabled')} ${dim('(initialises on chat/start)')}`,
      );
      const qrConfig = ragAny?.queryRouter as Record<string, unknown> | undefined;
      const classifierMode = (qrConfig?.classifierMode as string) || 'hybrid';
      const defaultStrategy = (qrConfig?.defaultStrategy as string) || 'moderate';
      lines.push(
        `    ${muted('Classifier'.padEnd(20))} ${accent(classifierMode)}`,
      );
      lines.push(
        `    ${muted('Default Strategy'.padEnd(20))} ${accent(defaultStrategy)}`,
      );
    } else {
      lines.push(
        `    ${muted('Status'.padEnd(20))} ${wColor('disabled')}`,
      );
      lines.push(
        `    ${dim('Enable with: rag.queryRouter.enabled: true in agent.config.json')}`,
      );
    }
    lines.push('');

    // ── Safety & HITL ─────────────────────────────────────────────────
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Safety & HITL')}`);
    const hitlCfg = await this.resolveHitlConfig(config);
    const hitlModeColor = hitlCfg.mode === 'human' ? sColor(hitlCfg.mode)
      : hitlCfg.mode === 'llm-judge' ? iColor(hitlCfg.mode)
      : wColor(hitlCfg.mode);
    lines.push(
      `    ${muted('HITL Mode'.padEnd(20))} ${hitlModeColor}`,
    );
    lines.push(
      `    ${muted('Available Handlers'.padEnd(20))} ${dim('autoApprove, autoReject, cli, webhook, slack, llmJudge')}`,
    );
    lines.push(
      `    ${muted('Guardrail Override'.padEnd(20))} ${hitlCfg.guardrailOverride ? sColor('enabled') : wColor('disabled')}`,
    );
    lines.push(
      `    ${muted('Post-approval'.padEnd(20))} ${dim(hitlCfg.postApprovalGuardrails.join(', '))}`,
    );
    lines.push('');

    // ── Recent Recommendations ───────────────────────────────────────
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Recent Recommendations')}`);
    lines.push(
      `    ${muted('(Live recommendations appear in')} ${accent('wunderland chat')} ${muted('sessions)')}`,
    );
    lines.push(
      `    ${dim('Use /discover and /router inside chat to see live stats.')}`,
    );
    lines.push('');

    lines.push(`  ${dim('r')} refresh  ${dim('?')} help  ${dim('esc')} back  ${dim('q')} quit`);

    this.lastLines = lines;
    this.render(lines);
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private render(lines: string[]): void {
    const { rows, cols } = this.screen.getSize();
    const framed = wrapInFrame(lines, cols, 'DISCOVERY');
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

  /**
   * Resolve discovery config from the local agent.config.json.
   * Falls back to sensible defaults when no local config exists.
   */
  private async resolveDiscoveryStats(_config?: unknown): Promise<DiscoveryStats> {
    const defaults: DiscoveryStats = {
      enabled: false,
      recallProfile: 'balanced',
      capabilityCount: 0,
      graphNodes: 0,
      graphEdges: 0,
      presetCoOccurrences: 0,
      manifestDirs: [],
    };

    const localConfig = path.resolve(process.cwd(), 'agent.config.json');
    if (!existsSync(localConfig)) return defaults;

    try {
      const rawCfg = JSON.parse(await readFile(localConfig, 'utf8'));
      const effective = await resolveEffectiveAgentConfig({
        agentConfig: rawCfg,
        workingDirectory: process.cwd(),
      });
      const cfg = effective.agentConfig;

      if (cfg.discovery) {
        return {
          enabled: cfg.discovery.enabled ?? false,
          recallProfile: cfg.discovery.recallProfile || 'balanced',
          capabilityCount: 0, // Only populated at runtime during chat/start
          graphNodes: 0,
          graphEdges: 0,
          presetCoOccurrences: 0,
          manifestDirs: (cfg.discovery as Record<string, unknown>).manifestDirs as string[] || [],
        };
      }
    } catch {
      // Config unreadable — use defaults
    }

    return defaults;
  }

  /**
   * Returns static platform knowledge counts.
   *
   * These numbers reflect the curated knowledge base shipped with the CLI.
   * Actual runtime counts may differ if custom entries are added via config.
   */
  private getStaticPlatformKnowledge(): PlatformKnowledge {
    return {
      total: 243,
      tools: 105,
      skills: 79,
      faq: 30,
      api: 14,
      troubleshooting: 15,
    };
  }

  /**
   * Returns static catalog counts for extensions and skills.
   *
   * Reflects the curated registry shipped with the CLI.
   */
  private getCatalogStats(): { extensions: number; skills: number } {
    return {
      extensions: 105,
      skills: 69,
    };
  }

  /**
   * Resolve HITL/approval config from the local agent.config.json.
   * Falls back to safe defaults when no local config or hitl block exists.
   */
  private async resolveHitlConfig(
    _config?: unknown,
  ): Promise<{ mode: string; guardrailOverride: boolean; postApprovalGuardrails: string[] }> {
    const defaults = { mode: 'human', guardrailOverride: true, postApprovalGuardrails: ['code-safety', 'pii-redaction'] };

    const localConfig = path.resolve(process.cwd(), 'agent.config.json');
    if (!existsSync(localConfig)) return defaults;

    try {
      const rawCfg = JSON.parse(await readFile(localConfig, 'utf8'));
      const effective = await resolveEffectiveAgentConfig({
        agentConfig: rawCfg,
        workingDirectory: process.cwd(),
      });
      const hitl = (effective.agentConfig as Record<string, unknown>).hitl as Record<string, unknown> | undefined;
      if (!hitl) return defaults;

      return {
        mode: (hitl.mode as string) || 'human',
        guardrailOverride: hitl.guardrailOverride !== false,
        postApprovalGuardrails: (hitl.postApprovalGuardrails as string[]) ?? defaults.postApprovalGuardrails,
      };
    } catch {
      return defaults;
    }
  }

  private getHelpLines(): string[] {
    return [
      `${bright('Discovery & Catalog')}`,
      `${dim('-')} Shows capability discovery engine status and config.`,
      `${dim('-')} Platform knowledge: curated corpus of tools, skills, FAQ, and API docs.`,
      `${dim('-')} Catalog: indexed extensions and curated skills from the registry.`,
      `${dim('-')} QueryRouter: auto-classifies queries and routes to the best retrieval strategy.`,
      '',
      `${bright('Live Stats')}`,
      `${dim('-')} Full runtime stats (graph nodes, edges, recommendations) are available`,
      `${dim('  inside')} ${accent('wunderland chat')} ${dim('via /discover and /router.')}`,
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
