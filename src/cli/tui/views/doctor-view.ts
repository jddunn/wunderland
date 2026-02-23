/**
 * @fileoverview TUI drill-down view: animated health check.
 * @module wunderland/cli/tui/views/doctor-view
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, error as eColor, info as iColor } from '../../ui/theme.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { getConfigPath } from '../../config/config-manager.js';
import { getEnvPath, loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';
import { checkEnvSecrets } from '../../config/secrets.js';
import { URLS } from '../../constants.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';

interface CheckResult {
  label: string;
  section: string;
  status: 'pending' | 'pass' | 'fail' | 'skip';
  detail?: string;
}

export class DoctorView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private configDir?: string;
  private checks: CheckResult[] = [];
  private done = false;
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void; configDir?: string }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;
    this.configDir = opts.configDir;

    this.keys.push({
      name: 'doctor-view',
      bindings: {
        '__text__': () => { return true; },
        '?': () => {
          if (this.modal?.title === 'Help') { this.modal = null; this.renderChecks(); return; }
          if (this.modal) return;
          this.modal = { title: 'Help', lines: this.getHelpLines() };
          this.renderChecks();
        },
        'escape': () => { if (this.modal) { this.modal = null; this.renderChecks(); return; } this.back(); },
        'backspace': () => { if (this.modal) { this.modal = null; this.renderChecks(); return; } this.back(); },
        'q': () => { if (this.modal) { this.modal = null; this.renderChecks(); return; } this.back(); },
      },
    });
  }

  async run(): Promise<void> {
    await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: this.configDir });

    const configPath = getConfigPath(this.configDir);
    const envPath = getEnvPath(this.configDir);
    const localConfig = path.resolve(process.cwd(), 'agent.config.json');

    const secretStatus = checkEnvSecrets();
    const importantKeys = [
      'openai.apiKey', 'anthropic.apiKey', 'openrouter.apiKey',
      'elevenlabs.apiKey', 'deepgram.apiKey', 'assemblyai.apiKey',
    ];
    const keyEntries = importantKeys.map((id) => secretStatus.find((x) => x.id === id)).filter(Boolean) as any[];

    // Build check list
    this.checks = [
      { label: path.basename(configPath), section: 'Configuration', status: 'pending' },
      { label: '.env', section: 'Configuration', status: 'pending' },
      { label: 'agent.config.json', section: 'Configuration', status: 'pending' },
      ...keyEntries.map((k: any) => ({ label: k.envVar, section: 'API Keys', status: 'pending' as const })),
      { label: 'OpenAI API', section: 'Connectivity', status: 'pending' },
      { label: URLS.website, section: 'Connectivity', status: 'pending' },
    ];

    this.renderChecks();

    // Run checks with animation
    // Config checks
    this.resolve(0, existsSync(configPath) ? 'pass' : 'skip', existsSync(configPath) ? undefined : 'not found');
    this.resolve(1, existsSync(envPath) ? 'pass' : 'skip', existsSync(envPath) ? undefined : 'not found');
    this.resolve(2, existsSync(localConfig) ? 'pass' : 'skip', existsSync(localConfig) ? 'found' : 'not in cwd');

    // Key checks
    for (let i = 0; i < keyEntries.length; i++) {
      const k = keyEntries[i];
      this.resolve(3 + i, k.isSet ? 'pass' : (k.optional ? 'skip' : 'fail'), k.isSet ? `set (${k.maskedValue})` : 'not set');
    }

    // Connectivity checks
    const connIdx = 3 + keyEntries.length;
    for (let i = 0; i < 2; i++) {
      const url = i === 0 ? 'https://api.openai.com/v1/models' : URLS.website;
      try {
        const start = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timer);
        const latency = Date.now() - start;
        const ok = res.ok || res.status < 500;
        this.resolve(connIdx + i, ok ? 'pass' : 'fail', `${ok ? 'reachable' : 'unreachable'} (${latency}ms)`);
      } catch {
        this.resolve(connIdx + i, 'fail', 'unreachable');
      }
    }

    this.done = true;
    this.renderChecks();
  }

  private resolve(index: number, status: 'pass' | 'fail' | 'skip', detail?: string): void {
    if (this.checks[index]) {
      this.checks[index].status = status;
      this.checks[index].detail = detail;
      this.renderChecks();
    }
  }

  private renderChecks(): void {
    const g = glyphs();
    const ui = getUiRuntime();
    const { rows, cols } = this.screen.getSize();
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('Wunderland Doctor')}`);
    lines.push('');

    let currentSection = '';
    let passed = 0, failed = 0, skipped = 0;

    for (const check of this.checks) {
      if (check.section !== currentSection) {
        currentSection = check.section;
        lines.push(`  ${iColor(g.bulletHollow)} ${bright(currentSection)}`);
      }

      const icon = check.status === 'pass' ? sColor(g.ok)
        : check.status === 'fail' ? eColor(g.fail)
        : check.status === 'skip' ? muted(g.circle)
        : dim(ui.ascii ? '...' : '⋯');
      const label = check.status === 'fail' ? eColor(check.label) : check.label;
      const detail = check.detail ? `  ${dim(check.detail)}` : '';
      lines.push(`  ${icon} ${label}${detail}`);

      if (check.status === 'pass') passed++;
      else if (check.status === 'fail') failed++;
      else if (check.status === 'skip') skipped++;
    }

    lines.push('');
    if (this.done) {
      const parts = [
        sColor(`${passed} passed`),
        skipped > 0 ? muted(`${skipped} skipped`) : '',
        failed > 0 ? eColor(`${failed} failed`) : '',
      ].filter(Boolean).join(dim(', '));
      lines.push(`  ${accent(g.bullet)} ${parts}`);
    } else {
      lines.push(`  ${dim('Running checks...')}`);
    }

    lines.push('');
    lines.push(`  ${dim('?')} help  ${dim('esc')} back  ${dim('q')} quit`);

    const stamped = this.modal
      ? stampOverlay({
          screenLines: lines,
          overlayLines: renderOverlayBox({
            title: this.modal.title,
            width: Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4)),
            lines: this.modal.lines,
          }),
          cols,
          rows,
        })
      : lines;

    this.screen.render(stamped.join('\n'));
  }

  private getHelpLines(): string[] {
    return [
      `${bright('What this does')}`,
      `${dim('-')} Checks config files in your current directory and user config.`,
      `${dim('-')} Verifies common provider keys (LLM + voice).`,
      `${dim('-')} Pings a couple endpoints to validate connectivity.`,
      '',
      `${bright('Next steps')}`,
      `${dim('-')} Run ${accent('wunderland setup')} to configure an agent.`,
      `${dim('-')} Run ${accent('wunderland start')} to launch the server.`,
    ];
  }

  private back(): void {
    this.keys.pop();
    this.onBack();
  }

  dispose(): void {
    this.keys.pop();
  }
}
