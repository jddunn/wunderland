/**
 * @fileoverview `wunderland emergent` — manage emergent (runtime-forged) tools.
 * @module wunderland/cli/commands/emergent
 *
 * Subcommands:
 *   list              List all emergent tools (tier, name, uses, confidence)
 *   inspect <id>      Show full details (source, verdicts, usage stats)
 *   promote <id>      Promote tool to shared tier (Y/N confirmation)
 *   demote <id>       Deactivate/demote a tool
 *   audit <id>        Show audit trail (judge verdicts + promotion history)
 *
 * V1: Command structure with placeholder data/messages. Actual data will come
 * from the backend API in a future task.
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor, warn as wColor, error as eColor, bright } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';

// ── Placeholder data ────────────────────────────────────────────────────────

/**
 * Placeholder emergent tool record for v1 display purposes.
 * Will be replaced by live API data in Plan 3 Task 4.
 */
interface EmergentToolEntry {
  /** Machine-readable name. */
  name: string;
  /** Current lifecycle tier: session, agent, or shared. */
  tier: 'session' | 'agent' | 'shared';
  /** Total invocation count. */
  uses: number;
  /** Aggregate confidence score [0, 1]. */
  confidence: number;
  /** Implementation mode. */
  mode: 'compose' | 'sandbox';
  /** Tool description. */
  description: string;
  /** Creator identifier. */
  createdBy: string;
  /** ISO creation timestamp. */
  createdAt: string;
  /** Source label. */
  source: string;
}

/**
 * Static demo entries used when no agent is connected.
 * Provides a realistic preview of the output format.
 */
const DEMO_TOOLS: EmergentToolEntry[] = [
  {
    name: 'fetch_github_pr_summary',
    tier: 'agent',
    uses: 12,
    confidence: 0.87,
    mode: 'compose',
    description: 'Fetches open PRs from GitHub and summarizes each with title + diff stats.',
    createdBy: 'agent-research-01',
    createdAt: '2026-03-20T14:30:00.000Z',
    source: 'forged by agent-research-01 during session sess-a1b2',
  },
  {
    name: 'csv_column_stats',
    tier: 'shared',
    uses: 47,
    confidence: 0.94,
    mode: 'sandbox',
    description: 'Computes min, max, mean, and percentile stats on a CSV column.',
    createdBy: 'agent-analytics-02',
    createdAt: '2026-03-15T09:00:00.000Z',
    source: 'forged by agent-analytics-02 during session sess-c3d4',
  },
  {
    name: 'jira_ticket_triage',
    tier: 'session',
    uses: 3,
    confidence: 0.72,
    mode: 'compose',
    description: 'Reads a JIRA ticket by key and classifies priority based on keywords.',
    createdBy: 'agent-ops-03',
    createdAt: '2026-03-24T11:15:00.000Z',
    source: 'forged by agent-ops-03 during session sess-e5f6',
  },
];

// ── Subcommands ─────────────────────────────────────────────────────────────

/**
 * List all emergent tools with tier, name, uses, and confidence.
 */
function listEmergent(): void {
  const g = glyphs();
  fmt.section('Emergent Tools');
  fmt.blank();

  if (DEMO_TOOLS.length === 0) {
    fmt.note('No emergent tools registered.');
    fmt.note(`Enable emergent mode: set ${accent('"emergent": true')} in agent.config.json`);
    fmt.blank();
    return;
  }

  // Header
  console.log(
    `    ${muted('Tier'.padEnd(10))}${muted('Name'.padEnd(30))}${muted('Uses'.padEnd(8))}${muted('Confidence'.padEnd(14))}${muted('Mode')}`,
  );
  console.log(`    ${dim(g.hr.repeat(70))}`);

  for (const tool of DEMO_TOOLS) {
    const tierColor = tool.tier === 'shared' ? sColor : tool.tier === 'agent' ? wColor : muted;
    const confPct = `${Math.round(tool.confidence * 100)}%`;
    const confColor = tool.confidence >= 0.8 ? sColor : tool.confidence >= 0.6 ? wColor : eColor;
    console.log(
      `    ${tierColor(tool.tier.padEnd(10))}${accent(tool.name.padEnd(30))}${String(tool.uses).padEnd(8)}${confColor(confPct.padEnd(14))}${dim(tool.mode)}`,
    );
  }

  fmt.blank();
  fmt.note(`Total: ${DEMO_TOOLS.length} emergent tools`);
  fmt.note(`Inspect: ${accent('wunderland emergent inspect <name>')}`);
  fmt.note(`Promote: ${accent('wunderland emergent promote <name>')}`);
  fmt.blank();

  showDemoNotice();
}

/**
 * Show full details for a specific emergent tool.
 *
 * @param id - The tool name or ID to inspect.
 */
function inspectEmergent(id: string | undefined): void {
  const g = glyphs();

  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent inspect <name>');
    process.exitCode = 1;
    return;
  }

  const tool = DEMO_TOOLS.find((t) => t.name === id);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool named "${id}".\nRun ${accent('wunderland emergent list')} to see all tools.`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Emergent Tool: ${tool.name}`);
  fmt.kvPair('Name', accent(tool.name));
  fmt.kvPair('Tier', tool.tier);
  fmt.kvPair('Mode', tool.mode);
  fmt.kvPair('Description', tool.description);
  fmt.kvPair('Created By', tool.createdBy);
  fmt.kvPair('Created At', tool.createdAt);
  fmt.kvPair('Source', dim(tool.source));
  fmt.blank();

  fmt.note(bright('Usage Stats'));
  fmt.kvPair('  Total Uses', String(tool.uses));
  fmt.kvPair('  Confidence', `${Math.round(tool.confidence * 100)}%`);
  fmt.blank();

  fmt.note(bright('Judge Verdicts'));
  fmt.kvPair('  Creation', `${sColor(g.ok)} Approved (confidence: ${Math.round(tool.confidence * 100)}%)`);
  if (tool.tier === 'shared') {
    fmt.kvPair('  Promotion', `${sColor(g.ok)} Approved (safety + correctness reviewers)`);
  } else {
    fmt.kvPair('  Promotion', `${muted(g.circle)} Not yet promoted`);
  }
  fmt.blank();

  showDemoNotice();
}

/**
 * Promote a tool to shared tier (with confirmation).
 *
 * @param id - The tool name or ID to promote.
 */
async function promoteEmergent(id: string | undefined): Promise<void> {
  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent promote <name>');
    process.exitCode = 1;
    return;
  }

  const tool = DEMO_TOOLS.find((t) => t.name === id);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool named "${id}".`);
    process.exitCode = 1;
    return;
  }

  if (tool.tier === 'shared') {
    fmt.warning(`Tool "${id}" is already at shared tier.`);
    return;
  }

  if (tool.tier === 'session') {
    fmt.warning(`Session-tier tools must be promoted to agent tier first.`);
    fmt.note('Session tools are ephemeral and must accumulate usage before promotion.');
    return;
  }

  fmt.section(`Promote: ${tool.name}`);
  fmt.kvPair('Current Tier', tool.tier);
  fmt.kvPair('Target Tier', 'shared');
  fmt.kvPair('Uses', String(tool.uses));
  fmt.kvPair('Confidence', `${Math.round(tool.confidence * 100)}%`);
  fmt.blank();

  fmt.warning('Promotion to shared tier requires multi-reviewer approval (safety + correctness).');
  fmt.note('This is a placeholder — actual promotion will call the backend API.');
  fmt.blank();

  showDemoNotice();
}

/**
 * Deactivate / demote an emergent tool.
 *
 * @param id - The tool name or ID to demote.
 */
function demoteEmergent(id: string | undefined): void {
  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent demote <name>');
    process.exitCode = 1;
    return;
  }

  const tool = DEMO_TOOLS.find((t) => t.name === id);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool named "${id}".`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Demote: ${tool.name}`);
  fmt.kvPair('Current Tier', tool.tier);
  fmt.kvPair('Action', 'Deactivate');
  fmt.blank();

  fmt.warning('This is a placeholder — actual demotion will call the backend API.');
  fmt.note(`The tool will be removed from the active registry and marked as deactivated.`);
  fmt.blank();

  showDemoNotice();
}

/**
 * Show audit trail for an emergent tool (judge verdicts + promotion history).
 *
 * @param id - The tool name or ID to audit.
 */
function auditEmergent(id: string | undefined): void {
  const g = glyphs();

  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent audit <name>');
    process.exitCode = 1;
    return;
  }

  const tool = DEMO_TOOLS.find((t) => t.name === id);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool named "${id}".`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Audit Trail: ${tool.name}`);
  fmt.blank();

  // Simulated audit entries
  console.log(`    ${dim('Timestamp'.padEnd(28))}${dim('Event'.padEnd(22))}${dim('Details')}`);
  console.log(`    ${dim(g.hr.repeat(70))}`);

  console.log(
    `    ${muted(tool.createdAt.padEnd(28))}${accent('FORGED'.padEnd(22))}${dim(`by ${tool.createdBy}, mode: ${tool.mode}`)}`,
  );
  console.log(
    `    ${muted(tool.createdAt.padEnd(28))}${sColor('JUDGE_APPROVED'.padEnd(22))}${dim(`confidence: ${Math.round(tool.confidence * 100)}%, safety: 0.91`)}`,
  );

  if (tool.tier === 'agent' || tool.tier === 'shared') {
    console.log(
      `    ${muted(tool.createdAt.padEnd(28))}${wColor('PROMOTED'.padEnd(22))}${dim('session -> agent')}`,
    );
  }

  if (tool.tier === 'shared') {
    console.log(
      `    ${muted(tool.createdAt.padEnd(28))}${sColor('PROMOTION_APPROVED'.padEnd(22))}${dim('safety auditor + correctness reviewer')}`,
    );
    console.log(
      `    ${muted(tool.createdAt.padEnd(28))}${wColor('PROMOTED'.padEnd(22))}${dim('agent -> shared')}`,
    );
  }

  fmt.blank();

  showDemoNotice();
}

/**
 * Print help for the emergent subcommands.
 */
function showEmergentHelp(): void {
  const d = dim;
  const w = bright;

  fmt.section('Emergent Tools — Runtime-Forged Capabilities');
  fmt.blank();
  console.log(`    ${w('Usage:')} wunderland emergent <subcommand> [options]`);
  fmt.blank();
  console.log(`    ${w('Subcommands:')}`);
  console.log(`      ${accent('list')}                   ${d('List all emergent tools (tier, name, uses, confidence)')}`);
  console.log(`      ${accent('inspect')} ${d('<name>')}         ${d('Show full details (source, verdicts, usage stats)')}`);
  console.log(`      ${accent('promote')} ${d('<name>')}         ${d('Promote to shared tier (Y/N confirmation)')}`);
  console.log(`      ${accent('demote')}  ${d('<name>')}         ${d('Deactivate / demote a tool')}`);
  console.log(`      ${accent('audit')}   ${d('<name>')}         ${d('Show audit trail (judge verdicts + promotion history)')}`);
  fmt.blank();
  console.log(`    ${w('Examples:')}`);
  console.log(`      ${d('$')} ${accent('wunderland emergent list')}`);
  console.log(`      ${d('$')} ${accent('wunderland emergent inspect fetch_github_pr_summary')}`);
  console.log(`      ${d('$')} ${accent('wunderland emergent promote fetch_github_pr_summary')}`);
  console.log(`      ${d('$')} ${accent('wunderland emergent audit csv_column_stats')}`);
  fmt.blank();
  console.log(`    ${w('Learn more:')}`);
  console.log(`      ${d('$')} ${accent('wunderland help emergent')}`);
  fmt.blank();
}

/**
 * Show a notice that the displayed data is placeholder / demo data.
 */
function showDemoNotice(): void {
  fmt.note(dim('Data shown is demo/placeholder. Connect a running agent for live data.'));
  fmt.blank();
}

// ── Command handler ─────────────────────────────────────────────────────────

/**
 * Command handler for `wunderland emergent <subcommand>`.
 *
 * Routes to the appropriate subcommand handler. Defaults to the help screen
 * when no subcommand is provided.
 *
 * @param args - Positional arguments after `emergent`.
 * @param flags - Named flags from the CLI parser.
 * @param _globals - Global CLI flags (unused in v1).
 */
export default async function cmdEmergent(
  args: string[],
  _flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'list':
      return listEmergent();
    case 'inspect':
      return inspectEmergent(args[1]);
    case 'promote':
      return promoteEmergent(args[1]);
    case 'demote':
      return demoteEmergent(args[1]);
    case 'audit':
      return auditEmergent(args[1]);
    default:
      return showEmergentHelp();
  }
}
