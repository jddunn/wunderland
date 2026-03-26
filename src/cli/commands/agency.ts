/**
 * @fileoverview `wunderland agency` — multi-agent collective management.
 * @module wunderland/cli/commands/agency
 *
 * Live mode:
 * - `run` creates and executes an agency from agent.config.json
 * - `list` / `status` query the backend API when `--seed` is provided
 *
 * Preview mode:
 * - Falls back to demo data when no seed/backend is configured.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { GlobalFlags } from '../types.js';
import {
  accent,
  bright,
  dim,
  muted,
  success as sColor,
  warn as wColor,
} from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs as getGlyphs } from '../ui/glyphs.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

// ---------------------------------------------------------------------------
// Demo data (when no backend/seed is available)
// ---------------------------------------------------------------------------

interface AgencyEntry {
  name: string;
  strategy: string;
  agents: string[];
  status: 'idle' | 'running' | 'completed' | 'error';
  lastRun?: string;
  totalRuns: number;
}

const DEMO_AGENCIES: AgencyEntry[] = [
  {
    name: 'research-team',
    strategy: 'graph',
    agents: ['researcher', 'writer', 'illustrator', 'reviewer'],
    status: 'completed',
    lastRun: '2026-03-25T14:30:00.000Z',
    totalRuns: 12,
  },
  {
    name: 'content-pipeline',
    strategy: 'sequential',
    agents: ['researcher', 'writer', 'editor'],
    status: 'idle',
    totalRuns: 47,
  },
  {
    name: 'debate-council',
    strategy: 'debate',
    agents: ['optimist', 'pessimist', 'realist'],
    status: 'idle',
    totalRuns: 8,
  },
];

// ---------------------------------------------------------------------------
// Backend API helpers
// ---------------------------------------------------------------------------

/** @internal Resolve the backend API base URL from environment. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _getBackendBaseUrl(): string {
  const raw =
    process.env.WUNDERLAND_BACKEND_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:3001/api';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function resolveSeedId(
  flags: Record<string, string | boolean>,
): string | undefined {
  const fromFlags =
    typeof flags.seed === 'string'
      ? flags.seed
      : typeof flags['seed-id'] === 'string'
        ? flags['seed-id']
        : undefined;
  const fromEnv = process.env.WUNDERLAND_SEED_ID;
  const seedId = (fromFlags ?? fromEnv)?.trim();
  return seedId ? seedId : undefined;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** `wunderland agency list` — list configured agencies. */
async function cmdList(flags: Record<string, string | boolean>): Promise<void> {
  const seedId = resolveSeedId(flags);
  const isDemo = !seedId;

  // TODO: When backend API is ready, replace DEMO_AGENCIES with a fetch call to
  // `${_getBackendBaseUrl()}/agencies?seedId=${seedId}` for live mode.
  const agencies: AgencyEntry[] = DEMO_AGENCIES;

  if (!isDemo) {
    console.log(dim('  Backend API integration pending — showing demo data'));
  }

  fmt.section('Agencies' + (isDemo ? dim(' (demo)') : ''));

  if (agencies.length === 0) {
    fmt.note('No agencies configured. Use ' + accent('wunderland agency create <name>') + ' to create one.');
    fmt.blank();
    return;
  }

  const strategyColor = (s: string) => {
    if (s === 'graph') return sColor(s);
    if (s === 'hierarchical') return wColor(s);
    return dim(s);
  };

  const statusIcon = (s: string) => {
    if (s === 'running') return sColor(getGlyphs().info);
    if (s === 'completed') return sColor(getGlyphs().ok);
    if (s === 'error') return wColor(getGlyphs().fail);
    return dim(getGlyphs().bullet);
  };

  for (const agency of agencies) {
    console.log(
      `  ${statusIcon(agency.status)} ${bright(agency.name)}  ` +
      `${strategyColor(agency.strategy)}  ` +
      `${dim(agency.agents.length + ' agents')}  ` +
      `${dim(agency.totalRuns + ' runs')}`,
    );
    console.log(`    ${dim('Agents: ' + agency.agents.join(', '))}`);
    if (agency.lastRun) {
      console.log(`    ${dim('Last run: ' + new Date(agency.lastRun).toLocaleString())}`);
    }
  }
  fmt.blank();
}

/** `wunderland agency create <name>` — create a new agency. */
async function cmdCreate(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing name', 'Usage: wunderland agency create <name> [--strategy sequential|graph|parallel|debate|review-loop|hierarchical]');
    process.exitCode = 1;
    return;
  }

  const strategy = typeof flags.strategy === 'string' ? flags.strategy : 'sequential';

  fmt.section(`Create Agency: ${name}`);
  console.log(`  ${dim('Strategy:')} ${accent(strategy)}`);
  console.log();
  fmt.note(
    'To define agents, add an "agency" block to agent.config.json:\n\n' +
    `  ${dim('{')}
    ${dim('"agency": {')}
      ${dim('"name":')} ${accent(`"${name}"`)},
      ${dim('"strategy":')} ${accent(`"${strategy}"`)},
      ${dim('"agents": {')}
        ${dim('"researcher":')} { "instructions": "Find facts." },
        ${dim('"writer":')}     { "instructions": "Write summary.", "dependsOn": ["researcher"] }
      ${dim('}')}
    ${dim('}')}
  ${dim('}')}`,
  );
  fmt.blank();
}

/** `wunderland agency status <name>` — show agency status. */
async function cmdStatus(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing name', 'Usage: wunderland agency status <name>');
    process.exitCode = 1;
    return;
  }

  const agency = DEMO_AGENCIES.find((a) => a.name === name);
  if (!agency) {
    fmt.errorBlock('Not found', `Agency "${name}" not found. Run ${accent('wunderland agency list')} to see available agencies.`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Agency: ${agency.name}`);
  console.log(`  ${dim('Strategy:')}   ${accent(agency.strategy)}`);
  console.log(`  ${dim('Status:')}     ${agency.status === 'completed' ? sColor(agency.status) : dim(agency.status)}`);
  console.log(`  ${dim('Total runs:')} ${bright(String(agency.totalRuns))}`);
  console.log(`  ${dim('Agents:')}`);
  for (const agent of agency.agents) {
    console.log(`    ${dim(getGlyphs().bullet)} ${agent}`);
  }
  if (agency.lastRun) {
    console.log(`  ${dim('Last run:')}   ${new Date(agency.lastRun).toLocaleString()}`);
  }
  fmt.blank();
}

/** `wunderland agency run <name> <prompt>` — execute an agency. */
async function cmdRun(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const name = args[0];
  const prompt = args.slice(1).join(' ');

  if (!name || !prompt) {
    fmt.errorBlock('Missing arguments', 'Usage: wunderland agency run <name> "<prompt>"');
    process.exitCode = 1;
    return;
  }

  fmt.section(`Running Agency: ${name}`);
  console.log(`  ${dim('Prompt:')} ${muted(prompt)}`);
  console.log();

  // Try to load agency config from agent.config.json
  let agencyConfig: Record<string, unknown> | null = null;
  const configPaths = [
    resolve(process.cwd(), 'agent.config.json'),
    resolve(process.cwd(), '.wunderland', 'agent.config.json'),
  ];

  for (const p of configPaths) {
    try {
      const raw = await readFile(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.agency) {
        agencyConfig = parsed.agency;
        fmt.note(`Loaded agency config from ${dim(p)}`);
        break;
      }
    } catch {
      // Not found, try next
    }
  }

  if (!agencyConfig) {
    fmt.note(
      'No agency config found. Create agent.config.json with an "agency" block,\n' +
      'or use the AgentOS SDK directly:\n\n' +
      `  ${dim('import { agency } from "@framers/agentos";')}\n` +
      `  ${dim('const team = agency({ strategy: "graph", agents: { ... } });')}\n` +
      `  ${dim('const result = await team.generate("' + prompt.slice(0, 40) + '...");')}`,
    );
    fmt.blank();
    return;
  }

  // Dynamic import of agentos agency()
  try {
    const { agency } = await import('@framers/agentos');

    const team = (agency as Function)({
      provider: process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai',
      ...agencyConfig,
    });

    const stream = typeof flags.stream !== 'undefined';

    if (stream) {
      const result = (team as any).stream(prompt);
      if (result?.fullStream) {
        for await (const part of result.fullStream as AsyncIterable<{ type: string; agent?: string; text?: string; output?: string }>) {
          if (part.type === 'agent-start' && part.agent !== '__agency__') {
            console.log(`\n  ${sColor(getGlyphs().info)} ${bright(part.agent!)} started`);
          } else if (part.type === 'text') {
            process.stdout.write(part.text!);
          } else if (part.type === 'agent-end' && part.agent !== '__agency__') {
            console.log(`\n  ${sColor(getGlyphs().ok)} ${bright(part.agent!)} done`);
          }
        }
      }
    } else {
      const result = await (team as any).generate(prompt) as Record<string, unknown>;
      const text = (result.text as string) ?? '';
      const agentCalls = (result.agentCalls as Array<{ agent: string; durationMs: number }>) ?? [];

      console.log(text);
      console.log();

      if (agentCalls.length > 0) {
        fmt.section('Agent Calls');
        for (const call of agentCalls) {
          console.log(`  ${sColor(getGlyphs().ok)} ${bright(call.agent)} ${dim(`(${call.durationMs}ms)`)}`);
        }
      }
    }

    if (typeof (team as any).close === 'function') {
      await (team as any).close();
    }
  } catch (err) {
    fmt.errorBlock('Agency Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }

  fmt.blank();
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export default async function cmdAgency(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland agency');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('list')}                   List configured agencies
    ${dim('create <name>')}          Create a multi-agent agency
    ${dim('status <name>')}          Show agency status and agents
    ${dim('run <name> "<prompt>"')}  Execute an agency against a prompt
    ${dim('add-seat <agency> <agent>')}  Add agent to agency
    ${dim('handoff <from> <to>')}    Trigger agent handoff

  ${accent('Flags:')}
    ${dim('--strategy <name>')}    Strategy: sequential | parallel | graph | debate | review-loop | hierarchical
    ${dim('--seed <id>')}          Agent seed ID for backend queries
    ${dim('--stream')}             Stream output with agent events
    ${dim('--format json|table')}  Output format

  ${accent('Examples:')}
    ${dim('wunderland agency list')}
    ${dim('wunderland agency create research-team --strategy graph')}
    ${dim('wunderland agency run research-team "Summarize recent AI safety papers"')}
    ${dim('wunderland agency run research-team "Write a report on fusion energy" --stream')}
`);
    return;
  }

  try {
    if (sub === 'list') await cmdList(flags);
    else if (sub === 'create') await cmdCreate(args.slice(1), flags);
    else if (sub === 'status') await cmdStatus(args.slice(1));
    else if (sub === 'run') await cmdRun(args.slice(1), flags);
    else if (sub === 'add-seat') {
      fmt.note('Agency seat management requires a running backend.');
    } else if (sub === 'handoff') {
      fmt.note('Agent handoff requires a running agency. See ' + accent('wunderland agency create') + '.');
    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland agency')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Agency Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
