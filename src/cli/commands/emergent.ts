/**
 * @fileoverview `wunderland emergent` — manage emergent (runtime-forged) tools.
 * @module wunderland/cli/commands/emergent
 *
 * Live mode:
 * - Uses the Wunderland backend API when `--seed` is provided.
 * - Supports JWT-authenticated backends or local/internal access via
 *   `INTERNAL_API_SECRET` / `WUNDERLAND_INTERNAL_API_SECRET`.
 *
 * Preview mode:
 * - Falls back to demo data when no seed/backend is configured.
 * - Keeps the command browsable even for local preview users.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { GlobalFlags } from '../types.js';
import {
  accent,
  bright,
  dim,
  muted,
  success as sColor,
  warn as wColor,
  error as eColor,
} from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';

interface EmergentToolEntry {
  id: string;
  name: string;
  tier: 'session' | 'agent' | 'shared';
  totalUses: number;
  confidenceScore: number;
  implementationMode: 'compose' | 'sandbox';
  description: string;
  createdByAgent: string;
  createdAt: string;
  implementationSource?: string;
  implementationSourcePersisted?: boolean;
  judgeVerdicts?: unknown[];
  isActive?: boolean;
}

interface EmergentAuditEntry {
  id: string;
  toolId: string;
  eventType: string;
  eventData: unknown;
  timestamp: string;
}

interface EmergentToolExportResult {
  fileName: string;
  format: 'yaml' | 'json';
  portable: boolean;
  warnings: string[];
  content: string;
}

const DEMO_TOOLS: EmergentToolEntry[] = [
  {
    id: 'emergent:demo-1',
    name: 'fetch_github_pr_summary',
    tier: 'agent',
    totalUses: 12,
    confidenceScore: 0.87,
    implementationMode: 'compose',
    description:
      'Fetches open PRs from GitHub and summarizes each with title + diff stats.',
    createdByAgent: 'agent-research-01',
    createdAt: '2026-03-20T14:30:00.000Z',
    implementationSource: 'forged by agent-research-01 during session sess-a1b2',
    isActive: true,
  },
  {
    id: 'emergent:demo-2',
    name: 'csv_column_stats',
    tier: 'shared',
    totalUses: 47,
    confidenceScore: 0.94,
    implementationMode: 'sandbox',
    description:
      'Computes min, max, mean, and percentile stats on a CSV column.',
    createdByAgent: 'agent-analytics-02',
    createdAt: '2026-03-15T09:00:00.000Z',
    implementationSource: 'forged by agent-analytics-02 during session sess-c3d4',
    isActive: true,
  },
  {
    id: 'emergent:demo-3',
    name: 'jira_ticket_triage',
    tier: 'session',
    totalUses: 3,
    confidenceScore: 0.72,
    implementationMode: 'compose',
    description:
      'Reads a JIRA ticket by key and classifies priority based on keywords.',
    createdByAgent: 'agent-ops-03',
    createdAt: '2026-03-24T11:15:00.000Z',
    implementationSource: 'forged by agent-ops-03 during session sess-e5f6',
    isActive: true,
  },
];

function getBackendBaseUrl(): string {
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

async function emergentFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const internalSecret =
    process.env.WUNDERLAND_INTERNAL_API_SECRET ??
    process.env.INTERNAL_API_SECRET;
  const authToken =
    process.env.WUNDERLAND_AUTH_TOKEN ??
    process.env.AUTH_TOKEN;
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  } else if (internalSecret) {
    headers['x-internal-secret'] = internalSecret;
  }
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${getBackendBaseUrl()}/wunderland/emergent${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }

  return res.json() as Promise<T>;
}

async function loadLiveTools(
  seedId: string,
  tier?: string,
): Promise<EmergentToolEntry[]> {
  const query = new URLSearchParams();
  query.set('seedId', seedId);
  if (tier) query.set('tier', tier);
  const result = await emergentFetch<{ tools: EmergentToolEntry[] }>(
    `/tools?${query.toString()}`,
  );
  return result.tools;
}

async function findLiveTool(
  seedId: string,
  idOrName: string,
): Promise<EmergentToolEntry | undefined> {
  const tools = await loadLiveTools(seedId);
  return tools.find((tool) => tool.id === idOrName || tool.name === idOrName);
}

function renderToolsTable(tools: EmergentToolEntry[]): void {
  const g = glyphs();
  console.log(
    `    ${muted('Tier'.padEnd(10))}${muted('Name'.padEnd(30))}${muted('Uses'.padEnd(8))}${muted('Confidence'.padEnd(14))}${muted('Mode')}`,
  );
  console.log(`    ${dim(g.hr.repeat(70))}`);

  for (const tool of tools) {
    const tierColor =
      tool.tier === 'shared' ? sColor : tool.tier === 'agent' ? wColor : muted;
    const confPct = `${Math.round(tool.confidenceScore * 100)}%`;
    const confColor =
      tool.confidenceScore >= 0.8
        ? sColor
        : tool.confidenceScore >= 0.6
          ? wColor
          : eColor;
    console.log(
      `    ${tierColor(tool.tier.padEnd(10))}${accent(tool.name.padEnd(30))}${String(tool.totalUses).padEnd(8)}${confColor(confPct.padEnd(14))}${dim(tool.implementationMode)}`,
    );
  }
}

async function listEmergent(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const seedId = resolveSeedId(flags);
  fmt.section('Emergent Tools');
  fmt.blank();

  if (!seedId) {
    renderToolsTable(DEMO_TOOLS);
    fmt.blank();
    fmt.note(
      `Preview mode. Pass ${accent('--seed <seedId>')} to query live emergent tools from the backend.`,
    );
    fmt.blank();
    return;
  }

  try {
    const tier =
      typeof flags.tier === 'string' && flags.tier.trim()
        ? flags.tier.trim()
        : undefined;
    const tools = await loadLiveTools(seedId, tier);
    if (tools.length === 0) {
      fmt.note(`No emergent tools found for ${accent(seedId)}.`);
      fmt.blank();
      return;
    }
    renderToolsTable(tools);
    fmt.blank();
    fmt.note(`Seed: ${accent(seedId)}`);
    fmt.blank();
  } catch (error: unknown) {
    fmt.warning(
      `Live lookup failed. Falling back to preview data. ${dim(error instanceof Error ? error.message : String(error))}`,
    );
    fmt.blank();
    renderToolsTable(DEMO_TOOLS);
    fmt.blank();
  }
}

async function inspectEmergent(
  id: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent inspect <name|id> [--seed <seedId>]');
    process.exitCode = 1;
    return;
  }

  const seedId = resolveSeedId(flags);
  const liveTool = seedId ? await findLiveTool(seedId, id).catch(() => undefined) : undefined;
  const tool = liveTool ?? DEMO_TOOLS.find((t) => t.name === id || t.id === id);

  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool matching "${id}".`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Emergent Tool: ${tool.name}`);
  fmt.kvPair('ID', dim(tool.id));
  fmt.kvPair('Tier', tool.tier);
  fmt.kvPair('Mode', tool.implementationMode);
  fmt.kvPair('Description', tool.description);
  fmt.kvPair('Created By', tool.createdByAgent);
  fmt.kvPair('Created At', tool.createdAt);
  fmt.kvPair('Uses', String(tool.totalUses));
  fmt.kvPair('Confidence', `${Math.round(tool.confidenceScore * 100)}%`);
  fmt.kvPair('Active', tool.isActive === false ? eColor('no') : sColor('yes'));
  if (tool.implementationMode === 'sandbox' && tool.implementationSourcePersisted === false) {
    fmt.kvPair('Source', dim('[sandbox source redacted at rest]'));
  } else if (tool.implementationSource) {
    fmt.kvPair('Source', dim(tool.implementationSource));
  }
  fmt.blank();

  if (!liveTool) {
    fmt.note(
      `Preview mode. Pass ${accent('--seed <seedId>')} for live inspect output including backend audit data.`,
    );
    fmt.blank();
  }
}

async function promoteEmergent(
  id: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent promote <name|id> --seed <seedId>');
    process.exitCode = 1;
    return;
  }

  const seedId = resolveSeedId(flags);
  if (!seedId) {
    fmt.warning(`Preview mode only. Pass ${accent('--seed <seedId>')} to promote a real emergent tool.`);
    fmt.blank();
    return;
  }

  const tool = await findLiveTool(seedId, id).catch(() => undefined);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool matching "${id}" for ${seedId}.`);
    process.exitCode = 1;
    return;
  }

  if (tool.implementationMode === 'sandbox' && tool.implementationSourcePersisted === false) {
    fmt.errorBlock(
      'Shared promotion blocked',
      'Sandbox source is redacted at rest. Enable sandbox source persistence first if this tool needs shared promotion and live runtime rehydration.',
    );
    process.exitCode = 1;
    return;
  }

  const result = await emergentFetch<{ tool: EmergentToolEntry }>(
    `/tools/${encodeURIComponent(tool.id)}/promote?${new URLSearchParams({ seedId }).toString()}`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );

  fmt.section(`Promoted: ${result.tool.name}`);
  fmt.kvPair('Tier', result.tool.tier);
  fmt.kvPair('Seed', seedId);
  fmt.blank();
}

async function demoteEmergent(
  id: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent demote <name|id> --seed <seedId>');
    process.exitCode = 1;
    return;
  }

  const seedId = resolveSeedId(flags);
  if (!seedId) {
    fmt.warning(`Preview mode only. Pass ${accent('--seed <seedId>')} to demote a real emergent tool.`);
    fmt.blank();
    return;
  }

  const tool = await findLiveTool(seedId, id).catch(() => undefined);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool matching "${id}" for ${seedId}.`);
    process.exitCode = 1;
    return;
  }

  await emergentFetch<{ ok: true }>(
    `/tools/${encodeURIComponent(tool.id)}/demote?${new URLSearchParams({ seedId }).toString()}`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );

  fmt.section(`Demoted: ${tool.name}`);
  fmt.kvPair('Seed', seedId);
  fmt.kvPair('Status', eColor('inactive'));
  fmt.blank();
}

async function auditEmergent(
  id: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const g = glyphs();

  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent audit <name|id> [--seed <seedId>]');
    process.exitCode = 1;
    return;
  }

  const seedId = resolveSeedId(flags);
  if (!seedId) {
    fmt.section(`Audit Trail: ${id}`);
    fmt.blank();
    fmt.note(
      `Preview mode. Pass ${accent('--seed <seedId>')} to load the live audit trail from the backend.`,
    );
    fmt.blank();
    return;
  }

  const tool = await findLiveTool(seedId, id).catch(() => undefined);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool matching "${id}" for ${seedId}.`);
    process.exitCode = 1;
    return;
  }

  const result = await emergentFetch<{ entries: EmergentAuditEntry[] }>(
    `/tools/${encodeURIComponent(tool.id)}/audit?${new URLSearchParams({ seedId }).toString()}`,
  );

  fmt.section(`Audit Trail: ${tool.name}`);
  fmt.blank();

  console.log(
    `    ${dim('Timestamp'.padEnd(28))}${dim('Event'.padEnd(22))}${dim('Details')}`,
  );
  console.log(`    ${dim(g.hr.repeat(70))}`);

  for (const entry of result.entries) {
    const details =
      entry.eventData == null
        ? ''
        : typeof entry.eventData === 'string'
          ? entry.eventData
          : JSON.stringify(entry.eventData);
    console.log(
      `    ${muted(entry.timestamp.padEnd(28))}${accent(entry.eventType.padEnd(22))}${dim(details)}`,
    );
  }

  fmt.blank();
}

async function exportEmergent(
  id: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!id) {
    fmt.errorBlock('Missing tool name', 'Usage: wunderland emergent export <name|id> --seed <seedId> [--output <path>] [--format yaml|json]');
    process.exitCode = 1;
    return;
  }

  const seedId = resolveSeedId(flags);
  if (!seedId) {
    fmt.warning(`Preview mode only. Pass ${accent('--seed <seedId>')} to export a real emergent tool package.`);
    fmt.blank();
    return;
  }

  const tool = await findLiveTool(seedId, id).catch(() => undefined);
  if (!tool) {
    fmt.errorBlock('Tool not found', `No emergent tool matching "${id}" for ${seedId}.`);
    process.exitCode = 1;
    return;
  }

  const format =
    typeof flags.format === 'string' && flags.format.trim().toLowerCase() === 'json'
      ? 'json'
      : 'yaml';
  const result = await emergentFetch<EmergentToolExportResult>(
    `/tools/${encodeURIComponent(tool.id)}/export?${new URLSearchParams({ seedId, format }).toString()}`,
  );

  const outputPath =
    typeof flags.output === 'string' && flags.output.trim()
      ? resolve(process.cwd(), flags.output)
      : resolve(process.cwd(), result.fileName);

  await writeFile(outputPath, result.content, 'utf-8');

  fmt.section(`Exported: ${tool.name}`);
  fmt.kvPair('File', outputPath);
  fmt.kvPair('Portable', result.portable ? sColor('yes') : wColor('partial'));
  if (result.warnings.length > 0) {
    fmt.kvPair('Warning', result.warnings[0]!);
  }
  fmt.blank();
}

async function importEmergent(
  target: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!target) {
    fmt.errorBlock('Missing package path', 'Usage: wunderland emergent import <package.yaml> --seed <seedId>');
    process.exitCode = 1;
    return;
  }

  const seedId = resolveSeedId(flags);
  if (!seedId) {
    fmt.errorBlock('Missing seed', 'Import requires --seed <seedId> so the package can be attached to a target agent.');
    process.exitCode = 1;
    return;
  }

  const packagePath = resolve(process.cwd(), target);
  const content = await readFile(packagePath, 'utf-8');
  const result = await emergentFetch<{
    tool: EmergentToolEntry;
    portable: boolean;
    warnings: string[];
  }>(
    `/tools/import?${new URLSearchParams({ seedId }).toString()}`,
    {
      method: 'POST',
      body: JSON.stringify({ content }),
    },
  );

  fmt.section(`Imported: ${result.tool.name}`);
  fmt.kvPair('Seed', seedId);
  fmt.kvPair('Tier', result.tool.tier);
  fmt.kvPair('Tool ID', dim(result.tool.id));
  if (result.warnings.length > 0) {
    fmt.kvPair('Warning', result.warnings[0]!);
  }
  fmt.blank();
}

function showEmergentHelp(): void {
  const d = dim;
  const w = bright;

  fmt.section('Emergent Tools — Runtime-Forged Capabilities');
  fmt.blank();
  console.log(`    ${w('Usage:')} wunderland emergent <subcommand> [options]`);
  fmt.blank();
  console.log(`    ${w('Subcommands:')}`);
  console.log(`      ${accent('list')}                   ${d('List emergent tools (live with --seed, otherwise preview)')}`);
  console.log(`      ${accent('inspect')} ${d('<name|id>')}      ${d('Show full details for one tool')}`);
  console.log(`      ${accent('export')}  ${d('<name|id>')}      ${d('Export a Git-friendly emergent-tool package')}`);
  console.log(`      ${accent('import')}  ${d('<file>')}         ${d('Import an emergent-tool package into an agent')}`);
  console.log(`      ${accent('promote')} ${d('<name|id>')}      ${d('Promote a tool to shared tier (requires --seed)')}`);
  console.log(`      ${accent('demote')}  ${d('<name|id>')}      ${d('Deactivate a tool (requires --seed)')}`);
  console.log(`      ${accent('audit')}   ${d('<name|id>')}      ${d('Show audit trail for a tool')}`);
  fmt.blank();
  console.log(`    ${w('Options:')}`);
  console.log(`      ${accent('--seed <seedId>')}       ${d('Agent seed to query/manage live tools')}`);
  console.log(`      ${accent('--tier <tier>')}         ${d('Optional filter for list: session|agent|shared')}`);
  console.log(`      ${accent('--output <path>')}       ${d('Output file path for export (default: ./<name>.emergent-tool.yaml)')}`);
  console.log(`      ${accent('--format yaml|json')}    ${d('Export package format (default: yaml)')}`);
  fmt.blank();
  console.log(`    ${w('Environment:')}`);
  console.log(`      ${accent('WUNDERLAND_BACKEND_URL')}    ${d('Backend base URL (default: http://localhost:3001/api)')}`);
  console.log(`      ${accent('WUNDERLAND_SEED_ID')}        ${d('Default seed for live commands')}`);
  console.log(`      ${accent('WUNDERLAND_AUTH_TOKEN')}     ${d('Optional Bearer token for authenticated backends')}`);
  console.log(`      ${accent('WUNDERLAND_INTERNAL_API_SECRET')} ${d('Optional internal auth for local backends')}`);
  fmt.blank();
}

export default async function cmdEmergent(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'list':
      return listEmergent(flags);
    case 'inspect':
      return inspectEmergent(args[1], flags);
    case 'export':
      return exportEmergent(args[1], flags);
    case 'import':
      return importEmergent(args[1], flags);
    case 'promote':
      return promoteEmergent(args[1], flags);
    case 'demote':
      return demoteEmergent(args[1], flags);
    case 'audit':
      return auditEmergent(args[1], flags);
    default:
      return showEmergentHelp();
  }
}
