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
import { loadEnv, loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';

// ── Provider Definitions ─────────────────────────────────────────────────

interface ProviderDef {
  id: string;
  label: string;
  envVars: readonly string[];
  local: boolean;
  streaming?: boolean;
}

const TELEPHONY_PROVIDERS: ProviderDef[] = [
  { id: 'twilio',  label: 'Twilio',  envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], local: false },
  { id: 'telnyx',  label: 'Telnyx',  envVars: ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'], local: false },
  { id: 'plivo',   label: 'Plivo',   envVars: ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN'], local: false },
];

const TTS_PROVIDERS: ProviderDef[] = [
  { id: 'openai',       label: 'OpenAI TTS',        envVars: ['OPENAI_API_KEY'],           local: false, streaming: true },
  { id: 'elevenlabs',   label: 'ElevenLabs',         envVars: ['ELEVENLABS_API_KEY'],       local: false, streaming: true },
  { id: 'google-cloud', label: 'Google Cloud TTS',   envVars: ['GOOGLE_TTS_CREDENTIALS'],   local: false, streaming: false },
  { id: 'amazon-polly', label: 'Amazon Polly',       envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], local: false, streaming: true },
  { id: 'azure',        label: 'Azure Speech TTS',   envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],    local: false, streaming: true },
  { id: 'piper',        label: 'Piper (Local)',       envVars: [],                           local: true,  streaming: false },
  { id: 'coqui',        label: 'Coqui/XTTS (Local)', envVars: [],                           local: true,  streaming: true },
  { id: 'bark',         label: 'Bark (Local)',        envVars: [],                           local: true,  streaming: false },
  { id: 'styletts2',    label: 'StyleTTS2 (Local)',   envVars: [],                           local: true,  streaming: false },
];

const STT_PROVIDERS: ProviderDef[] = [
  { id: 'openai-whisper', label: 'OpenAI Whisper',    envVars: ['OPENAI_API_KEY'],            local: false, streaming: false },
  { id: 'deepgram',       label: 'Deepgram',          envVars: ['DEEPGRAM_API_KEY'],          local: false, streaming: true },
  { id: 'assemblyai',     label: 'AssemblyAI',        envVars: ['ASSEMBLYAI_API_KEY'],        local: false, streaming: true },
  { id: 'google-cloud',   label: 'Google Cloud STT',  envVars: ['GOOGLE_STT_CREDENTIALS'],    local: false, streaming: true },
  { id: 'azure',          label: 'Azure Speech STT',  envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'], local: false, streaming: true },
  { id: 'whisper-local',  label: 'Whisper.cpp (Local)', envVars: [],                          local: true,  streaming: false },
  { id: 'vosk',           label: 'Vosk (Local)',       envVars: [],                           local: true,  streaming: true },
  { id: 'nvidia-nemo',    label: 'NeMo (Local)',       envVars: [],                           local: true,  streaming: false },
];

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
    const visibleRows = rows - 2;
    const maxOffset = Math.max(0, allLines.length - visibleRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const visible = allLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);

    if (!this.modal) {
      this.screen.render(visible.join('\n'));
      return;
    }

    const width = Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4));
    const stamped = stampOverlay({
      screenLines: visible,
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
    for (const p of TELEPHONY_PROVIDERS) {
      const ok = p.envVars.every(v => !!(env[v] || process.env[v]));
      const icon = ok ? sColor(g.ok) : muted(g.circle);
      const status = ok ? sColor('configured') : muted('not configured');
      lines.push(`    ${icon} ${p.label.padEnd(22)} ${status}`);
    }
    lines.push('');

    // ── TTS ──
    const ttsCloud = TTS_PROVIDERS.filter(p => !p.local);
    const ttsLocal = TTS_PROVIDERS.filter(p => p.local);
    const ttsConfigured = ttsCloud.filter(p => p.envVars.every(v => !!(env[v] || process.env[v]))).length;

    lines.push(`  ${iColor(g.bulletHollow)} ${bright('TTS (Text-to-Speech)')}  ${dim(`${ttsConfigured} cloud + ${ttsLocal.length} local`)}`);

    for (const p of ttsCloud) {
      const ok = p.envVars.every(v => !!(env[v] || process.env[v]));
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
    const sttCloud = STT_PROVIDERS.filter(p => !p.local);
    const sttLocal = STT_PROVIDERS.filter(p => p.local);
    const sttConfigured = sttCloud.filter(p => p.envVars.every(v => !!(env[v] || process.env[v]))).length;

    lines.push(`  ${iColor(g.bulletHollow)} ${bright('STT (Speech-to-Text)')}  ${dim(`${sttConfigured} cloud + ${sttLocal.length} local`)}`);

    for (const p of sttCloud) {
      const ok = p.envVars.every(v => !!(env[v] || process.env[v]));
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
