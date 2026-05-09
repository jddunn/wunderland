// @ts-nocheck
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
import { resolveAgentDisplayName } from '../../../runtime/agent-identity.js';
import { HEXACO_PRESETS } from '../../../agents/builder/WunderlandSeed.js';
import { DEFAULT_HEXACO_TRAITS, type HEXACOTraits } from '../../../core/types.js';
import { resolveEffectiveAgentConfig } from '../../../config/effective-agent-config.js';

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
    let resolvedAgentConfig: any | undefined;
    let selectedPersona: any | undefined;
    let availablePersonas: any[] | undefined;
    if (existsSync(localConfig)) {
      try {
        const rawCfg = JSON.parse(await readFile(localConfig, 'utf8'));
        const effective = await resolveEffectiveAgentConfig({
          agentConfig: rawCfg,
          workingDirectory: process.cwd(),
        });
        const cfg = effective.agentConfig;
        resolvedAgentConfig = cfg;
        selectedPersona = effective.selectedPersona;
        availablePersonas = effective.availablePersonas;
        const resolvedName = resolveAgentDisplayName({
          displayName: cfg.displayName,
          agentName: cfg.agentName,
          globalAgentName: config.agentName,
          seedId: cfg.seedId,
          fallback: 'Unknown',
        });
        lines.push(`    ${muted('Name'.padEnd(20))} ${accent(resolvedName)}`);
        lines.push(`    ${muted('Seed ID'.padEnd(20))} ${cfg.seedId || 'unknown'}`);
        if (cfg.bio) lines.push(`    ${muted('Bio'.padEnd(20))} ${dim(cfg.bio)}`);
        if (cfg.presetId) lines.push(`    ${muted('Preset'.padEnd(20))} ${accent(cfg.presetId)}`);
        if (selectedPersona) {
          lines.push(`    ${muted('AgentOS Persona'.padEnd(20))} ${accent(selectedPersona.name)} ${dim(`(${selectedPersona.id})`)}`);
        }
        if (cfg.rag?.enabled) {
          lines.push(
            `    ${muted('RAG'.padEnd(20))} ${accent(cfg.rag.preset || 'balanced')}${cfg.rag.includeGraphRag ? dim(' + graph') : ''}`,
          );
        }
        if (cfg.discovery?.enabled) {
          lines.push(
            `    ${muted('Discovery'.padEnd(20))} ${accent(cfg.discovery.recallProfile || 'aggressive')}`,
          );
        }
        if (Array.isArray(availablePersonas) && availablePersonas.length > 0) {
          lines.push(`    ${muted('Persona Registry'.padEnd(20))} ${dim(`${availablePersonas.length} available`)}`);
        }
      } catch {
        lines.push(`    ${wColor('Error reading agent.config.json')}`);
      }
    } else {
      lines.push(`    ${muted('No agent.config.json in current directory')}`);
    }
    if (config.llmProvider) lines.push(`    ${muted('LLM Provider'.padEnd(20))} ${config.llmProvider}`);
    if (config.llmModel) lines.push(`    ${muted('LLM Model'.padEnd(20))} ${config.llmModel}`);
    if (config.personalityEnabled === false) {
      lines.push(`    ${muted('Personality'.padEnd(20))} ${wColor('disabled')}`);
    } else {
      // Resolve HEXACO traits: local config > preset > default
      let traits: HEXACOTraits | undefined;
      let presetLabel: string | undefined;

      // Try resolved local agent.config.json personality object first
      if (resolvedAgentConfig?.personality) {
        traits = {
          honesty_humility: resolvedAgentConfig.personality.honesty ?? resolvedAgentConfig.personality.honesty_humility ?? 0.5,
          emotionality: resolvedAgentConfig.personality.emotionality ?? 0.5,
          extraversion: resolvedAgentConfig.personality.extraversion ?? 0.5,
          agreeableness: resolvedAgentConfig.personality.agreeableness ?? 0.5,
          conscientiousness: resolvedAgentConfig.personality.conscientiousness ?? 0.5,
          openness: resolvedAgentConfig.personality.openness ?? 0.5,
        };
      }

      // Fall back to global config preset or custom values
      if (!traits && config.personalityPreset) {
        const presetMeta = PERSONALITY_PRESETS.find((p) => p.id === config.personalityPreset);
        presetLabel = presetMeta?.label ?? config.personalityPreset;

        if (config.personalityPreset === 'custom' && config.customHexaco) {
          traits = { ...DEFAULT_HEXACO_TRAITS, ...config.customHexaco } as HEXACOTraits;
        } else {
          const presetKey = config.personalityPreset as keyof typeof HEXACO_PRESETS;
          if (HEXACO_PRESETS[presetKey]) {
            traits = HEXACO_PRESETS[presetKey];
          }
        }
      }

      if (presetLabel || config.personalityPreset) {
        lines.push(`    ${muted('Personality'.padEnd(20))} ${accent(presetLabel || config.personalityPreset!)}`);
      }
      if (config.personalityEvolution) {
        lines.push(`    ${muted('Evolution'.padEnd(20))} ${sColor('enabled')}`);
      }

      // Render HEXACO bar chart
      if (traits) {
        lines.push('');
        lines.push(`  ${iColor(g.bulletHollow)} ${bright('HEXACO Profile')}`);
        const traitDefs = [
          { key: 'honesty_humility',  label: 'Honesty' },
          { key: 'emotionality',      label: 'Emotion' },
          { key: 'extraversion',      label: 'Extravert' },
          { key: 'agreeableness',     label: 'Agreeable' },
          { key: 'conscientiousness', label: 'Conscient' },
          { key: 'openness',          label: 'Openness' },
        ] as const;

        const barWidth = 10;
        const fillChar = ui.ascii ? '#' : '\u2588'; // █
        const emptyChar = ui.ascii ? '.' : '\u2591'; // ░

        for (const td of traitDefs) {
          const val = traits[td.key];
          const filled = Math.round(val * barWidth);
          const bar = accent(fillChar.repeat(filled)) + muted(emptyChar.repeat(barWidth - filled));
          const pct = dim(` ${(val * 100).toFixed(0).padStart(3)}%`);
          lines.push(`    ${muted(td.label.padEnd(12))} ${bar}${pct}`);
        }
      }
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

    // HITL & Approval section
    lines.push('');
    lines.push(`  ${iColor(g.bulletHollow)} ${bright('HITL & Approvals')}`);
    const hitlCfg = resolvedAgentConfig?.hitl as Record<string, unknown> | undefined;
    const hitlMode = (() => {
      if (hitlCfg?.mode === 'llm-judge') return 'llm-judge';
      if (hitlCfg?.mode === 'auto-approve') return 'auto-approve';
      return 'human';
    })();
    const hitlModeColor = hitlMode === 'human' ? sColor(hitlMode)
      : hitlMode === 'llm-judge' ? iColor(hitlMode)
      : wColor(hitlMode);
    lines.push(`    ${muted('HITL Mode'.padEnd(20))} ${hitlModeColor}`);
    const guardrailOverride = hitlCfg?.guardrailOverride !== false;
    lines.push(
      `    ${muted('Guardrail Override'.padEnd(20))} ${guardrailOverride ? sColor('enabled') : wColor('disabled')}`,
    );
    const postApprovalGuardrails = (hitlCfg?.postApprovalGuardrails as string[] | undefined)
      ?? ['code-safety', 'pii-redaction'];
    lines.push(
      `    ${muted('Post-approval'.padEnd(20))} ${dim(postApprovalGuardrails.join(', '))}`,
    );

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
