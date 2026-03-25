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
  | 'workflows'
  | 'missions'
  | 'agent-graph'
  | 'streaming'
  | 'checkpoints'
  | 'voice'
  | 'ui'
  | 'presets'
  | 'security'
  | 'export'
  | 'faq'
  | 'llm'
  | 'email'
  | 'whatsapp'
  | 'slack'
  | 'signal'
  | 'emergent';

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
    id: 'workflows',
    title: 'Workflows & Graphs',
    summary: 'How to author deterministic workflows, graphs, missions, and judge nodes.',
  },
  {
    id: 'missions',
    title: 'Missions (Intent-Driven)',
    summary: 'Goal-driven planner orchestration: run, explain, and author mission YAML files.',
  },
  {
    id: 'agent-graph',
    title: 'AgentGraph API',
    summary: 'TypeScript AgentGraph for loops, conditional routing, and custom control flow.',
  },
  {
    id: 'streaming',
    title: 'Session Streaming',
    summary: 'stream() async iterator: text_delta, node_end, run_end event types.',
  },
  {
    id: 'checkpoints',
    title: 'Checkpoints & Resume',
    summary: 'Save and restore session state mid-conversation with checkpoint() / resume().',
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
    id: 'email',
    title: 'Email Intelligence',
    summary: 'Gmail virtual assistant: sync, search, projects, reports.',
  },
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    summary: 'Connect your Wunderbot to WhatsApp via Twilio or Meta Cloud API.',
  },
  {
    id: 'slack',
    title: 'Slack',
    summary: 'Connect your Wunderbot to a Slack workspace via OAuth.',
  },
  {
    id: 'signal',
    title: 'Signal',
    summary: 'Connect your Wunderbot to Signal via signal-cli daemon.',
  },
  {
    id: 'emergent',
    title: 'Emergent Tools',
    summary: 'Runtime tool forging: lifecycle, safety, LLM-as-judge, and CLI commands.',
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
    if (topic === 'workflows' || topic === 'workflow' || topic === 'orchestration') return 'workflows';
    if (topic === 'missions' || topic === 'mission' || topic === 'planner' || topic === 'intent') return 'missions';
    if (topic === 'agent-graph' || topic === 'agentgraph' || topic === 'graph' || topic === 'graphs') return 'agent-graph';
    if (topic === 'streaming' || topic === 'stream' || topic === 'events') return 'streaming';
    if (topic === 'checkpoints' || topic === 'checkpoint' || topic === 'resume' || topic === 'rollback') return 'checkpoints';
    if (topic === 'voice' || topic === 'speech' || topic === 'stt' || topic === 'tts') return 'voice';
    if (topic === 'ui' || topic === 'theme' || topic === 'themes' || topic === 'style' || topic === 'ascii') return 'ui';
    if (topic === 'presets' || topic === 'preset') return 'presets';
    if (topic === 'security' || topic === 'approvals' || topic === 'hitl') return 'security';
    if (topic === 'export' || topic === 'png' || topic === 'screenshot') return 'export';
    if (topic === 'llm' || topic === 'llms' || topic === 'providers' || topic === 'provider' || topic === 'models' || topic === 'model' || topic === 'ollama' || topic === 'openai' || topic === 'anthropic' || topic === 'gemini' || topic === 'openrouter') return 'llm';
    if (topic === 'email' || topic === 'gmail' || topic === 'mail') return 'email';
    if (topic === 'whatsapp' || topic === 'wa') return 'whatsapp';
    if (topic === 'slack') return 'slack';
    if (topic === 'signal') return 'signal';
    if (topic === 'emergent' || topic === 'emergent-tools' || topic === 'forge' || topic === 'forged-tools') return 'emergent';
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
    console.log(`  ${iColor('0')} ${bright('Use the one-shot quickstart if you want the fastest path')}`);
    console.log(`     ${muted('$')} ${accent('wunderland quickstart')}`);
    console.log(`     ${dim('Auto-detects your environment, scaffolds config, and gets you to a runnable agent fast.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Open the dashboard (recommended)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland')}`);
    console.log(`     ${dim('Interactive TUI: search, drilldowns, and quick actions.')}`);
    console.log(`     ${dim('First run: a short onboarding tour appears (skip/disable, reopen with "t").')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Run setup (recommended)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland setup')}`);
    console.log(`     ${dim('Interactive wizard: LLM provider, personality, channels, RAG memory, and voice/TTS/STT.')}`);
    console.log();
    console.log(`     ${dim('Or: Log in with your ChatGPT subscription (no API key needed):')}`);
    console.log(`     ${muted('$')} ${accent('wunderland login')}`);
    console.log(`     ${dim('See:')} ${accent('wunderland help auth')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Verify your environment')}`);
    console.log(`     ${muted('$')} ${accent('wunderland doctor')}`);
    console.log(`     ${dim('Checks config, keys, and connectivity.')}`);
    console.log();
    console.log(`  ${iColor('4')} ${bright('Chat locally (interactive)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland chat')}`);
    console.log(`     ${dim('Tool calling + approvals. Type /help inside chat.')}`);
    console.log();
    console.log(`  ${iColor('5')} ${bright('Configure provider defaults when you need shared image/voice/search preferences')}`);
    console.log(`     ${muted('$')} ${accent('wunderland extensions configure')}`);
    console.log(`     ${dim('Set global defaults for image generation, TTS, STT, and web search.')}`);
    console.log(`     ${dim('Inspect a specific extension:')} ${accent('wunderland extensions info image-generation')}`);
    console.log();
    console.log(`  ${iColor('6')} ${bright('Start the server')}`);
    console.log(`     ${muted('$')} ${accent('wunderland start')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('Need short operator guides?')}`);
    console.log(`     ${muted('$')} ${accent('wunderland help getting-started')}`);
    console.log(`     ${muted('$')} ${accent('wunderland help workflows')}`);
    console.log(`     ${muted('$')} ${accent('wunderland help tui')}`);
    console.log(`     ${muted('$')} ${accent('wunderland help faq')}`);
    console.log();
    console.log(`  ${dim('Prefer scaffolding a project?')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --preset research-assistant')}`);
    console.log();
    return;
  }

  if (resolved === 'workflows') {
    printTitle('Workflows & Graphs');
    console.log(`  ${bright('Author with the AgentOS orchestration builders, execute through Wunderland.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Choose the right authoring style')}`);
    console.log(`     ${accent('workflow()')} ${dim('for deterministic DAGs and explicit step order')}`);
    console.log(`     ${accent('AgentGraph')} ${dim('for loops, routers, and custom control flow')}`);
    console.log(`     ${accent('mission()')} ${dim('for goal-driven planning that compiles to the same graph IR')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Keep definitions in predictable places')}`);
    console.log(`     ${dim('./workflows/')} ${dim('deterministic workflow definitions')}`);
    console.log(`     ${dim('./missions/')} ${dim('goal-driven orchestration definitions')}`);
    console.log(`     ${dim('./orchestration/')} ${dim('shared routers, judges, and reusable graph helpers')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Import the builders from Wunderland')}`);
    console.log(`     ${muted('$')} ${accent(`import { workflow, mission, AgentGraph } from 'wunderland/workflows';`)}`);
    console.log(`     ${muted('$')} ${accent(`import { createWunderland } from 'wunderland';`)}`);
    console.log(`     ${dim('Compile with the builder, then execute through')} ${accent('app.runGraph(...)')}${dim(' or ')}${accent('app.streamGraph(...)')}`);
    console.log();
    console.log(`  ${iColor('4')} ${bright('Use judge nodes for scoring, not raw hidden chain-of-thought')}`);
    console.log(`     ${dim('Have the judge node return structured JSON like:')}`);
    console.log(`     ${accent('{"scratch":{"judge":{"score":8,"verdict":"ship","reasoning":"..."}}}')}`);
    console.log(`     ${dim('Then branch on')} ${accent("state.scratch.judge?.score")}${dim(' or ')}${accent("state.scratch.judge?.verdict")}`);
    console.log(`     ${dim('Prefer concise rationale fields over asking the model to reveal private internal reasoning.')}`);
    console.log();
    console.log(`  ${iColor('5')} ${bright('Examples')}`);
    console.log(`     ${muted('$')} ${accent('wunderland workflows list')}`);
    console.log(`     ${muted('$')} ${accent('wunderland workflows examples')}`);
    console.log(`     ${dim('Bundled examples live under')} ${accent('packages/wunderland/examples/')}`);
    console.log();
    return;
  }

  if (resolved === 'missions') {
    printTitle('Missions (Intent-Driven Orchestration)');
    console.log(`  ${bright('Missions describe a goal in natural language; a planner decomposes it into steps at runtime.')}`);
    console.log(`  ${dim('Missions compile to the same AgentGraph IR as workflow() — so Wunderland executes them identically.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Execute a mission YAML file')}`);
    console.log(`     ${muted('$')} ${accent('wunderland mission run examples/mission-deep-research.yaml --input topic="quantum computing"')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Explain a mission (dry-run planner decomposition)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland mission explain examples/mission-deep-research.yaml')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Author a mission YAML')}`);
    console.log(`     ${dim('Minimal structure:')}`);
    console.log(`     ${accent('name: deep-research')}`);
    console.log(`     ${accent('goal: "Research {topic} and produce a cited summary"')}`);
    console.log(`     ${accent('planner: { strategy: plan_and_execute, maxSteps: 5 }')}`);
    console.log();
    console.log(`  ${iColor('4')} ${bright('Use mission() in TypeScript')}`);
    console.log(`     ${muted('$')} ${accent(`import { mission } from 'wunderland/workflows';`)}`);
    console.log(`     ${muted('$')} ${accent(`const compiled = mission('deep-research').goal('Research ...').compile();`)}`);
    console.log(`     ${muted('$')} ${accent(`await app.runGraph(compiled, { topic: 'AI agents' });`)}`);
    console.log();
    console.log(`  ${dim('Bundled example:')} ${accent('examples/mission-deep-research.yaml')}`);
    console.log();
    return;
  }

  if (resolved === 'agent-graph') {
    printTitle('AgentGraph API');
    console.log(`  ${bright('AgentGraph gives you full control: loops, conditional edges, and multi-step routing.')}`);
    console.log(`  ${dim('Use AgentGraph when YAML workflows are insufficient — e.g. retry cycles or dynamic branching.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Import and build a graph')}`);
    console.log(`     ${muted('$')} ${accent(`import { AgentGraph } from 'wunderland/workflows';`)}`);
    console.log(`     ${dim('Add nodes with')} ${accent('.addNode(id, handler)')} ${dim('and edges with')} ${accent('.addEdge(from, to, condition?)')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Compile and execute through Wunderland')}`);
    console.log(`     ${muted('$')} ${accent('const compiled = graph.compile();')}`);
    console.log(`     ${muted('$')} ${accent('await app.runGraph(compiled, input);')}`);
    console.log(`     ${muted('$')} ${accent('await app.streamGraph(compiled, input);')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Cycles (not supported in workflow YAML)')}`);
    console.log(`     ${dim('Only AgentGraph supports cycles. Use a conditional edge back to an earlier node.')}`);
    console.log(`     ${dim('Guard all cycles with a counter or confidence threshold to prevent infinite loops.')}`);
    console.log();
    console.log(`  ${iColor('4')} ${bright('Judge nodes')}`);
    console.log(`     ${dim('Have the judge node return structured JSON:')}`);
    console.log(`     ${accent('{"scratch":{"judge":{"score":8,"verdict":"ship","reasoning":"..."}}}')}`);
    console.log(`     ${dim('Branch on')} ${accent("state.scratch.judge?.verdict")} ${dim('or')} ${accent("state.scratch.judge?.score")}`);
    console.log();
    console.log(`  ${dim('Bundled examples:')}`);
    console.log(`     ${accent('examples/graph-research-loop.ts')}  ${dim('— conditional retry cycle')}`);
    console.log(`     ${accent('examples/graph-judge-pipeline.ts')} ${dim('— LLM-as-judge evaluation')}`);
    console.log(`  ${dim('Full API reference:')} ${accent('docs/AGENT_GRAPH.md')}`);
    console.log();
    return;
  }

  if (resolved === 'streaming') {
    printTitle('Session Streaming');
    console.log(`  ${bright('session.stream(prompt) returns an async iterator of typed events.')}`);
    console.log(`  ${dim('Use this for real-time output in UIs, CLIs, or server-sent events.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Basic usage')}`);
    console.log(`     ${muted('$')} ${accent("for await (const event of session.stream('Hello')) {")}`);
    console.log(`     ${muted('$')} ${accent("  if (event.type === 'text_delta') process.stdout.write(event.content);")}`);
    console.log(`     ${muted('$')} ${accent('}')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Event types')}`);
    console.log(`     ${accent('run_start')}   ${dim('— emitted once when the turn begins')}`);
    console.log(`     ${accent('text_delta')}  ${dim('— partial text chunk (event.content: string)')}`);
    console.log(`     ${accent('node_end')}    ${dim('— node completion (event.durationMs: number)')}`);
    console.log(`     ${accent('run_end')}     ${dim('— turn complete (event.totalDurationMs: number)')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Stream a graph')}`);
    console.log(`     ${muted('$')} ${accent('await app.streamGraph(compiled, input);')}`);
    console.log(`     ${dim('Same event types, emitted per-node across the full graph execution.')}`);
    console.log();
    console.log(`  ${dim('Bundled example:')} ${accent('examples/session-streaming.ts')}`);
    console.log();
    return;
  }

  if (resolved === 'checkpoints') {
    printTitle('Checkpoints & Resume');
    console.log(`  ${bright('Checkpoints snapshot session state so you can roll back mid-conversation.')}`);
    console.log(`  ${dim('Useful for branching explorations, automated testing, and agentic retry logic.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Save a checkpoint')}`);
    console.log(`     ${muted('$')} ${accent('const cpId = await session.checkpoint();')}`);
    console.log(`     ${dim('Returns a string checkpoint ID. Store it to resume later.')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Resume from a checkpoint')}`);
    console.log(`     ${muted('$')} ${accent('await session.resume(cpId);')}`);
    console.log(`     ${dim('Rolls back messages and state to the point the checkpoint was saved.')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Typical pattern')}`);
    console.log(`     ${dim('1. Send initial turn → save checkpoint → continue conversation')}`);
    console.log(`     ${dim('2. If the agent goes off-track, resume from the checkpoint and retry')}`);
    console.log(`     ${dim('3. Use in test suites to branch from a known good state')}`);
    console.log();
    console.log(`  ${dim('Bundled example:')} ${accent('examples/checkpoint-resume.ts')}`);
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

  if (resolved === 'email') {
    printTitle('Email Intelligence — Gmail Virtual Assistant');
    console.log(`  ${dim('Connect your Gmail and get AI-powered email intelligence:')}`);
    console.log(`  ${dim('thread hierarchy, project detection, search, reports, and more.')}`);
    console.log();
    console.log(`  ${bright('Quick Start:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland connect gmail')}       ${dim('Connect your Gmail account (opens browser)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland chat')}                ${dim('Start chatting — ask about your emails')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('What You Can Do:')}`);
    console.log(`     ${dim(g.bullet)} ${dim('"What\'s happening with Project Alpha?"')} ${muted('— cross-thread project summaries')}`);
    console.log(`     ${dim(g.bullet)} ${dim('"Any new emails from Sarah?"')} ${muted('— filtered search')}`);
    console.log(`     ${dim(g.bullet)} ${dim('"Summarize the API redesign thread"')} ${muted('— thread summaries')}`);
    console.log(`     ${dim(g.bullet)} ${dim('"Export Project Alpha as PDF"')} ${muted('— generate reports')}`);
    console.log(`     ${dim(g.bullet)} ${accent('/email inbox')} ${muted('— see your inbox')}`);
    console.log(`     ${dim(g.bullet)} ${accent('/email projects')} ${muted('— see auto-detected projects')}`);
    console.log(`     ${dim(g.bullet)} ${accent('/email search <query>')} ${muted('— semantic search across all email')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Setup:')}`);
    console.log(`     ${iColor('1')} ${accent('wunderland connect gmail')}     ${dim('(one-time, opens browser OAuth)')}`);
    console.log(`     ${iColor('2')} ${dim('That\'s it — Gmail auto-syncs on next chat/start')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('CLI Commands:')}`);
    console.log(`     ${accent('/email inbox')}             ${dim('View inbox')}`);
    console.log(`     ${accent('/email projects')}          ${dim('View auto-detected projects')}`);
    console.log(`     ${accent('/email search <query>')}    ${dim('Semantic search')}`);
    console.log(`     ${accent('/email thread <id>')}       ${dim('Thread detail')}`);
    console.log(`     ${accent('/email report <project> <format>')} ${dim('Generate report (PDF/MD/JSON)')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Dashboard (Rabbithole):')}`);
    console.log(`     ${dim('Your Wunderbot dashboard at')} ${accent('/app/dashboard/[seedId]/email/')} ${dim('has:')}`);
    console.log(`     ${dim(g.bullet)} ${bright('Inbox tab')} ${dim('— thread-centric view with search')}`);
    console.log(`     ${dim(g.bullet)} ${bright('Projects tab')} ${dim('— auto-detected project groupings')}`);
    console.log(`     ${dim(g.bullet)} ${bright('Intelligence tab')} ${dim('— stats, stale threads, AI chat widget')}`);
    console.log(`     ${dim(g.bullet)} ${bright('Settings tab')} ${dim('— manage accounts, digests, SMTP')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Self-Hosted:')}`);
    console.log(`     ${accent('wunderland connect gmail')} ${dim('works everywhere. Uses browser OAuth')}`);
    console.log(`     ${dim('with PKCE — no API keys to configure manually.')}`);
    console.log();
    console.log(`  ${dim('Full guide:')} ${accent('docs/EMAIL_INTELLIGENCE.md')}`);
    console.log();
    return;
  }

  if (resolved === 'whatsapp') {
    printTitle('WhatsApp Integration');
    console.log(`  ${dim('Connect your Wunderbot to WhatsApp for chat-based interactions.')}`);
    console.log();
    console.log(`  ${bright('Quick Start:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland connect whatsapp')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Providers:')}`);
    console.log(`     ${accent('Twilio')}            ${dim('Paid, production-grade — reliable delivery, phone number provisioning')}`);
    console.log(`     ${accent('Meta Cloud API')}    ${dim('Free tier available — direct from Meta, requires app review for production')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Twilio Setup:')}`);
    console.log(`     ${iColor('1')} Create a Twilio account and get a WhatsApp-enabled number`);
    console.log(`     ${iColor('2')} Set environment variables:`);
    console.log(`        ${accent('TWILIO_ACCOUNT_SID')}     ${dim('your Twilio Account SID')}`);
    console.log(`        ${accent('TWILIO_AUTH_TOKEN')}      ${dim('your Twilio Auth Token')}`);
    console.log(`        ${accent('TWILIO_WHATSAPP_FROM')}   ${dim('e.g. whatsapp:+14155238886')}`);
    console.log(`     ${iColor('3')} Configure the webhook URL in Twilio console`);
    console.log();
    console.log(`  ${bright('Meta Cloud API Setup:')}`);
    console.log(`     ${iColor('1')} Create an app at developers.facebook.com`);
    console.log(`     ${iColor('2')} Set environment variables:`);
    console.log(`        ${accent('META_WHATSAPP_TOKEN')}         ${dim('your permanent access token')}`);
    console.log(`        ${accent('META_WHATSAPP_PHONE_ID')}      ${dim('your phone number ID')}`);
    console.log(`        ${accent('META_WHATSAPP_VERIFY_TOKEN')}  ${dim('webhook verification token')}`);
    console.log(`     ${iColor('3')} Configure the webhook URL in Meta dashboard`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Webhook URL:')}`);
    console.log(`     ${accent('https://your-server/wunderland/channels/inbound/whatsapp/{seedId}')}`);
    console.log(`     ${dim('Chat commands work the same as other channels.')}`);
    console.log();
    console.log(`  ${dim('Full guide:')} ${accent('docs/CHANNEL_INTEGRATIONS.md')}`);
    console.log();
    return;
  }

  if (resolved === 'slack') {
    printTitle('Slack Integration');
    console.log(`  ${dim('Connect your Wunderbot to a Slack workspace.')}`);
    console.log();
    console.log(`  ${bright('Quick Start:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland connect slack')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('How It Works:')}`);
    console.log(`     ${dim('Routes through rabbithole.inc OAuth — no manual app creation needed.')}`);
    console.log(`     ${dim('The connect command opens your browser to authorize the Slack app.')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Auto-Reply Modes:')}`);
    console.log(`     ${accent('off')}          ${dim('Bot does not reply automatically')}`);
    console.log(`     ${accent('dm')}           ${dim('Reply only to direct messages')}`);
    console.log(`     ${accent('mentions')}     ${dim('Reply when @mentioned in channels')}`);
    console.log(`     ${accent('all')}          ${dim('Reply to every message in configured channels')}`);
    console.log();
    console.log(`  ${dim('Set mode:')} ${accent('wunderland config set slack.autoReply mentions')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Environment Variables (self-hosted):')}`);
    console.log(`     ${accent('SLACK_OAUTH_CLIENT_ID')}      ${dim('your Slack app client ID')}`);
    console.log(`     ${accent('SLACK_OAUTH_CLIENT_SECRET')}   ${dim('your Slack app client secret')}`);
    console.log(`     ${accent('SLACK_BOT_TOKEN')}             ${dim('xoxb-... bot token')}`);
    console.log();
    console.log(`  ${dim('Webhook is already configured via the Slack Events API — no manual URL setup.')}`);
    console.log();
    console.log(`  ${dim('Full guide:')} ${accent('docs/CHANNEL_INTEGRATIONS.md')}`);
    console.log();
    return;
  }

  if (resolved === 'signal') {
    printTitle('Signal Integration');
    console.log(`  ${dim('Connect your Wunderbot to Signal for private, encrypted messaging.')}`);
    console.log();
    console.log(`  ${bright('Quick Start:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland connect signal')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Prerequisites:')}`);
    console.log(`     ${dim('Requires')} ${accent('signal-cli')} ${dim('installed on your system.')}`);
    console.log(`     ${dim('Install:')} ${accent('brew install signal-cli')} ${dim('(macOS) or see github.com/AsamK/signal-cli')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Setup Wizard:')}`);
    console.log(`     ${iColor('1')} ${accent('wunderland connect signal')} ${dim('walks you through registration')}`);
    console.log(`     ${iColor('2')} Link or register a phone number with signal-cli`);
    console.log(`     ${iColor('3')} Verify via SMS or voice call`);
    console.log(`     ${iColor('4')} The daemon starts and listens for incoming messages`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${bright('Running the Daemon:')}`);
    console.log(`     ${dim('signal-cli runs as a JSON-RPC daemon. The webhook URL is:')}`);
    console.log(`     ${accent('http://localhost:{port}/wunderland/channels/inbound/signal/{seedId}')}`);
    console.log();
    console.log(`  ${dim('Full guide:')} ${accent('docs/CHANNEL_INTEGRATIONS.md')}`);
    console.log();
    return;
  }

  if (resolved === 'emergent') {
    printTitle('Emergent Tools — Runtime Tool Forging');
    console.log(`  ${bright('Agents can forge new tools at runtime — composed from existing tools or written as sandboxed code.')}`);
    console.log(`  ${dim('All forged tools pass through an LLM-as-judge gate before registration.')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('What emergent mode does')}`);
    console.log(`     ${dim('When enabled, agents can create new tools on the fly to solve problems')}`);
    console.log(`     ${dim('that existing tools cannot handle. Two creation modes:')}`);
    console.log(`     ${accent('compose')}   ${dim('Pipeline of existing tool calls with input/output mapping')}`);
    console.log(`     ${accent('sandbox')}   ${dim('Arbitrary code in a memory/time-bounded sandbox')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('How to enable')}`);
    console.log(`     ${dim('Set in your agent.config.json:')}`);
    console.log(`     ${accent('{ "emergent": true }')}`);
    console.log(`     ${dim('Or pass to the agent config programmatically:')}`);
    console.log(`     ${accent('emergentConfig: { enabled: true }')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Tool lifecycle: session -> agent -> shared')}`);
    console.log(`     ${accent('session')}   ${dim('Exists only for the current session; discarded on shutdown')}`);
    console.log(`     ${accent('agent')}     ${dim('Persisted for the agent that created it; not shared globally')}`);
    console.log(`     ${accent('shared')}    ${dim('Promoted to the shared registry; available to all agents')}`);
    console.log();
    console.log(`     ${dim('Promotion requires accumulated usage + passing confidence thresholds.')}`);
    console.log(`     ${dim('Shared promotion requires multi-reviewer sign-off (safety + correctness).')}`);
    console.log();
    console.log(`  ${iColor('4')} ${bright('Safety')}`);
    console.log(`     ${dim('Every forged tool passes through:')}`);
    console.log(`     ${sColor(g.ok)} ${dim('LLM-as-judge evaluation (safety, correctness, determinism, bounded execution)')}`);
    console.log(`     ${sColor(g.ok)} ${dim('Sandbox isolation with memory/time limits and API allowlists')}`);
    console.log(`     ${sColor(g.ok)} ${dim('Human-in-the-loop (HITL) confirmation for shared-tier promotion')}`);
    console.log(`     ${sColor(g.ok)} ${dim('Full audit trail with judge verdicts and promotion history')}`);
    console.log();
    console.log(`  ${iColor('5')} ${bright('CLI commands')}`);
    console.log(`     ${muted('$')} ${accent('wunderland emergent list')}               ${dim('List all emergent tools')}`);
    console.log(`     ${muted('$')} ${accent('wunderland emergent inspect <name>')}     ${dim('Full details + verdicts')}`);
    console.log(`     ${muted('$')} ${accent('wunderland emergent promote <name>')}     ${dim('Promote to shared tier')}`);
    console.log(`     ${muted('$')} ${accent('wunderland emergent demote <name>')}      ${dim('Deactivate a tool')}`);
    console.log(`     ${muted('$')} ${accent('wunderland emergent audit <name>')}       ${dim('View audit trail')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('Configuration:')}`);
    console.log(`     ${accent('maxSessionTools')}     ${dim('Max session-scoped tools per agent (default: 10)')}`);
    console.log(`     ${accent('maxAgentTools')}       ${dim('Max agent-scoped tools per agent (default: 50)')}`);
    console.log(`     ${accent('sandboxMemoryMB')}     ${dim('Sandbox memory limit (default: 128 MB)')}`);
    console.log(`     ${accent('sandboxTimeoutMs')}    ${dim('Sandbox time limit (default: 5000 ms)')}`);
    console.log(`     ${accent('judgeModel')}          ${dim('LLM model for forge-time evaluation (default: gpt-4o-mini)')}`);
    console.log(`     ${accent('promotionJudgeModel')} ${dim('LLM model for promotion reviews (default: gpt-4o)')}`);
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

    console.log(`  ${bright('Q: How do I change the default image generation provider?')}`);
    console.log(`  ${dim('A: Run')} ${accent('wunderland extensions configure')} ${dim('and choose OpenAI, OpenRouter, Stability AI, or Replicate.')}`);
    console.log(`     ${dim('Inspect current requirements with')} ${accent('wunderland extensions info image-generation')} ${dim('or override per-agent in')} ${accent('agent.config.json')}.`);
    console.log();

    console.log(`  ${bright('Q: How do I reopen onboarding or find the quick guides again?')}`);
    console.log(`  ${dim('A: Press')} ${accent('t')} ${dim('inside the TUI to reopen the tour, or use')} ${accent('wunderland help getting-started')} ${dim('and')} ${accent('wunderland help tui')}.`);
    console.log();

    console.log(`  ${hr()}`);
    console.log(`  ${dim('More help:')} ${accent('wunderland help <topic>')} ${dim('— topics: getting-started, auth, voice, llm, email, whatsapp, slack, signal, presets, security, tui, ui, export')}`);
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
