/**
 * @fileoverview `wunderland completions` — generate shell completion scripts.
 *
 * Usage:
 *   wunderland completions bash   Print bash completions to stdout
 *   wunderland completions zsh    Print zsh completions to stdout
 *   wunderland completions fish   Print fish completions to stdout
 *   wunderland completions        Show install instructions
 *
 * @module wunderland/cli/commands/completions
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

// ── Command & flag definitions ──────────────────────────────────────────────

/** All top-level commands with descriptions. */
const COMMANDS: [cmd: string, desc: string][] = [
  ['setup', 'Interactive onboarding wizard'],
  ['init', 'Scaffold an agent project'],
  ['create', 'Create agent from natural language'],
  ['start', 'Start local agent server'],
  ['chat', 'Interactive terminal assistant'],
  ['hitl', 'Watch/resolve approvals & checkpoints'],
  ['doctor', 'Health check: keys, tools, connectivity'],
  ['channels', 'List/add/remove channels'],
  ['config', 'Read/write config values'],
  ['status', 'Agent & connection status'],
  ['voice', 'Voice provider status'],
  ['cron', 'Scheduled jobs management'],
  ['seal', 'Seal agent config (integrity hash)'],
  ['verify-seal', 'Verify sealed.json integrity'],
  ['list-presets', 'List personality & agent presets'],
  ['list-personas', 'List AgentOS personas'],
  ['skills', 'Skills management'],
  ['extensions', 'Extension management'],
  ['rag', 'RAG memory management'],
  ['agency', 'Multi-agent collectives'],
  ['workflows', 'Workflow engine'],
  ['evaluate', 'Evaluation suite'],
  ['provenance', 'Audit trail & provenance'],
  ['knowledge', 'Knowledge graph'],
  ['marketplace', 'Marketplace search/install'],
  ['models', 'Provider/model settings'],
  ['plugins', 'List installed extension packs'],
  ['export', 'Export agent as shareable manifest'],
  ['import', 'Import agent from manifest file'],
  ['ollama-setup', 'Configure Ollama (local LLM)'],
  ['export-session', 'Export chat session to file'],
  ['deploy', 'Generate deployment artifacts'],
  ['serve', 'Start agent as background daemon'],
  ['ps', 'List running agent processes'],
  ['logs', 'Tail agent logs'],
  ['stop', 'Stop a running agent'],
  ['monitor', 'Live dashboard of running agents'],
  ['login', 'Authenticate with Wunderland Cloud'],
  ['logout', 'Log out of Wunderland Cloud'],
  ['auth-status', 'Show authentication status'],
  ['upgrade', 'Check for updates & self-update'],
  ['env', 'Manage API keys & secrets'],
  ['completions', 'Generate shell completions'],
  ['help', 'Show help topics'],
  ['version', 'Show version'],
];

/** Subcommands for commands that have them. */
const SUBCOMMANDS: Record<string, string[]> = {
  config: ['get', 'set'],
  env: ['list', 'get', 'set', 'delete', 'import', 'path', 'edit'],
  rag: [
    'ingest',
    'ingest-image',
    'ingest-audio',
    'ingest-document',
    'query',
    'query-media',
    'query-image',
    'query-audio',
    'collections',
    'documents',
    'graph',
    'stats',
    'health',
    'audit',
  ],
  agency: ['list', 'create', 'status'],
  workflows: ['list', 'run', 'status', 'cancel'],
  completions: ['bash', 'zsh', 'fish'],
};

/** Global flags. */
const GLOBAL_FLAGS = [
  '--help', '-h',
  '--version', '-v',
  '--quiet', '-q',
  '--yes', '-y',
  '--auto-approve-tools',
  '--theme',
  '--ascii',
  '--no-color',
  '--dry-run',
  '--tui',
  '--no-tui',
  '--config',
  '--port',
  '--model',
  '--preset',
  '--security-tier',
  '--no-guardrails',
  '--guardrails',
  '--format',
  '--dir',
  '--force',
  '--restart',
  '--all',
  '--no-health',
  '--lines',
  '--follow', '-f',
  '--stderr',
  '--check',
  '--skills-dir',
  '--no-skills',
  '--export-png',
  '--lazy-tools',
  '--target',
  '--output',
  '--region',
];

// ── Main handler ────────────────────────────────────────────────────────────

export default async function cmdCompletions(
  args: string[],
  _flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const shell = args[0]?.toLowerCase();

  switch (shell) {
    case 'bash':
      console.log(generateBash());
      return;
    case 'zsh':
      console.log(generateZsh());
      return;
    case 'fish':
      console.log(generateFish());
      return;
    default:
      printInstructions();
  }
}

// ── Install instructions ────────────────────────────────────────────────────

function printInstructions(): void {
  const detected = detectShell();

  fmt.section('Shell Completions');
  fmt.blank();

  if (detected) {
    fmt.note(`Detected shell: ${accent(detected)}`);
    fmt.blank();
  }

  console.log(`  ${accent('Bash')}`);
  console.log(`    ${dim('wunderland completions bash >> ~/.bashrc')}`);
  console.log(`    ${dim('source ~/.bashrc')}`);
  fmt.blank();

  console.log(`  ${accent('Zsh')}`);
  console.log(`    ${dim('wunderland completions zsh >> ~/.zshrc')}`);
  console.log(`    ${dim('source ~/.zshrc')}`);
  fmt.blank();

  console.log(`  ${accent('Fish')}`);
  console.log(`    ${dim('wunderland completions fish > ~/.config/fish/completions/wunderland.fish')}`);
  fmt.blank();
}

function detectShell(): string | null {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';
  return null;
}

// ── Bash ────────────────────────────────────────────────────────────────────

function generateBash(): string {
  const cmds = COMMANDS.map(([c]) => c).join(' ');
  const flags = GLOBAL_FLAGS.join(' ');

  const subcommandCases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `      ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ) ;;`)
    .join('\n');

  return `# wunderland bash completions
# Generated by: wunderland completions bash
_wunderland() {
  local cur prev words cword
  _init_completion || return

  local commands="${cmds}"
  local global_flags="${flags}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands $global_flags" -- "$cur") )
    return
  fi

  # Subcommand completions
  case "\${words[1]}" in
${subcommandCases}
  esac

  # Flag completions
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$global_flags" -- "$cur") )
    return
  fi
}

complete -F _wunderland wunderland
`;
}

// ── Zsh ─────────────────────────────────────────────────────────────────────

function generateZsh(): string {
  const cmdEntries = COMMANDS.map(
    ([cmd, desc]) => `    '${cmd}:${desc.replace(/'/g, "'\\''")}'`,
  ).join('\n');

  const subcommandCases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => {
      const subsStr = subs.map((s) => `'${s}'`).join(' ');
      return `    ${cmd})\n      compadd ${subsStr}\n      ;;`;
    })
    .join('\n');

  const flagEntries = GLOBAL_FLAGS
    .filter((f) => f.startsWith('--'))
    .map((f) => `    '${f}'`)
    .join('\n');

  return `#compdef wunderland
# wunderland zsh completions
# Generated by: wunderland completions zsh

_wunderland() {
  local -a commands flags

  commands=(
${cmdEntries}
  )

  flags=(
${flagEntries}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'wunderland command' commands
    _describe -t flags 'global flag' flags
    return
  fi

  case "\${words[2]}" in
${subcommandCases}
  esac
}

_wunderland "$@"
`;
}

// ── Fish ────────────────────────────────────────────────────────────────────

function generateFish(): string {
  const lines: string[] = [
    '# wunderland fish completions',
    '# Generated by: wunderland completions fish',
    '',
    '# Disable file completions by default',
    'complete -c wunderland -f',
    '',
    '# Commands',
  ];

  for (const [cmd, desc] of COMMANDS) {
    lines.push(
      `complete -c wunderland -n '__fish_use_subcommand' -a '${cmd}' -d '${desc.replace(/'/g, "\\'")}'`,
    );
  }

  lines.push('');
  lines.push('# Subcommands');
  for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
    for (const sub of subs) {
      lines.push(
        `complete -c wunderland -n '__fish_seen_subcommand_from ${cmd}' -a '${sub}'`,
      );
    }
  }

  lines.push('');
  lines.push('# Global flags');
  for (const flag of GLOBAL_FLAGS) {
    if (flag.startsWith('--')) {
      const name = flag.slice(2);
      lines.push(`complete -c wunderland -l '${name}'`);
    } else if (flag.startsWith('-') && flag.length === 2) {
      lines.push(`complete -c wunderland -s '${flag.slice(1)}'`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
