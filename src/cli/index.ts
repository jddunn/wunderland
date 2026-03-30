/**
 * @fileoverview CLI entry point and command router.
 * Imported by bin/wunderland.js (thin bootstrap).
 * @module wunderland/cli
 */

import chalk from 'chalk';
import { parseArgs, extractGlobalFlags } from './parse-args.js';
import { printBanner } from './ui/banner.js';
import { printCompactHeader } from './ui/compact-header.js';
import { VERSION, URLS } from './constants.js';
import { muted, dim, accent } from './ui/theme.js';
import * as fmt from './ui/format.js';
import { printHelpTopic, printHelpTopicsList } from './help/topics.js';
import { loadConfig } from './config/config-manager.js';
import { detectAsciiFallback, parseUiTheme, setUiRuntime } from './ui/runtime.js';

// ── Help text ───────────────────────────────────────────────────────────────

function printHelp(opts?: { isExporting?: boolean }): void {
  const c = accent;
  const d = dim;
  const w = chalk.white;

  console.log(`
  ${c('Usage:')}
    ${w('wunderland')} ${d('')}                       ${d('Open TUI dashboard (TTY only)')}
    ${w('wunderland')} ${d('<command>')} ${d('[options]')}
    ${w('wunderland help')} ${d('<topic>')}              ${d('Short guides + onboarding')}

  ${c('Quickstart:')}
    ${w('wunderland setup')}                  Interactive onboarding wizard
    ${w('wunderland doctor')}                 Health check: keys, tools, connectivity
    ${w('wunderland chat')}                   Interactive terminal assistant
    ${w('wunderland start')}                  Start local agent server

  ${c('Commands (grouped):')}
    ${w('Onboarding')}
      ${w('setup')}                 Wizard: keys, channels, personality
      ${w('new')}                   Create agent (interactive, preset, NL, or import)
      ${w('quickstart')}            Detect env → scaffold → go
      ${w('init')} ${d('<dir>')}            Scaffold an agent project
      ${w('create')} ${d('[description]')}  Create agent from natural language
      ${w('spawn')} ${d('<description>')}   Create + start agent in one step
      ${w('batch-create')} ${d('<file>')}   Bulk create agents from file or mission
      ${w('doctor')}                Health check

    ${w('Auth')}
      ${w('login')}                 Log in with ChatGPT subscription (OAuth)
      ${w('logout')}                Remove stored OAuth tokens
      ${w('auth-status')}           Check authentication status

    ${w('Run')}
      ${w('chat')}                  Interactive assistant (REPL)
      ${w('start')}                 Start server + TUI dashboard
      ${w('status')}                Agent & connection status
      ${w('hitl')}                  Watch/resolve approvals & checkpoints

    ${w('Process')}
      ${w('agents')}                List all known agents (alias: ls)
      ${w('serve')}                 Start agent as background daemon
      ${w('ps')}                    List running agent processes
      ${w('logs')} ${d('[seedId]')}        Tail agent logs
      ${w('stop')} ${d('[seedId]')}        Stop a running agent
      ${w('monitor')}               Live dashboard of running agents
      ${w('dashboard')}              Multi-agent web dashboard (port 4444)

    ${w('Configure')}
      ${w('channels')}              List/add/remove channels
      ${w('models')}                Provider/model settings
      ${w('voice')}                 Voice provider status
      ${w('cron')}                  Scheduled jobs management
      ${w('skills')}                Skills management
      ${w('extensions')}            Extension management
      ${w('cloud')}                 Cloud hosting providers
      ${w('domains')}               Domain registrar management
      ${w('list-presets')}           List personality & agent presets
      ${w('list-personas')}          List AgentOS personas
      ${w('config')}                Read/write config values
      ${w('connect')} ${d('<service>')}      Connect Gmail, Calendar, etc. via OAuth
      ${w('env')}                   Manage API keys & secrets

    ${w('Deploy')}
      ${w('deploy')}               Generate deployment artifacts (Docker, Railway, Fly)

    ${w('Orchestration')}
      ${w('workflows')}             Run, explain, and list YAML workflows
      ${w('mission')}               Run and explain intent-driven missions
      ${w('agency')}                Multi-agent collectives

    ${w('AI')}
      ${w('image')}                 Image generation, editing, upscaling, variations
      ${w('video')}                 Video generation, animation, and analysis
      ${w('audio')}                 Music and sound effect generation
      ${w('vision')}                Vision pipeline: OCR, describe, CLIP embeddings
      ${w('structured')}            Structured data extraction from text

    ${w('Advanced')}
      ${w('rag')}                   RAG memory management
      ${w('evaluate')}              Evaluation suite
      ${w('knowledge')}             Knowledge graph
      ${w('discovery')}             Capability discovery & platform knowledge
      ${w('provenance')}            Audit trail & provenance
      ${w('marketplace')}           Marketplace search/install
      ${w('emergent')}              Runtime-forged tool management

    ${w('Utilities')}
      ${w('seal')}                  Seal agent config (integrity hash)
      ${w('verify-seal')}           Verify sealed.json integrity/signature
      ${w('export')}                Export agent as shareable manifest
      ${w('import')} ${d('<manifest>')}    Import agent from manifest file
      ${w('plugins')}               List installed extension packs
      ${w('export-session')}        Export chat session to file
      ${w('ollama-setup')}          Configure Ollama (local LLM)
      ${w('upgrade')}               Check for updates & self-update
      ${w('completions')} ${d('<shell>')}   Shell completions (bash/zsh/fish)
      ${w('version')}               Show version

  ${c('Global Options:')}
    ${d('--help, -h')}             Show help
    ${d('--version, -v')}          Show version
    ${d('--quiet, -q')}            Suppress banner
    ${d('--yes, -y')}              Auto-confirm prompts (non-interactive where possible)
    ${d('--auto-approve-tools')}   Auto-approve tool calls (fully autonomous)
    ${d('--theme <plain|cyberpunk>')} UI theme (default: cyberpunk)
    ${d('--ascii')}                Force ASCII-only UI (auto-fallback in limited terminals)
    ${d('--no-color')}             Disable colors (also: NO_COLOR env)
    ${d('--dry-run')}              Preview without writing
    ${d('--cli')}                  Use traditional CLI output (no TUI)
    ${d('--tui')}                  Force interactive TUI mode
    ${d('--no-tui')}               Alias for --cli
    ${d('--config <path>')}        Config directory path

  ${c('Command Options:')}
    ${d('--port <number>')}        Server port (default: PORT env or 3777)
    ${d('--model <id>')}           LLM model override
    ${d('--preset <name>')}        Personality preset for init
    ${d('--security-tier <tier>')} Security tier (dangerous/permissive/balanced/strict/paranoid)
    ${d('--dir <path>')}           Working directory (seal)
    ${d('--format <json|table>')}  Output format (list-presets, skills, models, plugins)
    ${d('--lazy-tools')}           Start with only schema-on-demand meta tools
    ${d('--target <docker|railway|fly>')} Deployment target (default: docker)
    ${d('--output <dir>')}         Output directory for deploy (default: ./deploy)
    ${d('--region <code>')}        Fly.io region (default: iad)
    ${d('--force')}                Overwrite existing files
    ${d('--restart')}               Auto-restart on crash (serve)
    ${d('--all')}                  Stop all running daemons (stop)
    ${d('--no-health')}            Skip health polling (ps)
    ${d('--lines <n>')}            Number of log lines to show (logs, default: 50)
    ${d('--follow, -f')}           Stream new log lines (logs)
    ${d('--stderr')}               Show stderr instead of stdout (logs)
    ${d('--check')}                Check for updates without installing (upgrade)
    ${d('--skills-dir <path>')}    Load skills from directory
    ${d('--oauth')}                Use ChatGPT subscription instead of API key (chat/start)
    ${d('--no-skills')}            Disable skill loading
${opts?.isExporting ? '' : `    ${d('--export-png <path>')}    Export command output as styled PNG screenshot\n`}
    ${d('--overdrive')}                Auto-approve all tool calls for this session
    ${d('--llm-judge')}                Route HITL approvals through an LLM judge instead of auto-approving
    ${d('--no-guardrail-override')}    Disable post-approval guardrail veto after HITL approval
    ${d('--dangerously-skip-permissions')}  Skip permission/approval checks (dangerous)
    ${d('--dangerously-skip-command-safety')}  Disable shell command safety checks

  ${c('Guides:')}
    ${w('wunderland help')}                   List help topics
    ${w('wunderland help')} ${d('<topic>')}            Open a short guide

  ${c('Natural Language:')}
    ${d('Just describe what you want in plain English:')}
    ${w('wunderland')} ${d('"Build me a research agent that monitors AI news"')}
    ${w('wunderland')} ${d('"Create a support team with triage and escalation"')}
    ${w('wunderland')} ${d('"Research the latest AI news and generate a PDF report"')}
    ${w('wunderland')} ${d('"help me set up Gmail"')}          ${d('# Agent guides credential setup')}

  ${c('Links:')}
    ${muted(URLS.website)}${fmt.dot()}${muted(URLS.saas)}${fmt.dot()}${muted(URLS.docs)}
  `);
}

interface CommandHelpEntry {
  summary: string;
  usage: string[];
  examples?: string[];
  notes?: string[];
}

const COMMAND_HELP: Record<string, CommandHelpEntry> = {
  setup: {
    summary: 'Interactive onboarding wizard for keys, channels, and defaults.',
    usage: ['wunderland setup [--yes] [--no-tui]'],
    examples: ['wunderland setup', 'wunderland setup --yes --ascii --no-tui'],
  },
  init: {
    summary: 'Scaffold a new agent project from a preset.',
    usage: ['wunderland init <dir> [--preset <name>] [--security-tier <tier>] [--local]'],
    examples: ['wunderland init my-agent --local', 'wunderland init my-agent --preset research-assistant', 'wunderland init ops-bot --preset operations-assistant --security-tier strict'],
    notes: ['--local: auto-detect hardware, install Ollama, pull best model, scaffold — zero prompts.'],
  },
  create: {
    summary: 'Create an agent config from a natural-language description.',
    usage: ['wunderland create [description] [--managed] [--yes]'],
    examples: ['wunderland create "Build a research assistant that summarizes the web."', 'wunderland create "Customer support bot for Shopify orders" --managed'],
  },
  spawn: {
    summary: 'Create an agent from natural language and start it immediately.',
    usage: ['wunderland spawn <description> [--port <number>] [--background] [--dir <path>]'],
    examples: [
      'wunderland spawn "a research assistant that monitors Hacker News daily"',
      'wunderland spawn "customer support bot for Shopify" --port 3001',
      'wunderland spawn "creative writer for blog posts" --background',
      'wunderland spawn "DevOps monitor" --dir ./agents/devops -b',
    ],
    notes: [
      'Auto-populates .env from parent process environment (API keys, tokens).',
      '--background / -b: run as a background daemon (uses wunderland serve).',
      'No interactive prompts — fully non-interactive by design.',
    ],
  },
  'batch-create': {
    summary: 'Bulk-create agents from a descriptions file or an LLM-decomposed team mission.',
    usage: [
      'wunderland batch-create <file.txt|file.json> [--output-dir <dir>] [--start-all]',
      'wunderland batch-create --from-mission "<mission>" [--output-dir <dir>] [--start-all]',
    ],
    examples: [
      'wunderland batch-create descriptions.txt',
      'wunderland batch-create agents.json --output-dir ./my-team',
      'wunderland batch-create --from-mission "Build a content marketing team"',
      'wunderland batch-create agents.txt --start-all',
    ],
    notes: [
      '.txt: one description per line (blank lines and # comments are ignored).',
      '.json: array of strings or { "description": "...", "role": "..." } objects.',
      '--from-mission: uses LLM to decompose a high-level mission into agent roles.',
      '--start-all: auto-starts all created agents as daemons after creation.',
    ],
  },
  doctor: {
    summary: 'Check local configuration, API keys, and service connectivity.',
    usage: ['wunderland doctor [--no-tui] [--ascii]'],
    examples: ['wunderland doctor', 'wunderland doctor --no-tui --ascii'],
  },
  login: {
    summary: 'Authenticate with a ChatGPT subscription using OAuth.',
    usage: ['wunderland login'],
    examples: ['wunderland login'],
    notes: ['Use `wunderland auth-status` to inspect the stored session.'],
  },
  logout: {
    summary: 'Remove stored OAuth credentials.',
    usage: ['wunderland logout'],
    examples: ['wunderland logout'],
  },
  'auth-status': {
    summary: 'Show the current OAuth authentication status.',
    usage: ['wunderland auth-status'],
    examples: ['wunderland auth-status'],
  },
  chat: {
    summary: 'Run the interactive terminal assistant.',
    usage: ['wunderland chat [--oauth] [--model <id>] [--auto-approve-tools] [--verbose]'],
    examples: ['wunderland chat', 'wunderland chat --ollama', 'wunderland chat --verbose'],
    notes: ['--verbose, -v: show extension activation, discovery debug, and context compaction logs.'],
  },
  start: {
    summary: 'Start the local agent server with channels, tools, and TUI dashboard.',
    usage: ['wunderland start [--port <number>] [--oauth] [--lazy-tools] [--cli]'],
    examples: ['wunderland start', 'wunderland start --cli --port 3777'],
  },
  status: {
    summary: 'Show agent, runtime, and connectivity status for the current project.',
    usage: ['wunderland status [--no-tui]'],
    examples: ['wunderland status'],
  },
  hitl: {
    summary: 'Inspect and resolve approval checkpoints.',
    usage: ['wunderland hitl [checkpoints|actions] [options]'],
    examples: ['wunderland hitl', 'wunderland hitl checkpoints'],
  },
  agents: {
    summary: 'List known agents on the local machine.',
    usage: ['wunderland agents', 'wunderland ls'],
    examples: ['wunderland agents', 'wunderland ls'],
  },
  ls: {
    summary: 'Alias for `wunderland agents`.',
    usage: ['wunderland ls'],
    examples: ['wunderland ls'],
  },
  serve: {
    summary: 'Start the current agent as a background daemon.',
    usage: ['wunderland serve [--port <number>] [--restart] [--yes]'],
    examples: ['wunderland serve --port 3777', 'wunderland serve --restart --yes'],
  },
  ps: {
    summary: 'List running agent daemons.',
    usage: ['wunderland ps [--no-health]'],
    examples: ['wunderland ps', 'wunderland ps --no-health'],
  },
  logs: {
    summary: 'Show or follow daemon logs.',
    usage: ['wunderland logs [seedId] [--lines <n>] [--follow] [--stderr]'],
    examples: ['wunderland logs seed_my_agent --lines 100', 'wunderland logs seed_my_agent --follow'],
  },
  stop: {
    summary: 'Stop a running agent daemon.',
    usage: ['wunderland stop [seedId] [--all] [--yes]'],
    examples: ['wunderland stop seed_my_agent', 'wunderland stop --all --yes'],
  },
  monitor: {
    summary: 'Show a live dashboard of running agents.',
    usage: ['wunderland monitor'],
    examples: ['wunderland monitor'],
  },
  dashboard: {
    summary: 'Launch the multi-agent web dashboard (Wunderland Hub).',
    usage: ['wunderland dashboard [--port <number>] [--secret <string>]'],
    examples: [
      'wunderland dashboard',
      'wunderland dashboard --port 5555',
      'wunderland dashboard --secret my-secret',
    ],
    notes: [
      'Default port: 4444. Open http://localhost:4444/ in your browser.',
      'Admin secret is printed in the terminal — paste it to authenticate.',
      'Agents tab: view, start, stop agents. Spawn tab: create agents from NL.',
    ],
  },
  channels: {
    summary: 'Manage channel integrations for the current agent.',
    usage: ['wunderland channels [list|add|remove] [options]'],
    examples: ['wunderland channels list', 'wunderland channels add discord'],
  },
  models: {
    summary: 'Inspect or change provider/model defaults.',
    usage: ['wunderland models [list|set-default|test] [options]'],
    examples: ['wunderland models list', 'wunderland models set-default openai gpt-4o'],
  },
  voice: {
    summary: 'Inspect voice providers, list STT/TTS stacks, and test synthesis.',
    usage: ['wunderland voice [status|tts|stt|test <text>|clone]'],
    examples: [
      'wunderland voice status',
      'wunderland voice tts',
      'wunderland voice stt',
      'wunderland voice test "Hello from Wunderland"',
    ],
  },
  cron: {
    summary: 'Inspect scheduled job support and scheduler status.',
    usage: ['wunderland cron'],
    examples: ['wunderland cron'],
  },
  skills: {
    summary: 'List, inspect, enable, or disable skills.',
    usage: ['wunderland skills [list|info|enable|disable] [options]'],
    examples: ['wunderland skills', 'wunderland skills info web-search'],
  },
  extensions: {
    summary: 'Manage extensions — list, enable, configure, set provider defaults.',
    usage: ['wunderland extensions <list|info|enable|disable|configure|set-default> [options]'],
    examples: [
      'wunderland extensions list',
      'wunderland extensions info image-generation',
      'wunderland extensions enable email-gmail',
      'wunderland extensions configure',
      'wunderland extensions configure image-generation',
      'wunderland extensions set-default image-generation email-gmail',
    ],
    notes: [
      'configure: set global provider defaults (image gen, TTS, STT, web search).',
      'configure <name>: configure a specific extension (priority, scope).',
      'set-default: add extensions to global defaults (~/.wunderland/config.json).',
      'info <name>: shows required API keys with set/not-set status.',
    ],
  },
  cloud: {
    summary: 'Inspect cloud hosting provider integrations.',
    usage: ['wunderland cloud [list|info <provider>]'],
    examples: ['wunderland cloud', 'wunderland cloud info railway'],
  },
  domains: {
    summary: 'Inspect domain registrar integrations.',
    usage: ['wunderland domains [list|info <registrar>]'],
    examples: ['wunderland domains', 'wunderland domains info cloudflare'],
  },
  'list-presets': {
    summary: 'List built-in personality and agent presets.',
    usage: ['wunderland list-presets [--format json|table]'],
    examples: ['wunderland list-presets', 'wunderland list-presets --format json'],
  },
  'list-personas': {
    summary: 'List built-in AgentOS personas.',
    usage: ['wunderland list-personas [--format json|table]'],
    examples: ['wunderland list-personas', 'wunderland list-personas --format json'],
  },
  config: {
    summary: 'Read or write CLI configuration values.',
    usage: ['wunderland config [get <key>|set <key> <value>|list]'],
    examples: ['wunderland config list', 'wunderland config set ui.theme cyberpunk'],
  },
  env: {
    summary: 'Manage environment variables and secrets.',
    usage: ['wunderland env [list|get|set|delete|import] [options]'],
    examples: ['wunderland env list', 'wunderland env get OPENAI_API_KEY'],
  },
  deploy: {
    summary: 'Generate deployment artifacts for Docker, Railway, or Fly.',
    usage: ['wunderland deploy [--target <docker|railway|fly>] [--output <dir>] [--force]'],
    examples: ['wunderland deploy --target docker', 'wunderland deploy --target fly --region iad'],
  },
  rag: {
    summary: 'Manage vector and graph RAG collections, ingestion, and queries.',
    usage: ['wunderland rag [ingest|query|collections|documents|graph] [options]'],
    examples: ['wunderland rag query "What do we know about ACME?"', 'wunderland rag collections list'],
  },
  agency: {
    summary: 'Manage multi-agent collectives and handoffs.',
    usage: ['wunderland agency [create|status|list|handoff] [options]'],
    examples: ['wunderland agency list', 'wunderland agency create ops-team'],
  },
  workflows: {
    summary: 'Discover orchestration files and inspect workflow executions.',
    usage: ['wunderland workflows [list|examples|run|status|cancel] [options]'],
    examples: ['wunderland workflows list', 'wunderland workflows examples', 'wunderland help workflows'],
  },
  evaluate: {
    summary: 'Run evaluation datasets and inspect results.',
    usage: ['wunderland evaluate [list|run|results] [options]'],
    examples: ['wunderland evaluate list', 'wunderland evaluate run support-regression'],
  },
  knowledge: {
    summary: 'Inspect the knowledge graph and local memories.',
    usage: ['wunderland knowledge [stats|query|entities|relations] [options]'],
    examples: ['wunderland knowledge stats', 'wunderland knowledge query "refund policy"'],
  },
  provenance: {
    summary: 'Inspect provenance settings and verify audit trails.',
    usage: ['wunderland provenance [status|verify|tail] [options]'],
    examples: ['wunderland provenance status', 'wunderland provenance verify --dir .'],
  },
  marketplace: {
    summary: 'Search and install marketplace assets.',
    usage: ['wunderland marketplace [search|info|install] [options]'],
    examples: ['wunderland marketplace search browser', 'wunderland marketplace info web-browser'],
  },
  seal: {
    summary: 'Generate a `sealed.json` integrity record for the current agent config.',
    usage: ['wunderland seal [--dir <path>] [--force]'],
    examples: ['wunderland seal', 'wunderland seal --dir . --force'],
  },
  'verify-seal': {
    summary: 'Verify a `sealed.json` file against the local agent config.',
    usage: ['wunderland verify-seal <sealed.json> [--dir <path>]'],
    examples: ['wunderland verify-seal sealed.json'],
  },
  export: {
    summary: 'Export the current agent as a manifest.',
    usage: ['wunderland export [--output <path>] [--force]'],
    examples: ['wunderland export', 'wunderland export --output agent.manifest.json --force'],
  },
  import: {
    summary: 'Import an agent manifest into a local project directory.',
    usage: ['wunderland import <manifest.json> [--dir <target>] [--force]'],
    examples: ['wunderland import ./agent.manifest.json', 'wunderland import ./agent.manifest.json --dir ./imported-agent'],
  },
  plugins: {
    summary: 'List installed extension packs and plugins.',
    usage: ['wunderland plugins [--format json|table]'],
    examples: ['wunderland plugins', 'wunderland plugins --format json'],
  },
  'export-session': {
    summary: 'Export a chat session transcript.',
    usage: ['wunderland export-session [--format json|md] [--output <path>]'],
    examples: ['wunderland export-session --format md --output session.md'],
  },
  'ollama-setup': {
    summary: 'Configure Ollama as the local LLM provider.',
    usage: ['wunderland ollama-setup [model] [--yes]'],
    examples: ['wunderland ollama-setup', 'wunderland ollama-setup llama3.1:8b --yes'],
  },
  upgrade: {
    summary: 'Check for updates or self-update the CLI.',
    usage: ['wunderland upgrade [--check]'],
    examples: ['wunderland upgrade --check', 'wunderland upgrade'],
  },
  completions: {
    summary: 'Print shell completion scripts.',
    usage: ['wunderland completions <bash|zsh|fish>'],
    examples: ['wunderland completions zsh', 'wunderland completions bash'],
  },
  version: {
    summary: 'Print the installed CLI version.',
    usage: ['wunderland version'],
    examples: ['wunderland version'],
  },
  image: {
    summary: 'Image generation, editing, upscaling, and variations via AgentOS providers.',
    usage: [
      'wunderland image generate "<prompt>" [--provider <name>] [--model <id>] [--size <WxH>] [--output <path>]',
      'wunderland image edit <image> --prompt "..." [--mask <mask>] [--strength 0.75] [--output <path>]',
      'wunderland image upscale <image> [--scale 4] [--output <path>]',
      'wunderland image variate <image> [--n 3] [--output <path>]',
    ],
    examples: [
      'wunderland image generate "A cyberpunk city at night"',
      'wunderland image edit photo.jpg --prompt "Make it sunset" --output edited.png',
      'wunderland image upscale thumbnail.jpg --scale 4 --output hires.png',
      'wunderland image variate photo.jpg --n 3 --output variations/',
    ],
    notes: ['Supported providers: openai (default), stability, replicate, ollama, stable-diffusion-local.'],
  },
  video: {
    summary: 'Video generation, image-to-video animation, and video analysis via AgentOS providers.',
    usage: [
      'wunderland video generate "<prompt>" [--provider <name>] [--model <id>] [--duration <secs>] [--aspect-ratio <r>] [--resolution <res>] [--output <path>]',
      'wunderland video animate <image> "<prompt>" [--provider <name>] [--duration <secs>] [--output <path>]',
      'wunderland video analyze <file> [--provider <name>] [--output <path>]',
    ],
    examples: [
      'wunderland video generate "A drone flyover of a mountain lake at sunrise"',
      'wunderland video animate photo.jpg "Make the water ripple gently" --output animated.mp4',
      'wunderland video analyze clip.mp4 --output analysis.json',
    ],
    notes: ['Supported providers: runway, pika, stability, replicate.'],
  },
  audio: {
    summary: 'Music and sound effect generation via AgentOS providers.',
    usage: [
      'wunderland audio music "<prompt>" [--provider <name>] [--duration <secs>] [--bpm <n>] [--genre <name>] [--mood <name>] [--output <path>]',
      'wunderland audio sfx "<prompt>" [--provider <name>] [--duration <secs>] [--output <path>]',
    ],
    examples: [
      'wunderland audio music "Upbeat electronic lo-fi beat" --duration 60 --bpm 90',
      'wunderland audio sfx "Thunderclap followed by heavy rain" --output thunder.mp3',
      'wunderland audio music "Ambient piano for a meditation app" --genre ambient --mood calm',
    ],
    notes: ['Supported providers: suno, udio, elevenlabs, stability.'],
  },
  vision: {
    summary: 'Vision pipeline: OCR text extraction, image description, and CLIP embeddings.',
    usage: [
      'wunderland vision ocr <image> [--strategy <name>] [--output <path>] [--format json]',
      'wunderland vision describe <image> [--provider <name>] [--output <path>]',
      'wunderland vision embed <image> [--output <path>]',
    ],
    examples: [
      'wunderland vision ocr document.png',
      'wunderland vision ocr receipt.jpg --format json --output result.json',
      'wunderland vision describe photo.jpg',
      'wunderland vision embed image.png --output embedding.json',
    ],
    notes: [
      'Strategies: progressive (default), local-only, cloud-only, parallel.',
      'Install ppu-paddle-ocr for best local OCR. Cloud needs OPENAI_API_KEY or GOOGLE_CLOUD_VISION_KEY.',
    ],
  },
  structured: {
    summary: 'Extract structured JSON data from unstructured text using an LLM.',
    usage: ['wunderland structured extract "<text>" --schema \'{"field":"type",...}\''],
    examples: [
      'wunderland structured extract "John is 30 years old" --schema \'{"name":"string","age":"number"}\'',
      'echo "Invoice #1234, total $99.99" | wunderland structured extract --schema \'{"invoice_number":"string","total":"number"}\'',
    ],
    notes: ['--schema: JSON object where keys are field names and values are type hints.'],
  },
  emergent: {
    summary: 'Manage runtime-forged emergent tools (list, inspect, export, import, promote, demote, audit).',
    usage: ['wunderland emergent <list|inspect|export|import|promote|demote|audit> [name|id|file] [--seed <seedId>]'],
    examples: [
      'wunderland emergent list',
      'wunderland emergent list --seed seed_cipher_7f3a',
      'wunderland emergent inspect fetch_github_pr_summary --seed seed_cipher_7f3a',
      'wunderland emergent export fetch_github_pr_summary --seed seed_cipher_7f3a',
      'wunderland emergent import ./fetch_github_pr_summary.emergent-tool.yaml --seed seed_other',
      'wunderland emergent promote fetch_github_pr_summary --seed seed_cipher_7f3a',
      'wunderland emergent demote csv_column_stats --seed seed_cipher_7f3a',
      'wunderland emergent audit csv_column_stats --seed seed_cipher_7f3a',
    ],
    notes: [
      'Emergent tools are created at runtime by agents and subject to LLM-as-judge verification.',
      'Enable emergent mode: set "emergent": true in agent.config.json.',
      'Tools progress through tiers: session -> agent -> shared.',
      'Without --seed the command falls back to preview/demo output.',
    ],
  },
  connect: {
    summary: 'Connect external services (Gmail, WhatsApp, Slack, Signal) via OAuth or setup wizard.',
    usage: ['wunderland connect <service> [--credentials <path>]'],
    examples: [
      'wunderland connect gmail',
      'wunderland connect gmail --credentials ~/Downloads/client_secret_*.json',
      'wunderland connect whatsapp',
      'wunderland connect slack',
      'wunderland connect signal',
    ],
    notes: [
      'Opens your browser for secure OAuth authorization (Gmail, WhatsApp Meta, Slack) or runs an interactive setup wizard (WhatsApp Twilio, Signal).',
      'Gmail supports auto-discovery of client_secret*.json in ~/Downloads when no credentials are configured.',
      '--credentials accepts a Google OAuth client secret JSON ({"installed": {...}} or {"web": {...}} format).',
    ],
  },
  new: {
    summary: 'Interactive agent creation — describe in plain English, choose a preset, start blank, or import.',
    usage: ['wunderland new [--preset <name>] [--dir <path>]'],
    examples: [
      'wunderland new',
      'wunderland new --preset research-assistant',
    ],
    notes: [
      'Prompts you for a creation method: natural-language description, preset, blank, or import from manifest.',
      'Equivalent to running `wunderland create` interactively with more options.',
    ],
  },
  mission: {
    summary: 'Run goal-directed multi-agent missions with LLM-based planner decomposition.',
    usage: [
      'wunderland mission run <file.yaml> [--input key=value ...]',
      'wunderland mission explain <file.yaml>',
      'wunderland mission list',
    ],
    examples: [
      'wunderland mission run examples/mission-deep-research.yaml --input topic="quantum computing"',
      'wunderland mission explain examples/mission-deep-research.yaml',
      'wunderland mission list',
    ],
    notes: [
      'Missions describe a goal in natural language; a planner decomposes it into steps at runtime.',
      'Missions compile to the same AgentGraph IR as workflow() definitions.',
      'See also: wunderland help missions',
    ],
  },
  discovery: {
    summary: 'Inspect the capability discovery engine, platform knowledge base, and catalog.',
    usage: ['wunderland discovery'],
    examples: ['wunderland discovery'],
    notes: [
      'Opens the discovery dashboard in TUI mode (press 8 in the dashboard).',
      'In chat mode, use /discover for capability stats and /router for QueryRouter status.',
      'For a full guide: wunderland help discovery',
    ],
  },
  quickstart: {
    summary: 'Auto-detect environment, scaffold agent config, and get to a runnable agent fast.',
    usage: ['wunderland quickstart [--dir <path>] [--yes]'],
    examples: ['wunderland quickstart', 'wunderland quickstart --dir ./my-agent --yes'],
    notes: [
      'Detects available API keys, local hardware (GPU/RAM), and picks the best provider.',
      'Scaffolds agent.config.json, .env, and optionally installs Ollama for local use.',
    ],
  },
};

function printCommandHelp(command: string): boolean {
  const entry = COMMAND_HELP[command];
  if (!entry) return false;

  const c = accent;
  const d = dim;
  const w = chalk.white;

  console.log(`
  ${c('Command:')} ${w(command)}
    ${entry.summary}

  ${c('Usage:')}
${entry.usage.map((line) => `    ${w(line)}`).join('\n')}
${entry.examples?.length ? `
  ${c('Examples:')}
${entry.examples.map((line) => `    ${w(line)}`).join('\n')}` : ''}${entry.notes?.length ? `

  ${c('Notes:')}
${entry.notes.map((line) => `    ${d(line)}`).join('\n')}` : ''}

  ${d('Full reference:')} ${accent('wunderland --help')}
  ${d('Quick guides:')}   ${accent('wunderland help getting-started')}
  `);

  return true;
}

// ── Command dispatch ────────────────────────────────────────────────────────

/** Command registry — lazy imports for fast startup. */
const COMMANDS: Record<string, () => Promise<{ default: (...args: any[]) => Promise<void> }>> = {
  setup:          () => import('./commands/setup.js'),
  init:           () => import('./commands/init.js'),
  create:         () => import('./commands/create.js'),
  spawn:          () => import('./commands/spawn.js'),
  'batch-create': () => import('./commands/batch-create.js'),
  start:          () => import('./commands/start/index.js'),
  chat:           () => import('./commands/chat.js'),
  hitl:           () => import('./commands/hitl.js'),
  doctor:         () => import('./commands/doctor.js'),
  channels:       () => import('./commands/channels.js'),
  config:         () => import('./commands/config-cmd.js'),
  status:         () => import('./commands/status.js'),
  voice:          () => import('./commands/voice.js'),
  cron:           () => import('./commands/cron.js'),
  seal:           () => import('./commands/seal.js'),
  'verify-seal':  () => import('./commands/verify-seal.js'),
  'list-presets': () => import('./commands/list-presets.js'),
  'list-personas': () => import('./commands/list-personas.js'),
  skills:         () => import('./commands/skills.js'),
  extensions:     () => import('./commands/extensions.js'),
  rag:            () => import('./commands/rag.js'),
  agency:         () => import('./commands/agency.js'),
  workflows:      () => import('./commands/workflows.js'),
  mission:        () => import('./commands/mission.js'),
  evaluate:       () => import('./commands/evaluate.js'),
  provenance:     () => import('./commands/provenance.js'),
  knowledge:      () => import('./commands/knowledge.js'),
  marketplace:    () => import('./commands/marketplace.js'),
  models:         () => import('./commands/models.js'),
  plugins:        () => import('./commands/plugins.js'),
  'export':       () => import('./commands/export-agent.js'),
  'import':       () => import('./commands/import-agent.js'),
  'ollama-setup':    () => import('./commands/ollama-setup.js'),
  'export-session':  () => import('./commands/export-session.js'),
  emergent:          () => import('./commands/emergent.js'),
  deploy:            () => import('./commands/deploy.js'),
  serve:             () => import('./commands/agent/serve.js'),
  agents:            () => import('./commands/agent/agents.js'),
  ls:                () => import('./commands/agent/agents.js'),
  ps:                () => import('./commands/agent/ps.js'),
  logs:              () => import('./commands/agent/logs.js'),
  stop:              () => import('./commands/agent/stop.js'),
  monitor:           () => import('./commands/agent/monitor.js'),
  dashboard:         () => import('./commands/dashboard/index.js'),
  cloud:             () => import('./commands/cloud.js'),
  domains:           () => import('./commands/domains.js'),
  login:             () => import('./commands/auth/login.js'),
  logout:            () => import('./commands/auth/logout.js'),
  'auth-status':     () => import('./commands/auth/auth-status.js'),
  upgrade:           () => import('./commands/upgrade.js'),
  env:               () => import('./commands/env.js'),
  completions:       () => import('./commands/completions.js'),
  quickstart:        () => import('./commands/quickstart.js'),
  new:               () => import('./commands/new.js'),
  connect:           () => import('./commands/connect.js'),
  image:             () => import('./commands/ai/image.js'),
  video:             () => import('./commands/ai/video.js'),
  audio:             () => import('./commands/ai/audio.js'),
  vision:            () => import('./commands/ai/vision.js'),
  structured:        () => import('./commands/ai/structured.js'),
};

/** Full-banner commands (show large ASCII art). */
const FULL_BANNER_COMMANDS = new Set(['setup', 'init']);

// ── Natural language intent router ──────────────────────────────────────────

import { classifyIntent, INTENT_LABELS } from './nl-intent-classifier.js';

/**
 * Route unrecognized CLI input through intent classification and dispatch
 * to the appropriate command handler.
 *
 * @param nlInput  - The joined non-flag arguments from the command line.
 * @param flags    - Parsed CLI flags (forwarded to command handler).
 * @param globals  - Global flags (forwarded to command handler).
 */
async function routeNaturalLanguage(
  nlInput: string,
  flags: Record<string, string | boolean>,
  globals: import('./types.js').GlobalFlags,
): Promise<void> {
  const intent = classifyIntent(nlInput);
  const { label, command } = INTENT_LABELS[intent];

  // Print a brief routing indicator so the user understands the dispatch
  console.log(
    dim(`[wunderland] Detected intent: ${label}`) +
    dim(` → running "${command}"`)
  );
  console.log();

  switch (intent) {
    case 'create': {
      const mod = await import('./commands/create.js');
      await mod.default([nlInput], flags, globals);
      break;
    }
    case 'agency': {
      const mod = await import('./commands/agency.js');
      await mod.default(['create', nlInput], flags, globals);
      break;
    }
    case 'mission': {
      const mod = await import('./commands/mission.js');
      await mod.default([nlInput], flags, globals);
      break;
    }
    case 'connect': {
      const mod = await import('./commands/connect.js');
      await mod.default(['gmail'], flags);
      break;
    }
    case 'chat':
    case 'help': {
      // For both chat and help intents, route through the chat command.
      // The QueryRouter inside chat will answer platform questions from
      // the knowledge base when appropriate.
      const mod = await import('./commands/chat.js');
      await mod.default([nlInput], flags, globals);
      break;
    }
  }
}

/**
 * Main CLI entry point.
 * Called from bin/wunderland.js bootstrap.
 */
export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const globals = extractGlobalFlags(flags);

  // Resolve UI runtime early (before any output).
  const cfg = await loadConfig(globals.config);
  const resolvedTheme =
    parseUiTheme(flags['theme'])
    ?? parseUiTheme(cfg.ui?.theme)
    ?? 'cyberpunk';
  const resolvedAscii = globals.ascii || cfg.ui?.ascii === true || detectAsciiFallback();
  const resolvedNoColor = globals.noColor;

  setUiRuntime({ theme: resolvedTheme, ascii: resolvedAscii, noColor: resolvedNoColor });
  globals.theme = resolvedTheme;
  globals.ascii = resolvedAscii;
  globals.noColor = resolvedNoColor;

  if (resolvedNoColor) chalk.level = 0;

  // Version
  if (globals.version) {
    console.log(`wunderland v${VERSION}`);
    return;
  }

  const command = positional[0];
  const subArgs = positional.slice(1);

  // No command → TUI dashboard (if TTY) or help text
  if (!command) {
    // --help with no command = always print help (never re-launch TUI)
    if (globals.help) {
      if (!globals.quiet) await printBanner();
      printHelp();
      return;
    }
    // --export-png with no command = export help
    if (typeof flags['export-png'] === 'string') {
      const { withExport } = await import('./export/export-middleware.js');
      const helpHandler = async () => { printCompactHeader(); printHelp({ isExporting: true }); };
      await withExport(helpHandler, [], flags, globals, '--help');
      return;
    }
    const shouldTui = globals.tui || (!globals.noTui && !globals.quiet && process.stdout.isTTY);
    if (shouldTui) {
      // First-run detection: if no config exists, show welcome flow instead of TUI
      const { existsSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const configExists = existsSync(`${homedir()}/.wunderland/config.json`);
      if (!configExists) {
        const p = await import('@clack/prompts');
        await printBanner();
        fmt.panel({
          title: 'Welcome to Wunderland',
          style: 'brand',
          content: [
            'Deploy autonomous AI agents with personality, memory, and real skills.',
            '',
            'This looks like your first time — let\'s get you set up.',
          ].join('\n'),
        });
        fmt.blank();

        const action = await p.select({
          message: 'How would you like to get started?',
          options: [
            { value: 'quickstart', label: 'Quick Start', hint: 'API key + scaffold + go' },
            { value: 'setup', label: 'Full Setup', hint: 'interactive wizard with all options' },
            { value: 'create', label: 'Describe Your Agent', hint: 'plain English → agent config' },
            { value: 'tui', label: 'Skip to Dashboard', hint: 'I know what I\'m doing' },
          ],
        });

        if (p.isCancel(action)) return;

        if (action === 'quickstart') {
          const cmdQuickstart = (await import('./commands/quickstart.js')).default;
          await cmdQuickstart([], flags, globals);
          return;
        }
        if (action === 'setup') {
          const cmdSetup = (await import('./commands/setup.js')).default;
          await cmdSetup([], flags, globals);
          return;
        }
        if (action === 'create') {
          const cmdCreate = (await import('./commands/create.js')).default;
          await cmdCreate([], flags, globals);
          return;
        }
        // 'tui' falls through to normal TUI launch
      }

      const { launchTui } = await import('./tui/index.js');
      await launchTui(globals);
      return;
    }
    if (!globals.quiet) await printBanner();
    printHelp();
    return;
  }

  // Help flag on any command
  if (globals.help && command !== 'help') {
    if (typeof flags['export-png'] === 'string') {
      const { withExport } = await import('./export/export-middleware.js');
      const helpHandler = async () => {
        printCompactHeader();
        if (!printCommandHelp(command)) printHelp({ isExporting: true });
      };
      await withExport(helpHandler, [], flags, globals, '--help');
      return;
    }
    if (!globals.quiet) printCompactHeader();
    if (!printCommandHelp(command)) printHelp();
    return;
  }

  // Help / version as commands
  if (command === 'help' || command === '--help') {
    const topic = subArgs[0];
    const isHelpCommand = command === 'help';
    if (typeof flags['export-png'] === 'string') {
      const { withExport } = await import('./export/export-middleware.js');
      const helpHandler = async () => {
        if (!globals.quiet) await printBanner();
        if (topic) {
          printHelpTopic(topic);
          return;
        }
        if (isHelpCommand) {
          printHelpTopicsList();
          console.log(`  ${dim('Full reference:')} ${accent('wunderland --help')}`);
          console.log();
          return;
        }
        printHelp({ isExporting: true });
      };
      await withExport(helpHandler, subArgs, flags, globals, '--help');
      return;
    }
    if (!globals.quiet) await printBanner();
    if (topic) {
      printHelpTopic(topic);
      return;
    }
    if (isHelpCommand) {
      printHelpTopicsList();
      console.log(`  ${dim('Full reference:')} ${accent('wunderland --help')}`);
      console.log();
      return;
    }
    printHelp();
    return;
  }
  if (command === 'version' || command === '--version') {
    if (typeof flags['export-png'] === 'string') {
      const { withExport } = await import('./export/export-middleware.js');
      const versionHandler = async () => { console.log(`wunderland v${VERSION}`); };
      await withExport(versionHandler, subArgs, flags, globals, 'version');
      return;
    }
    console.log(`wunderland v${VERSION}`);
    return;
  }

  // Banner
  if (!globals.quiet) {
    if (FULL_BANNER_COMMANDS.has(command)) {
      await printBanner();
    } else {
      printCompactHeader();
    }
  }

  // Dispatch
  const loader = COMMANDS[command];

  // ── NL intent routing for unrecognized input ──────────────────────────
  // If the first arg isn't a known command AND the full non-flag input looks
  // like natural language (more than a single short word), classify and route.
  if (!loader) {
    const rawArgs = positional.filter((a) => !a.startsWith('-'));
    const nlInput = rawArgs.join(' ').trim();

    if (nlInput.length > 5) {
      await routeNaturalLanguage(nlInput, flags, globals);
      return;
    }

    // Truly unknown short command — show error as before
    fmt.errorBlock('Unknown command', `"${command}" is not a wunderland command. Run ${accent('wunderland --help')} for available commands.`);
    process.exitCode = 1;
    return;
  }

  try {
    const mod = await loader();
    const handler = mod.default;

    // PNG export interception
    if (typeof flags['export-png'] === 'string') {
      const { withExport } = await import('./export/export-middleware.js');
      await withExport(handler, subArgs, flags, globals, command);
      return;
    }

    await handler(subArgs, flags, globals);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Command failed', message);
    process.exitCode = 1;
  }
}
