/**
 * @fileoverview TUI drill-down view: animated health check.
 * @module wunderland/cli/tui/views/doctor-view
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, error as eColor, info as iColor } from '../../ui/theme.js';
import { getConfigPath } from '../../config/config-manager.js';
import { getEnvPath, loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';
import { checkEnvSecrets } from '../../config/secrets.js';
import { URLS } from '../../constants.js';

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
  private checks: CheckResult[] = [];
  private done = false;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'doctor-view',
      bindings: {
        'escape': () => { this.back(); },
        'backspace': () => { this.back(); },
        'q': () => { this.back(); },
      },
    });
  }

  async run(): Promise<void> {
    await loadDotEnvIntoProcessUpward({ startDir: process.cwd() });

    const configPath = getConfigPath();
    const envPath = getEnvPath();
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
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent('◆')} ${bright('Wunderland Doctor')}`);
    lines.push('');

    let currentSection = '';
    let passed = 0, failed = 0, skipped = 0;

    for (const check of this.checks) {
      if (check.section !== currentSection) {
        currentSection = check.section;
        lines.push(`  ${iColor('◇')} ${bright(currentSection)}`);
      }

      const icon = check.status === 'pass' ? sColor('✓')
        : check.status === 'fail' ? eColor('✗')
        : check.status === 'skip' ? muted('○')
        : dim('⋯');
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
      lines.push(`  ${accent('◆')} ${parts}`);
    } else {
      lines.push(`  ${dim('Running checks...')}`);
    }

    lines.push('');
    lines.push(`  ${dim('esc')} back  ${dim('q')} quit`);

    this.screen.render(lines.join('\n'));
  }

  private back(): void {
    this.keys.pop();
    this.onBack();
  }

  dispose(): void {
    this.keys.pop();
  }
}
