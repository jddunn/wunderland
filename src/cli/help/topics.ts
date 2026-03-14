/**
 * @fileoverview `wunderland help <topic>` content.
 * @module wunderland/cli/help/topics
 */

import chalk from 'chalk';
import { URLS } from '../constants.js';
import { accent, bright, dim, info as iColor, muted, success as sColor, warn as wColor } from '../ui/theme.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';

export type HelpTopicId =
  | 'getting-started'
  | 'auth'
  | 'tui'
  | 'voice'
  | 'ui'
  | 'presets'
  | 'security'
  | 'export'
  | 'faq'
  | 'llm';

export const HELP_TOPICS: Array<{ id: HelpTopicId; title: string; summary: string }> = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    summary: 'First-run onboarding: setup, doctor, chat, start.',
  },
  {
    id: 'auth',
    title: 'Authentication & OAuth',
    summary: 'OAuth login, API keys, and subscription auth.',
  },
  {
    id: 'tui',
    title: 'TUI Dashboard',
    summary: 'Keyboard-driven dashboard (search, drilldowns, tour).',
  },
  {
    id: 'voice',
    title: 'Voice & Speech',
    summary: 'Speech runtime, TTS/STT providers, and voice dashboard usage.',
  },
  {
    id: 'ui',
    title: 'UI / Themes',
    summary: 'Theme, color, and ASCII fallback options.',
  },
  {
    id: 'presets',
    title: 'Presets',
    summary: 'Quickly scaffold agents with personality + security defaults.',
  },
  {
    id: 'security',
    title: 'Security & Approvals',
    summary: 'Execution modes, tool permissions, and safe defaults.',
  },
  {
    id: 'export',
    title: 'Export (PNG)',
    summary: 'Export command output as a styled terminal screenshot.',
  },
  {
    id: 'llm',
    title: 'LLM Providers',
    summary: 'Configure OpenAI, Anthropic, Gemini, Ollama, or OpenRouter.',
  },
  {
    id: 'faq',
    title: 'FAQ',
    summary: 'Frequently asked questions about setup, voice, LLMs, and more.',
  },
];

function hr(): string {
  const g = glyphs();
  return dim(g.hr.repeat(56));
}

function printTitle(title: string): void {
  const g = glyphs();
  console.log();
  console.log(`  ${accent(g.bullet)} ${bright(title)}`);
  console.log(`  ${dim(URLS.website)}${dim(`  ${g.dot}  `)}${dim(URLS.docs)}`);
  console.log();
}

export function printHelpTopic(topicRaw: string): void {
  const g = glyphs();
  const ui = getUiRuntime();
  const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
  const enter = ui.ascii ? 'Enter' : '⏎';

  const topic = String(topicRaw || '').trim().toLowerCase();

  const resolved: HelpTopicId | null = (() => {
    if (topic === 'getting-started' || topic === 'gettingstarted' || topic === 'quickstart') return 'getting-started';
    if (topic === 'auth' || topic === 'login' || topic === 'oauth' || topic === 'subscription') return 'auth';
    if (topic === 'tui' || topic === 'dashboard') return 'tui';
    if (topic === 'voice' || topic === 'speech' || topic === 'stt' || topic === 'tts') return 'voice';
    if (topic === 'ui' || topic === 'theme' || topic === 'themes' || topic === 'style' || topic === 'ascii') return 'ui';
    if (topic === 'presets' || topic === 'preset') return 'presets';
    if (topic === 'security' || topic === 'approvals' || topic === 'hitl') return 'security';
    if (topic === 'export' || topic === 'png' || topic === 'screenshot') return 'export';
    if (topic === 'llm' || topic === 'llms' || topic === 'providers' || topic === 'provider' || topic === 'models' || topic === 'model' || topic === 'ollama' || topic === 'openai' || topic === 'anthropic' || topic === 'gemini' || topic === 'openrouter') return 'llm';
    if (topic === 'faq' || topic === 'faqs' || topic === 'questions') return 'faq';
    return null;
  })();

  if (!resolved) {
    console.log();
    console.log(`  ${wColor(g.warn)} ${bright('Unknown help topic')} ${muted(topicRaw)}`);
    console.log(`  ${dim('Try:')} ${accent('wunderland help getting-started')}${dim(', ')}${accent('wunderland help voice')}${dim(', ')}${accent('wunderland help llm')}${dim(', ')}${accent('wunderland help faq')}`);
    console.log();
    return;
  }

  if (resolved === 'getting-started') {
    printTitle('Getting Started');
    console.log(`  ${iColor('0')} ${bright('Open the dashboard (recommended)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland')}`);
    console.log(`     ${dim('Interactive TUI: search, drilldowns, and quick actions.')}`);
    console.log(`     ${dim('First run: a short onboarding tour appears (skip/disable, reopen with "t").')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Run setup (recommended)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland setup')}`);
    console.log(`     ${dim('Interactive wizard: LLM provider, personality, channels, RAG memory, and voice/TTS/STT.')}`);
    console.log();
    console.log(`     ${dim('Or: Log in with your ChatGPT subscription (no API key needed):')}`);
    console.log(`     ${muted('$')} ${accent('wunderland login')}`);
    console.log(`     ${dim('See:')} ${accent('wunderland help auth')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Verify your environment')}`);
    console.log(`     ${muted('$')} ${accent('wunderland doctor')}`);
    console.log(`     ${dim('Checks config, keys, and connectivity.')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Chat locally (interactive)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland chat')}`);
    console.log(`     ${dim('Tool calling + approvals. Type /help inside chat.')}`);
    console.log();
    console.log(`  ${iColor('4')} ${bright('Start the server')}`);
    console.log(`     ${muted('$')} ${accent('wunderland start')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('Prefer scaffolding a project?')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --preset research-assistant')}`);
    console.log();
    return;
  }

  if (resolved === 'auth') {
    printTitle('Authentication & OAuth');
    console.log(`  ${bright('Use your ChatGPT subscription instead of an API key.')}`);
    console.log(`  ${dim('OAuth uses the same device code flow as the Codex CLI.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Log in')}`);
    console.log(`     ${muted('$')} ${accent('wunderland login')}`);
    console.log(`     ${dim('Opens platform.openai.com/device — enter the displayed code.')}`);
    console.log(`     ${dim('Tokens are stored at ~/.wunderland/auth/openai.json (auto-refresh).')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Check status')}`);
    console.log(`     ${muted('$')} ${accent('wunderland auth-status')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Log out')}`);
    console.log(`     ${muted('$')} ${accent('wunderland logout')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Using OAuth with chat/start:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland chat --oauth')}`);
    console.log(`     ${dim('Or set in agent.config.json:')} ${accent('"llmAuthMethod": "oauth"')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Plans with included API credits:')}`);
    console.log(`     ${dim('ChatGPT Plus')}   $20/mo   → $5/mo API credits`);
    console.log(`     ${dim('ChatGPT Pro')}    $200/mo  → $50/mo API credits + unlimited Codex`);
    console.log(`     ${dim('ChatGPT Team')}   $25-30/seat/mo → shared API credit pool`);
    console.log();
    console.log(`  ${dim('Only OpenAI offers consumer OAuth. Anthropic/Google require API keys.')}`);
    console.log(`  ${dim('Full guide:')} ${accent(`${URLS.docs}/guides/openai-oauth`)}`);
    console.log();
    return;
  }

  if (resolved === 'tui') {
    printTitle('TUI Dashboard');
    console.log(`  ${dim('Run with no args in a TTY:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland')}`);
    console.log();
    console.log(`  ${dim('Navigation:')}`);
    console.log(`     ${accent(upDown)} move   ${accent(enter)} select   ${accent('/')} search   ${accent('?')} help   ${accent('t')} tour`);
    console.log(`     ${accent('esc')} close/back   ${accent('q')} quit   ${accent('r')} refresh`);
    console.log();
    console.log(`  ${dim('Drilldowns:')}`);
    console.log(`     ${accent('/')} search lists   ${accent(enter)} details modal   ${accent('?')} help modal`);
    console.log();
    console.log(`  ${dim('Tip:')} Use ${accent('/')} to filter commands like a command palette.`);
    console.log();
    return;
  }

  if (resolved === 'voice') {
    printTitle('Voice & Speech');
    console.log(`  ${bright('Wunderland supports TTS (text-to-speech) and STT (speech-to-text) out of the box.')}`);
    console.log(`  ${dim('Voice is configured during')} ${accent('wunderland setup')} ${dim('(both QuickStart and Advanced modes).')}`);
    console.log();
    console.log(`  ${bright('Supported TTS Providers:')}`);
    console.log(`     ${accent('OpenAI TTS')}      ${dim('tts-1 / tts-1-hd / gpt-4o-mini-tts — 6 voices (nova, alloy, echo, onyx, fable, shimmer)')}`);
    console.log(`     ${accent('ElevenLabs')}      ${dim('turbo v2.5 / multilingual v2 — voice cloning, 29 languages')}`);
    console.log(`     ${accent('Piper')}           ${dim('free, offline, ONNX models — no API key required')}`);
    console.log();
    console.log(`  ${bright('Supported STT Providers:')}`);
    console.log(`     ${accent('OpenAI Whisper')}   ${dim('whisper-1 — batch transcription, word timestamps')}`);
    console.log(`     ${accent('Deepgram')}         ${dim('nova-2 — real-time streaming, punctuation')}`);
    console.log(`     ${accent('Whisper.cpp')}      ${dim('free, offline — base/small/medium/large-v3 models')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Quick Setup:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland setup')}              ${dim('voice is included in both QuickStart and Advanced')}`);
    console.log(`     ${dim('If you already set OPENAI_API_KEY for your LLM, voice auto-detects it — zero extra config.')}`);
    console.log();
    console.log(`  ${bright('CLI Commands:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland voice status')}       ${dim('check provider readiness')}`);
    console.log(`     ${muted('$')} ${accent('wunderland voice tts')}          ${dim('list TTS providers')}`);
    console.log(`     ${muted('$')} ${accent('wunderland voice stt')}          ${dim('list STT providers')}`);
    console.log(`     ${muted('$')} ${accent('wunderland voice test "Hello"')} ${dim('synthesize a test phrase')}`);
    console.log(`     ${muted('$')} ${accent('wunderland voice clone')}        ${dim('voice cloning guidance (ElevenLabs)')}`);
    console.log();
    console.log(`  ${bright('TUI Dashboard:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland')} ${dim('then press')} ${accent('v')}  ${dim('shows telephony, STT, and TTS providers')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Environment Variables:')}`);
    console.log(`     ${accent('OPENAI_API_KEY')}           ${dim('OpenAI TTS + Whisper STT')}`);
    console.log(`     ${accent('ELEVENLABS_API_KEY')}       ${dim('ElevenLabs TTS')}`);
    console.log(`     ${accent('DEEPGRAM_API_KEY')}         ${dim('Deepgram STT')}`);
    console.log(`     ${accent('OPENAI_TTS_DEFAULT_MODEL')} ${dim('override TTS model (tts-1, tts-1-hd, gpt-4o-mini-tts)')}`);
    console.log(`     ${accent('WHISPER_MODEL_DEFAULT')}    ${dim('override Whisper model size (base, small, medium, large-v3)')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('Config file:')} ${accent('~/.wunderland/config.json')} ${dim('→ voiceProvider, voiceModel, voiceVoice, sttProvider, sttModel')}`);
    console.log(`  ${dim('Reconfigure:')} ${accent('wunderland setup')} ${dim('or edit config directly with')} ${accent('wunderland config set voiceProvider openai')}`);
    console.log();
    return;
  }

  if (resolved === 'ui') {
    printTitle('UI / Themes');
    console.log(`  ${dim('Defaults:')} ${bright('cyberpunk')} theme (full color), with auto ASCII fallback in limited terminals.`);
    console.log();
    console.log(`  ${dim('Theme:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland --theme cyberpunk')}`);
    console.log(`     ${muted('$')} ${accent('wunderland --theme plain')}`);
    console.log();
    console.log(`  ${dim('ASCII-only UI:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland --ascii')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set ui.ascii true')}`);
    console.log();
    console.log(`  ${dim('Persist theme:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set ui.theme cyberpunk')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set ui.theme plain')}`);
    console.log();
    console.log(`  ${dim('Notes:')}`);
    console.log(`   - ${accent('--no-color')} also disables colors (or set ${accent('NO_COLOR=1')}).`);
    console.log(`   - Tour is always available inside the dashboard: press ${accent('t')}.`);
    console.log(`   - Reset tour auto-launch: ${accent('wunderland config set ui.tour.status unseen')}`);
    console.log(`   - Disable tour auto-launch: ${accent('wunderland config set ui.tour.status never')}`);
    console.log();
    return;
  }

  if (resolved === 'presets') {
    printTitle('Presets');
    console.log(`  Presets are the fastest way to scaffold a coherent agent.`);
    console.log(`  They bundle personality (HEXACO), security tier, and suggested skills/channels.`);
    console.log();
    console.log(`  ${dim('List presets:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland list-presets')}`);
    console.log();
    console.log(`  ${dim('Scaffold a project with a preset:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --preset research-assistant')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --preset customer-support')}`);
    console.log();
    console.log(`  ${dim('Override security tier:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --security-tier strict')}`);
    console.log();
    return;
  }

  if (resolved === 'security') {
    printTitle('Security & Approvals');
    console.log(`  Wunderland is safe-by-default: side-effect tools require approval unless you opt in.`);
    console.log();
    console.log(`  ${dim('Modes:')}`);
    console.log(`     ${bright('deny-side-effects')}  ${dim('default for library API')}`);
    console.log(`     ${bright('auto-all')}          ${dim('fully autonomous (dangerous)')}`);
    console.log(`     ${bright('custom')}            ${dim('your app decides per request')}`);
    console.log();
    console.log(`  ${dim('CLI shortcuts:')}`);
    console.log(`     ${accent('--overdrive')} ${dim('auto-approve all tool calls (keeps security pipeline active)')}`);
    console.log(`     ${accent('--auto-approve-tools')} ${dim('fully autonomous tool calls (CI / demos)')}`);
    console.log(`     ${accent('--yes')} ${dim('auto-confirm prompts (setup/init); does NOT auto-approve tools')}`);
    console.log(`     ${accent('--dangerously-skip-permissions')} ${dim('skip permission checks')}`);
    console.log(`     ${accent('--dangerously-skip-command-safety')} ${dim('disable shell safety checks')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('See also:')} ${accent(URLS.docs)}`);
    console.log();
    return;
  }

  if (resolved === 'llm') {
    printTitle('LLM Providers');
    console.log(`  ${bright('Wunderland supports 5 LLM providers out of the box:')}`);
    console.log();
    console.log(`     ${accent('openai')}       ${dim('GPT-4o, GPT-4o-mini, o1, o3-mini')}`);
    console.log(`     ${accent('anthropic')}    ${dim('Claude Opus 4, Sonnet 4, Haiku 3.5')}`);
    console.log(`     ${accent('gemini')}       ${dim('Gemini 2.0 Flash, 2.5 Pro, 2.5 Flash')}`);
    console.log(`     ${accent('ollama')}       ${dim('Local models — Llama 3, Dolphin, Mixtral (free, private)')}`);
    console.log(`     ${accent('openrouter')}   ${dim('200+ models, automatic fallback, single API key')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Setup:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland setup')}                              ${dim('interactive wizard')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --provider openai')}    ${dim('scaffold with a specific provider')}`);
    console.log(`     ${muted('$')} ${accent('wunderland ollama-setup')}                       ${dim('auto-detect hardware, pull models')}`);
    console.log();
    console.log(`  ${bright('Environment Variables:')}`);
    console.log(`     ${accent('OPENAI_API_KEY')}       ${dim('sk-...')}`);
    console.log(`     ${accent('ANTHROPIC_API_KEY')}    ${dim('sk-ant-...')}`);
    console.log(`     ${accent('GEMINI_API_KEY')}       ${dim('AIza...')}`);
    console.log(`     ${accent('OPENROUTER_API_KEY')}   ${dim('sk-or-... (also used as automatic fallback)')}`);
    console.log(`     ${accent('OLLAMA_BASE_URL')}      ${dim('http://localhost:11434 (or remote URL)')}`);
    console.log();
    console.log(`  ${bright('Switch provider:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set llmProvider anthropic')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set llmModel claude-sonnet-4-6')}`);
    console.log();
    console.log(`  ${bright('OAuth (ChatGPT subscription):')}`);
    console.log(`     ${muted('$')} ${accent('wunderland login')}   ${dim('use ChatGPT Plus/Pro credits — no API key needed')}`);
    console.log(`     ${dim('See:')} ${accent('wunderland help auth')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('Config file:')} ${accent('~/.wunderland/config.json')} ${dim('→ llmProvider, llmModel')}`);
    console.log(`  ${dim('Per-agent:')} ${accent('agent.config.json')} ${dim('→ overrides global config')}`);
    console.log(`  ${dim('Full docs:')} ${accent(`${URLS.docs}/guides/llm-providers`)}`);
    console.log();
    return;
  }

  if (resolved === 'faq') {
    printTitle('Frequently Asked Questions');
    console.log();

    console.log(`  ${bright('Q: How do I change my LLM provider after setup?')}`);
    console.log(`  ${dim('A:')} ${accent('wunderland config set llmProvider <provider>')} ${dim('where provider is openai/anthropic/gemini/ollama/openrouter.')}`);
    console.log(`     ${dim('Or re-run')} ${accent('wunderland setup')} ${dim('to go through the wizard again.')}`);
    console.log();

    console.log(`  ${bright('Q: Do I need separate API keys for voice/TTS?')}`);
    console.log(`  ${dim('A: If you use OpenAI as your LLM, the same OPENAI_API_KEY covers TTS and Whisper STT — no extra key needed.')}`);
    console.log(`     ${dim('ElevenLabs and Deepgram require their own keys. Piper and Whisper.cpp are free and local.')}`);
    console.log();

    console.log(`  ${bright('Q: Can I run fully offline / without cloud APIs?')}`);
    console.log(`  ${dim('A: Yes — use')} ${accent('ollama')} ${dim('for LLM +')} ${accent('piper')} ${dim('for TTS +')} ${accent('whisper.cpp')} ${dim('for STT. Run')} ${accent('wunderland ollama-setup')} ${dim('to get started.')}`);
    console.log();

    console.log(`  ${bright('Q: How do I add voice to an existing agent?')}`);
    console.log(`  ${dim('A: Re-run')} ${accent('wunderland setup')} ${dim('and configure voice, or set config directly:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set voiceProvider openai')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set voiceModel tts-1')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set sttProvider openai-whisper')}`);
    console.log();

    console.log(`  ${bright('Q: What\'s the difference between QuickStart and Advanced setup?')}`);
    console.log(`  ${dim('A: QuickStart covers: LLM provider, personality preset, channels, RAG memory, and voice (5 steps).')}`);
    console.log(`     ${dim('Advanced adds: custom HEXACO sliders, extensions/skills, security pipeline, and full TTS/STT customization.')}`);
    console.log();

    console.log(`  ${bright('Q: How do I use OpenRouter as a fallback?')}`);
    console.log(`  ${dim('A: Set')} ${accent('OPENROUTER_API_KEY')} ${dim('alongside your primary provider key. If the primary fails, OpenRouter retries automatically.')}`);
    console.log();

    console.log(`  ${bright('Q: Where are my credentials stored?')}`);
    console.log(`  ${dim('A:')} ${accent('~/.wunderland/.env')} ${dim('(API keys, chmod 600) and')} ${accent('~/.wunderland/config.json')} ${dim('(settings).')}`);
    console.log();

    console.log(`  ${bright('Q: How do I check if everything is working?')}`);
    console.log(`  ${dim('A:')} ${accent('wunderland doctor')} ${dim('verifies config, API keys, provider connectivity, and voice readiness.')}`);
    console.log();

    console.log(`  ${bright('Q: Can I use my ChatGPT subscription instead of an API key?')}`);
    console.log(`  ${dim('A: Yes — run')} ${accent('wunderland login')} ${dim('to authenticate with OAuth. See')} ${accent('wunderland help auth')} ${dim('for details.')}`);
    console.log();

    console.log(`  ${hr()}`);
    console.log(`  ${dim('More help:')} ${accent('wunderland help <topic>')} ${dim('— topics: getting-started, auth, voice, llm, presets, security, tui, ui, export')}`);
    console.log(`  ${dim('Full docs:')} ${accent(URLS.docs)}`);
    console.log();
    return;
  }

  // export
  printTitle('Export (PNG)');
  console.log(`  Export non-interactive command output as a styled PNG:`);
  console.log();
  console.log(`     ${muted('$')} ${accent('wunderland doctor --export-png doctor.png')}`);
  console.log(`     ${muted('$')} ${accent('wunderland --help --export-png help.png')}`);
  console.log();
  console.log(`  ${dim('Notes:')}`);
  console.log(`   - Interactive commands like ${bright('chat')} are not exportable.`);
  console.log(`   - Export forces truecolor ANSI for pixel-accurate screenshots.`);
  console.log();
  console.log(`  ${sColor(g.ok)} ${dim('Saved next to the path you specify.')}`);
  console.log();
}

export function printHelpTopicsList(): void {
  console.log();
  console.log(`  ${accent('Topics:')}`);
  for (const t of HELP_TOPICS) {
    console.log(`    ${chalk.white(t.id.padEnd(16))} ${dim(t.summary)}`);
  }
  console.log();
  console.log(`  ${dim('Try:')} ${accent('wunderland help getting-started')}${dim(', ')}${accent('wunderland help voice')}${dim(', ')}${accent('wunderland help llm')}${dim(', ')}${accent('wunderland help faq')}`);
  console.log();
}
