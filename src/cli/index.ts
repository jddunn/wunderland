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
      ${w('env')}                   Manage API keys & secrets

    ${w('Deploy')}
      ${w('deploy')}               Generate deployment artifacts (Docker, Railway, Fly)

    ${w('Advanced')}
      ${w('rag')}                   RAG memory management
      ${w('agency')}                Multi-agent collectives
      ${w('workflows')}             Workflow engine
      ${w('evaluate')}              Evaluation suite
      ${w('knowledge')}             Knowledge graph
      ${w('provenance')}            Audit trail & provenance
      ${w('marketplace')}           Marketplace search/install

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
    ${d('--dangerously-skip-permissions')}  Skip permission/approval checks (dangerous)
    ${d('--dangerously-skip-command-safety')}  Disable shell command safety checks

  ${c('Guides:')}
    ${w('wunderland help')}                   List help topics
    ${w('wunderland help')} ${d('<topic>')}            Open a short guide

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
    usage: ['wunderland init <dir> [--preset <name>] [--security-tier <tier>] [--provider <id>]'],
    examples: ['wunderland init my-agent --preset research-assistant', 'wunderland init ops-bot --preset operations-assistant --security-tier strict'],
  },
  create: {
    summary: 'Create an agent config from a natural-language description.',
    usage: ['wunderland create [description] [--managed] [--yes]'],
    examples: ['wunderland create "Build a research assistant that summarizes the web."', 'wunderland create "Customer support bot for Shopify orders" --managed'],
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
    usage: ['wunderland chat [--oauth] [--model <id>] [--auto-approve-tools]'],
    examples: ['wunderland chat', 'wunderland chat --oauth'],
  },
  start: {
    summary: 'Start the local agent server (launches TUI dashboard by default).',
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
    summary: 'Inspect configured voice providers and test synthesis.',
    usage: ['wunderland voice [status|test <text>]'],
    examples: ['wunderland voice status', 'wunderland voice test "Hello from Wunderland"'],
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
    summary: 'List or inspect installed and available extensions.',
    usage: ['wunderland extensions [list|info] [options]'],
    examples: ['wunderland extensions', 'wunderland extensions info web-browser'],
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
    summary: 'Run or inspect workflow executions.',
    usage: ['wunderland workflows [list|run|status|cancel] [options]'],
    examples: ['wunderland workflows list', 'wunderland workflows run nightly-summary'],
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
  deploy:            () => import('./commands/deploy.js'),
  serve:             () => import('./commands/serve.js'),
  agents:            () => import('./commands/agents.js'),
  ls:                () => import('./commands/agents.js'),
  ps:                () => import('./commands/ps.js'),
  logs:              () => import('./commands/logs.js'),
  stop:              () => import('./commands/stop.js'),
  monitor:           () => import('./commands/monitor.js'),
  cloud:             () => import('./commands/cloud.js'),
  domains:           () => import('./commands/domains.js'),
  login:             () => import('./commands/login.js'),
  logout:            () => import('./commands/logout.js'),
  'auth-status':     () => import('./commands/auth-status.js'),
  upgrade:           () => import('./commands/upgrade.js'),
  env:               () => import('./commands/env.js'),
  completions:       () => import('./commands/completions.js'),
  quickstart:        () => import('./commands/quickstart.js'),
  new:               () => import('./commands/new.js'),
};

/** Full-banner commands (show large ASCII art). */
const FULL_BANNER_COMMANDS = new Set(['setup', 'init']);

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
  if (!loader) {
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
