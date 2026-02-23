/**
 * @fileoverview TUI drill-down view: live status dashboard.
 * @module wunderland/cli/tui/views/status-view
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, warn as wColor, info as iColor } from '../../ui/theme.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { loadConfig } from '../../config/config-manager.js';
import { loadEnv, loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';
import { checkEnvSecrets, getSecretsForPlatform } from '../../config/secrets.js';
import { CHANNEL_PLATFORMS, PERSONALITY_PRESETS } from '../../constants.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';

export class StatusView {
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
      name: 'status-view',
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
        'r': () => { if (this.modal) return; this.run(); }, // Refresh
      },
    });
  }

  async run(): Promise<void> {
    const g = glyphs();
    const ui = getUiRuntime();

    await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: this.configDir });
    const config = await loadConfig(this.configDir);
    const env = await loadEnv(this.configDir);

    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('Wunderland Status')}`);
    lines.push('');

    // Agent section
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Agent')}`);
    const localConfig = path.resolve(process.cwd(), 'agent.config.json');
    if (existsSync(localConfig)) {
      try {
        const cfg = JSON.parse(await readFile(localConfig, 'utf8'));
        lines.push(`    ${muted('Name'.padEnd(20))} ${accent(cfg.displayName || 'Unknown')}`);
        lines.push(`    ${muted('Seed ID'.padEnd(20))} ${cfg.seedId || 'unknown'}`);
        if (cfg.bio) lines.push(`    ${muted('Bio'.padEnd(20))} ${dim(cfg.bio)}`);
      } catch {
        lines.push(`    ${wColor('Error reading agent.config.json')}`);
      }
    } else {
      lines.push(`    ${muted('No agent.config.json in current directory')}`);
    }
    if (config.llmProvider) lines.push(`    ${muted('LLM Provider'.padEnd(20))} ${config.llmProvider}`);
    if (config.llmModel) lines.push(`    ${muted('LLM Model'.padEnd(20))} ${config.llmModel}`);
    if (config.personalityPreset) {
      const preset = PERSONALITY_PRESETS.find((p) => p.id === config.personalityPreset);
      lines.push(`    ${muted('Personality'.padEnd(20))} ${preset ? preset.label : config.personalityPreset}`);
    }
    lines.push('');

    // Keys section
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('API Keys')}`);
    const secrets = checkEnvSecrets();
    const llmKeys = secrets.filter((s) => ['openai', 'anthropic', 'openrouter'].some((p) => s.providers.includes(p)));
    for (const s of llmKeys) {
      const icon = s.isSet ? sColor(g.ok) : muted(g.circle);
      const detail = s.isSet ? dim(s.maskedValue || 'set') : muted('not set');
      lines.push(`    ${icon} ${s.envVar.padEnd(24)} ${detail}`);
    }
    lines.push('');

    // Channels section
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Channels')}`);
    const channels = config.channels || [];
    if (channels.length === 0) {
      lines.push(`    ${muted(g.circle)} ${muted('No channels configured')}`);
    } else {
      for (const chId of channels) {
        const platform = CHANNEL_PLATFORMS.find((p) => p.id === chId);
        const label = platform
          ? (ui.ascii ? platform.label : `${platform.icon}  ${platform.label}`)
          : chId;
        const platformSecrets = getSecretsForPlatform(chId);
        const ready = platformSecrets.length === 0 || platformSecrets.every((s) => !!(env[s.envVar] || process.env[s.envVar]));
        const icon = ready ? sColor(g.ok) : wColor(g.warn);
        const status = ready ? sColor('active') : wColor('needs credentials');
        lines.push(`    ${icon} ${label.padEnd(24)} ${status}`);
      }
    }

    // Voice section
    lines.push('');
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Voice')}`);
    const voiceTts = config.voiceProvider;
    const voiceModel = config.voiceModel;
    if (voiceTts) {
      lines.push(`    ${muted('TTS Provider'.padEnd(20))} ${accent(voiceTts)}${voiceModel ? dim(` / ${voiceModel}`) : ''}`);
    } else {
      lines.push(`    ${muted('TTS Provider'.padEnd(20))} ${muted('not configured')}`);
    }

    const ttsKeys = [
      { envVar: 'OPENAI_API_KEY',     label: 'OpenAI TTS' },
      { envVar: 'ELEVENLABS_API_KEY', label: 'ElevenLabs' },
      { envVar: 'DEEPGRAM_API_KEY',   label: 'Deepgram STT' },
      { envVar: 'ASSEMBLYAI_API_KEY', label: 'AssemblyAI STT' },
    ];
    for (const k of ttsKeys) {
      const isSet = !!(env[k.envVar] || process.env[k.envVar]);
      if (isSet) {
        lines.push(`    ${sColor(g.ok)} ${k.label.padEnd(18)} ${dim('configured')}`);
      }
    }

    // Show local providers as always available
    lines.push(`    ${sColor(ui.ascii ? g.bullet : '●')} ${'Piper / Whisper.cpp'.padEnd(18)} ${dim('local (no key)')}`);

    lines.push('');
    lines.push(`  ${dim('r')} refresh  ${dim('?')} help  ${dim('esc')} back  ${dim('q')} quit`);

    this.lastLines = lines;
    this.render(lines);
  }

  private render(lines: string[]): void {
    const { rows, cols } = this.screen.getSize();
    const framed = wrapInFrame(lines, cols, 'STATUS');
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
    const g = glyphs();
    return [
      `${bright('Status')}`,
      `${dim('-')} Summarizes agent config in your cwd + global config.`,
      `${dim('-')} Shows which provider keys are detected in env/.env.`,
      '',
      `${bright('Keys')}`,
      `${dim('-')} Missing keys show as ${g.circle} / needs credentials.`,
      '',
      `${bright('Shortcuts')}`,
      `${accent('r')} refresh  ${accent('esc')} back`,
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
