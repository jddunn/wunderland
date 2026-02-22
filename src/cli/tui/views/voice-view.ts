/**
 * @fileoverview TUI drill-down view: voice provider status dashboard.
 *
 * Shows telephony, TTS, and STT provider configuration at a glance.
 * @module wunderland/cli/tui/views/voice-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, info as iColor } from '../../ui/theme.js';
import { loadEnv, loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';

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
  private scrollOffset = 0;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'voice-view',
      bindings: {
        'escape':    () => { this.back(); },
        'backspace': () => { this.back(); },
        'q':         () => { this.back(); },
        'r':         () => { this.run(); },
        'up':        () => { this.scroll(-3); },
        'down':      () => { this.scroll(3); },
        'k':         () => { this.scroll(-3); },
        'j':         () => { this.scroll(3); },
      },
    });
  }

  async run(): Promise<void> {
    await loadDotEnvIntoProcessUpward({ startDir: process.cwd() });
    const env = await loadEnv();
    const allLines = this.buildLines(env);

    const { rows } = this.screen.getSize();
    const visibleRows = rows - 2;
    const maxOffset = Math.max(0, allLines.length - visibleRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const visible = allLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);
    this.screen.render(visible.join('\n'));
  }

  private buildLines(env: Record<string, string>): string[] {
    const lines: string[] = [];

    lines.push('');
    lines.push(`  ${accent('◆')} ${bright('Voice Provider Dashboard')}`);
    lines.push('');

    // ── Telephony ──
    lines.push(`  ${iColor('◇')} ${bright('Telephony')}`);
    for (const p of TELEPHONY_PROVIDERS) {
      const ok = p.envVars.every(v => !!(env[v] || process.env[v]));
      const icon = ok ? sColor('✓') : muted('○');
      const status = ok ? sColor('configured') : muted('not configured');
      lines.push(`    ${icon} ${p.label.padEnd(22)} ${status}`);
    }
    lines.push('');

    // ── TTS ──
    const ttsCloud = TTS_PROVIDERS.filter(p => !p.local);
    const ttsLocal = TTS_PROVIDERS.filter(p => p.local);
    const ttsConfigured = ttsCloud.filter(p => p.envVars.every(v => !!(env[v] || process.env[v]))).length;

    lines.push(`  ${iColor('◇')} ${bright('TTS (Text-to-Speech)')}  ${dim(`${ttsConfigured} cloud + ${ttsLocal.length} local`)}`);

    for (const p of ttsCloud) {
      const ok = p.envVars.every(v => !!(env[v] || process.env[v]));
      const icon = ok ? sColor('✓') : muted('○');
      const status = ok ? sColor('configured') : muted('not configured');
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${icon} ${p.label.padEnd(22)} ${status}${stream}`);
    }
    for (const p of ttsLocal) {
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${sColor('●')} ${p.label.padEnd(22)} ${sColor('available')}${stream}`);
    }
    lines.push('');

    // ── STT ──
    const sttCloud = STT_PROVIDERS.filter(p => !p.local);
    const sttLocal = STT_PROVIDERS.filter(p => p.local);
    const sttConfigured = sttCloud.filter(p => p.envVars.every(v => !!(env[v] || process.env[v]))).length;

    lines.push(`  ${iColor('◇')} ${bright('STT (Speech-to-Text)')}  ${dim(`${sttConfigured} cloud + ${sttLocal.length} local`)}`);

    for (const p of sttCloud) {
      const ok = p.envVars.every(v => !!(env[v] || process.env[v]));
      const icon = ok ? sColor('✓') : muted('○');
      const status = ok ? sColor('configured') : muted('not configured');
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${icon} ${p.label.padEnd(22)} ${status}${stream}`);
    }
    for (const p of sttLocal) {
      const stream = p.streaming ? dim(' [stream]') : '';
      lines.push(`    ${sColor('●')} ${p.label.padEnd(22)} ${sColor('available')}${stream}`);
    }
    lines.push('');

    // ── Voice Cloning ──
    lines.push(`  ${iColor('◇')} ${bright('Voice Cloning')}`);
    const elKey = !!(env['ELEVENLABS_API_KEY'] || process.env['ELEVENLABS_API_KEY']);
    lines.push(`    ${elKey ? sColor('✓') : muted('○')} ${'ElevenLabs (Cloud)'.padEnd(22)} ${elKey ? sColor('configured') : muted('not configured')}`);
    lines.push(`    ${sColor('●')} ${'XTTS v2 (Local)'.padEnd(22)} ${sColor('available')}`);
    lines.push('');

    // ── Summary ──
    const totalConfigured = ttsConfigured + sttConfigured + (elKey ? 1 : 0);
    const totalLocal = ttsLocal.length + sttLocal.length + 1; // +1 for XTTS
    lines.push(`  ${accent('◆')} ${dim(`${totalConfigured} cloud providers configured, ${totalLocal} local providers available`)}`);

    lines.push('');
    lines.push(`  ${dim('↑↓')} scroll  ${dim('r')} refresh  ${dim('esc')} back  ${dim('q')} quit`);

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

  dispose(): void {
    this.keys.pop();
  }
}
