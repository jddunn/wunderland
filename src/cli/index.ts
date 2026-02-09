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

// ── Help text ───────────────────────────────────────────────────────────────

function printHelp(): void {
  const c = accent;
  const d = dim;

  console.log(`
  ${c('Usage:')}
    ${chalk.white('wunderland')} ${d('<command>')} ${d('[options]')}

  ${c('Commands:')}
    ${chalk.white('setup')}                  Interactive onboarding wizard
    ${chalk.white('init')} ${d('<dir>')}             Scaffold a new Wunderbot project
    ${chalk.white('start')}                  Start local agent server
    ${chalk.white('chat')}                   Interactive terminal assistant
    ${chalk.white('doctor')}                 Health check: keys, tools, connectivity
    ${chalk.white('channels')}               List configured channels
    ${chalk.white('channels add')}           Add a channel interactively
    ${chalk.white('channels remove')} ${d('<id>')}   Remove a channel
    ${chalk.white('config')}                 Show current config
    ${chalk.white('config get')} ${d('<key>')}       Get a config value
    ${chalk.white('config set')} ${d('<key> <val>')} Set a config value
    ${chalk.white('voice')}                  Voice provider status
    ${chalk.white('cron')}                   Scheduled jobs management
    ${chalk.white('status')}                 Agent & connection status
    ${chalk.white('seal')}                   Seal agent config (integrity hash)
    ${chalk.white('list-presets')}            List personality & HEXACO presets
    ${chalk.white('skills')}                 Manage agent skills
    ${chalk.white('skills list')}             List available skills
    ${chalk.white('skills info')} ${d('<name>')}     Show skill details
    ${chalk.white('skills enable')} ${d('<name>')}   Enable a skill
    ${chalk.white('skills disable')} ${d('<name>')}  Disable a skill
    ${chalk.white('models')}                 List LLM providers & models
    ${chalk.white('models set-default')} ${d('<p> <m>')} Set default provider/model
    ${chalk.white('models test')} ${d('[provider]')} Test provider connectivity
    ${chalk.white('export')}                 Export agent as shareable manifest
    ${chalk.white('import')} ${d('<manifest>')}     Import agent from manifest file
    ${chalk.white('plugins')}                List installed extension packs
    ${chalk.white('version')}                Show version

  ${c('Global Options:')}
    ${d('--help, -h')}             Show help
    ${d('--version, -v')}          Show version
    ${d('--quiet, -q')}            Suppress banner
    ${d('--yes, -y')}              Auto-approve tool calls (headless)
    ${d('--no-color')}             Disable colors (also: NO_COLOR env)
    ${d('--dry-run')}              Preview without writing
    ${d('--config <path>')}        Config directory path

  ${c('Command Options:')}
    ${d('--port <number>')}        Server port (default: PORT env or 3777)
    ${d('--model <id>')}           LLM model override
    ${d('--preset <name>')}        Personality preset for init
    ${d('--security-tier <tier>')} Security tier (dangerous/permissive/balanced/strict/paranoid)
    ${d('--dir <path>')}           Working directory (seal)
    ${d('--format <json|table>')}  Output format (list-presets, skills, models, plugins)
	    ${d('--lazy-tools')}           Start with only schema-on-demand meta tools
	    ${d('--force')}                Overwrite existing files
	    ${d('--skills-dir <path>')}    Load skills from directory
	    ${d('--no-skills')}            Disable skill loading
	    ${d('--dangerously-skip-permissions')}  Auto-approve tool calls
	    ${d('--dangerously-skip-command-safety')}  Disable shell command safety checks

  ${c('Links:')}
    ${muted(URLS.website)}${dim('  \u00B7  ')}${muted(URLS.saas)}${dim('  \u00B7  ')}${muted(URLS.docs)}
  `);
}

// ── Command dispatch ────────────────────────────────────────────────────────

/** Command registry — lazy imports for fast startup. */
const COMMANDS: Record<string, () => Promise<{ default: (...args: any[]) => Promise<void> }>> = {
  setup:          () => import('./commands/setup.js'),
  init:           () => import('./commands/init.js'),
  start:          () => import('./commands/start.js'),
  chat:           () => import('./commands/chat.js'),
  doctor:         () => import('./commands/doctor.js'),
  channels:       () => import('./commands/channels.js'),
  config:         () => import('./commands/config-cmd.js'),
  status:         () => import('./commands/status.js'),
  voice:          () => import('./commands/voice.js'),
  cron:           () => import('./commands/cron.js'),
  seal:           () => import('./commands/seal.js'),
  'list-presets': () => import('./commands/list-presets.js'),
  skills:         () => import('./commands/skills.js'),
  models:         () => import('./commands/models.js'),
  plugins:        () => import('./commands/plugins.js'),
  'export':       () => import('./commands/export-agent.js'),
  'import':       () => import('./commands/import-agent.js'),
};

/** Full-banner commands (show large ASCII art). */
const FULL_BANNER_COMMANDS = new Set(['setup']);

/**
 * Main CLI entry point.
 * Called from bin/wunderland.js bootstrap.
 */
export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const globals = extractGlobalFlags(flags);

  // Disable colors if requested
  if (globals.noColor) {
    chalk.level = 0;
  }

  // Version
  if (globals.version) {
    console.log(`wunderland v${VERSION}`);
    return;
  }

  const command = positional[0];
  const subArgs = positional.slice(1);

  // No command → full banner + help
  if (!command) {
    if (!globals.quiet) await printBanner();
    printHelp();
    return;
  }

  // Help flag on any command
  if (globals.help && command !== 'help') {
    if (!globals.quiet) printCompactHeader();
    printHelp();
    return;
  }

  // Help / version as commands
  if (command === 'help' || command === '--help') {
    if (!globals.quiet) await printBanner();
    printHelp();
    return;
  }
  if (command === 'version' || command === '--version') {
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
    await mod.default(subArgs, flags, globals);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Command failed', message);
    process.exitCode = 1;
  }
}
