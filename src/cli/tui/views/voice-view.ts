/**
 * @fileoverview TUI drill-down view: voice provider status dashboard.
 *
 * Shows telephony, TTS, and STT provider configuration at a glance.
 * @module wunderland/cli/tui/views/voice-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, info as iColor } from '../../ui/theme.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { loadEnv, loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';
import { getSpeechProviders, isSpeechProviderConfigured } from '../../../voice/speech-catalog.js';

// ── View ─────────────────────────────────────────────────────────────────

export class VoiceView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private configDir?: string;
  private scrollOffset = 0;
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void; configDir?: string }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;
    this.configDir = opts.configDir;

    this.keys.push({
      name: 'voice-view',
      bindings: {
        '__text__': () => { return true; },
        '?': () => {
          if (this.modal?.title === 'Help') { this.modal = null; this.run(); return; }
          if (this.modal) return;
          this.modal = { title: 'Help', lines: this.getHelpLines() };
          this.run();
        },
        'escape':    () => { if (this.modal) { this.modal = null; this.run(); return; } this.back(); },
        'backspace': () => { if (this.modal) { this.modal = null; this.run(); return; } this.back(); },
        'q':         () => { if (this.modal) { this.modal = null; this.run(); return; } this.back(); },
        'r':         () => { if (this.modal) return; this.run(); },
        'up':        () => { if (this.modal) return; this.scroll(-3); },
        'down':      () => { if (this.modal) return; this.scroll(3); },
        'k':         () => { if (this.modal) return; this.scroll(-3); },
        'j':         () => { if (this.modal) return; this.scroll(3); },
      },
    });
  }

  async run(): Promise<void> {
    await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: this.configDir });
    const env = await loadEnv(this.configDir);
    const allLines = this.buildLines(env);

    const { rows, cols } = this.screen.getSize();
    const visibleRows = rows - 4; // account for frame borders
    const maxOffset = Math.max(0, allLines.length - visibleRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const visible = allLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);
    const framed = wrapInFrame(visible, cols, 'VOICE');

    if (!this.modal) {
      this.screen.render(framed.join('\n'));
      return;
    }

    const width = Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4));
    const stamped = stampOverlay({
      screenLines: framed,
      overlayLines: renderOverlayBox({
        title: this.modal.title,
        width,
        lines: this.modal.lines,
      }),
      cols,
      rows,
    });
    this.screen.render(stamped.join('\n'));
  }

  private buildLines(env: Record<string, string>): string[] {
    const g = glyphs();
    const ui = getUiRuntime();
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    const lines: string[] = [];

    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('Voice Provider Dashboard')}`);
    lines.push('');

    // ── Telephony ──
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Telephony')}`);
    for (const p of getSpeechProviders('telephony')) {
      const ok = isSpeechProviderConfigured(p, env);
      const icon = ok ? sColor(g.ok) : muted(g.circle);
      const status = ok ? sColor('configured') : muted('not configured');
      lines.push(`    ${icon} ${p.label.padEnd(22)} ${status}`);
    }
    lines.push('');

    // ── TTS ──
    const ttsProviders = getSpeechProviders('tts');
    const ttsCloud = ttsProviders.filter((p) => !p.local);
    const ttsLocal = ttsProviders.filter((p) => p.local);
    const ttsConfigured = ttsCloud.filter((p) => isSpeechProviderConfigured(p, env)).length;

    lines.push(`  ${iColor(g.bulletHollow)} ${bright('TTS (Text-to-Speech)')}  ${dim(`${ttsConfigured} cloud + ${ttsLocal.length} local`)}`);

    for (const p of ttsCloud) {
      const ok = isSpeechProviderConfigured(p, env);
      const icon = ok ? sColor(g.ok) : muted(g.circle);
      const status = ok ? sColor('configured') : muted('not configured');
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${icon} ${p.label.padEnd(22)} ${status}${stream}`);
    }
    for (const p of ttsLocal) {
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${sColor(ui.ascii ? g.bullet : '●')} ${p.label.padEnd(22)} ${sColor('available')}${stream}`);
    }
    lines.push('');

    // ── STT ──
    const sttProviders = getSpeechProviders('stt');
    const sttCloud = sttProviders.filter((p) => !p.local);
    const sttLocal = sttProviders.filter((p) => p.local);
    const sttConfigured = sttCloud.filter((p) => isSpeechProviderConfigured(p, env)).length;

    lines.push(`  ${iColor(g.bulletHollow)} ${bright('STT (Speech-to-Text)')}  ${dim(`${sttConfigured} cloud + ${sttLocal.length} local`)}`);

    for (const p of sttCloud) {
      const ok = isSpeechProviderConfigured(p, env);
      const icon = ok ? sColor(g.ok) : muted(g.circle);
      const status = ok ? sColor('configured') : muted('not configured');
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${icon} ${p.label.padEnd(22)} ${status}${stream}`);
    }
    for (const p of sttLocal) {
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${sColor(ui.ascii ? g.bullet : '●')} ${p.label.padEnd(22)} ${sColor('available')}${stream}`);
    }
    lines.push('');

    // ── Voice Cloning ──
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('Voice Cloning')}`);
    const elKey = !!(env['ELEVENLABS_API_KEY'] || process.env['ELEVENLABS_API_KEY']);
    lines.push(`    ${elKey ? sColor(g.ok) : muted(g.circle)} ${'ElevenLabs (Cloud)'.padEnd(22)} ${elKey ? sColor('configured') : muted('not configured')}`);
    lines.push(`    ${sColor(ui.ascii ? g.bullet : '●')} ${'XTTS v2 (Local)'.padEnd(22)} ${sColor('available')}`);
    lines.push('');

    // ── Summary ──
    const totalConfigured = ttsConfigured + sttConfigured + (elKey ? 1 : 0);
    const totalLocal = ttsLocal.length + sttLocal.length + 1; // +1 for XTTS
    lines.push(`  ${accent(g.bullet)} ${dim(`${totalConfigured} cloud providers configured, ${totalLocal} local providers available`)}`);

    lines.push('');
    lines.push(`  ${dim(upDown)} scroll  ${dim('r')} refresh  ${dim('?')} help  ${dim('esc')} back  ${dim('q')} quit`);

    return lines;
  }

  private scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.run();
  }

  private back(): void {
    this.keys.pop();
    this.onBack();
  }

  private getHelpLines(): string[] {
    const ui = getUiRuntime();
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    return [
      `${bright('Voice Providers')}`,
      `${dim('-')} Shows telephony, TTS, and STT providers and key readiness.`,
      '',
      `${bright('Shortcuts')}`,
      `${accent(upDown)} scroll  ${accent('r')} refresh  ${accent('esc')} back`,
      '',
      `${bright('Tips')}`,
      `${dim('-')} Local providers show as available without keys.`,
      `${dim('-')} Configure cloud keys in your .env or shell env vars.`,
    ];
  }

  dispose(): void {
    this.keys.pop();
  }
}
