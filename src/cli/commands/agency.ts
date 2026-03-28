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

import { existsSync } from 'node:fs';
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
} from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs as getGlyphs } from '../ui/glyphs.js';
import { loadDotEnvIntoProcessUpward, mergeEnv } from '../config/env-manager.js';
import { runInitLlmStep } from '../wizards/init-llm-step.js';
import { openaiChatWithTools, type LLMProviderConfig } from '../openai/tool-calling.js';

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
export function _getBackendBaseUrl(): string {
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

async function loadAgencies(
  flags: Record<string, string | boolean>,
): Promise<{ agencies: AgencyEntry[]; isDemo: boolean }> {
  const seedId = resolveSeedId(flags);
  if (!seedId) {
    return { agencies: DEMO_AGENCIES, isDemo: true };
  }

  try {
    const res = await fetch(
      `${_getBackendBaseUrl()}/agencies?seedId=${encodeURIComponent(seedId)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { agencies?: AgencyEntry[] };
      return {
        agencies: Array.isArray(data.agencies) ? data.agencies : [],
        isDemo: false,
      };
    }
  } catch {
    // Backend unavailable — fall back to demo data
  }

  return { agencies: DEMO_AGENCIES, isDemo: true };
}

// ---------------------------------------------------------------------------
// NL agency extraction
// ---------------------------------------------------------------------------

/**
 * Extracted agency configuration from a natural language description.
 * Returned by `extractAgencyConfig()`.
 */
export interface ExtractedAgencyConfig {
  /** Human-friendly name for the agency. */
  name: string;
  /** Orchestration strategy. */
  strategy: 'sequential' | 'parallel' | 'graph' | 'debate' | 'review-loop' | 'hierarchical';
  /** Shared goals the agents work towards. */
  sharedGoals?: string[];
  /** Named agents with their roles and instructions. */
  agents: Record<string, {
    instructions: string;
    role?: string;
    dependsOn?: string[];
  }>;
}

/** System prompt sent to the LLM for agency configuration extraction. */
const AGENCY_EXTRACTION_PROMPT = `You are an AI configuration expert. Generate an "agency" configuration block from the user's natural language description of a multi-agent team.

**Available strategies:**
- sequential: Agents run one after another in order
- parallel: All agents run at the same time
- graph: Agents form a DAG with dependsOn edges
- debate: Agents argue different viewpoints, then a moderator synthesizes
- review-loop: One agent drafts, another reviews, iterates until approved
- hierarchical: A manager delegates tasks to subordinate agents

**Output JSON schema:**
{
  "name": "string — agency name (kebab-case)",
  "strategy": "sequential | parallel | graph | debate | review-loop | hierarchical",
  "sharedGoals": ["string — optional shared goals"],
  "agents": {
    "<agent-name>": {
      "instructions": "What this agent does",
      "role": "optional role label (researcher, writer, reviewer, etc.)",
      "dependsOn": ["optional — other agent names this agent waits for (graph strategy)"]
    }
  }
}

**Instructions:**
1. Respond ONLY with valid JSON matching the schema above.
2. Choose the strategy that best fits the described workflow.
3. Give each agent a descriptive kebab-case name and clear instructions.
4. For graph strategy, set dependsOn edges to express the workflow order.
5. Include sharedGoals when the user mentions team-level objectives.
6. Use 2-6 agents unless the user specifies otherwise.

**User description:** {{DESCRIPTION}}`;

/**
 * Extract an agency configuration from a natural language description.
 *
 * Sends the description to an LLM with a structured prompt, parses the
 * resulting JSON, and returns a validated `ExtractedAgencyConfig`.
 *
 * @param description - Plain-English description of the desired agency
 * @param llmInvoker  - Function that sends a prompt string and returns the LLM text response
 * @returns Validated agency configuration
 *
 * @throws {Error} If the description is empty or the LLM returns invalid output
 *
 * @example
 * ```typescript
 * const cfg = await extractAgencyConfig(
 *   "research team with a researcher, analyst, and writer",
 *   async (prompt) => openai.complete(prompt),
 * );
 * // cfg.name === "research-team"
 * // cfg.strategy === "graph"
 * // Object.keys(cfg.agents) === ["researcher", "analyst", "writer"]
 * ```
 */
export async function extractAgencyConfig(
  description: string,
  llmInvoker: (prompt: string) => Promise<string>,
): Promise<ExtractedAgencyConfig> {
  if (!description.trim()) {
    throw new Error('Agency description cannot be empty');
  }

  const prompt = AGENCY_EXTRACTION_PROMPT.replace('{{DESCRIPTION}}', description);
  const response = await llmInvoker(prompt);

  // Parse JSON from LLM response (handles code fences, leading text)
  const text = String(response ?? '').trim();
  if (!text) throw new Error('LLM returned an empty response');

  let parsed: ExtractedAgencyConfig | undefined;

  // Direct JSON
  try { parsed = JSON.parse(text); } catch { /* continue */ }

  // Fenced code block
  if (!parsed) {
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
    if (fenceMatch?.[1]) {
      try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
    }
  }

  // First {...} span
  if (!parsed) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { parsed = JSON.parse(text.slice(first, last + 1)); } catch { /* fall through */ }
    }
  }

  if (!parsed) throw new Error('LLM did not return valid JSON for agency config');

  // Validate strategy
  const validStrategies = ['sequential', 'parallel', 'graph', 'debate', 'review-loop', 'hierarchical'] as const;
  if (!validStrategies.includes(parsed.strategy as any)) {
    parsed.strategy = 'sequential';
  }

  // Validate agents object
  if (!parsed.agents || typeof parsed.agents !== 'object' || Object.keys(parsed.agents).length === 0) {
    throw new Error('LLM did not return any agents in the agency config');
  }

  // Ensure name
  if (!parsed.name || typeof parsed.name !== 'string') {
    parsed.name = 'my-agency';
  }

  return parsed;
}

/**
 * Create an LLM invoker for agency NL extraction.
 * Reuses the same provider detection as `wunderland create`.
 */
async function createAgencyLLMInvoker(globals: GlobalFlags): Promise<(prompt: string) => Promise<string>> {
  const llm = await runInitLlmStep({ nonInteractive: globals.yes === true });
  if (!llm) {
    throw new Error(
      'No LLM provider configured. Set an API key (OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY),\n' +
      'or run `wunderland setup` first.',
    );
  }

  for (const [k, v] of Object.entries(llm.apiKeys)) {
    if (v) process.env[k] = v;
  }
  if (Object.keys(llm.apiKeys).length > 0) {
    await mergeEnv(llm.apiKeys, globals.config);
  }

  const provider = llm.llmProvider;
  const model = llm.llmModel;

  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'] || '';
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for Anthropic provider.');

    return async (prompt: string): Promise<string> => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Anthropic error (${res.status}): ${text.slice(0, 300)}`);
      const data = JSON.parse(text);
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const out = blocks.find((b: any) => b?.type === 'text')?.text;
      if (typeof out !== 'string') throw new Error('Anthropic returned an empty response.');
      return out;
    };
  }

  // OpenAI-compatible path (openai, openrouter, ollama)
  const openaiBaseUrl =
    provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : provider === 'ollama' ? 'http://localhost:11434/v1'
    : undefined;

  const apiKey =
    provider === 'openrouter' ? (process.env['OPENROUTER_API_KEY'] || '')
    : provider === 'ollama' ? 'ollama'
    : (process.env['OPENAI_API_KEY'] || '');

  if (!apiKey && provider !== 'ollama') {
    throw new Error(`${provider.toUpperCase()} API key is missing.`);
  }

  const fallback: LLMProviderConfig | undefined =
    provider === 'openai' && process.env['OPENROUTER_API_KEY']
      ? {
          apiKey: process.env['OPENROUTER_API_KEY'] || '',
          model: 'auto',
          baseUrl: 'https://openrouter.ai/api/v1',
          extraHeaders: { 'HTTP-Referer': 'https://wunderland.sh', 'X-Title': 'Wunderbot' },
        }
      : undefined;

  return async (prompt: string): Promise<string> => {
    const { message } = await openaiChatWithTools({
      apiKey,
      model,
      baseUrl: openaiBaseUrl,
      fallback,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      temperature: 0.1,
      maxTokens: 2200,
    });
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.trim()) throw new Error('LLM returned an empty response.');
    return content;
  };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** `wunderland agency list` — list configured agencies. */
async function cmdList(flags: Record<string, string | boolean>): Promise<void> {
  const { agencies, isDemo } = await loadAgencies(flags);

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

/**
 * `wunderland agency create <name-or-description>` -- create a new agency.
 *
 * When the argument looks like a natural language description (contains spaces
 * and is longer than a simple name), the CLI sends it to the LLM via
 * `extractAgencyConfig()` and writes the resulting agency block into
 * `agent.config.json`.
 *
 * When the argument is a simple name (no spaces, or very short), the original
 * manual template is shown instead.
 */
async function cmdCreate(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const joined = args.join(' ').trim();
  if (!joined) {
    fmt.errorBlock(
      'Missing name or description',
      'Usage:\n' +
      '  wunderland agency create <name> [--strategy ...]\n' +
      '  wunderland agency create "research team with researcher, analyst, and writer"',
    );
    process.exitCode = 1;
    return;
  }

  // Heuristic: if the input contains spaces and is 20+ chars, treat as NL description
  const isDescription = joined.includes(' ') && joined.length >= 20;

  if (isDescription) {
    await cmdCreateNL(joined, flags, globals);
  } else {
    cmdCreateManual(joined, flags);
  }
}

/**
 * NL-powered agency creation. Sends the description to the LLM, extracts
 * agency config, previews it, and appends to agent.config.json.
 */
async function cmdCreateNL(
  description: string,
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  fmt.section('Natural Language Agency Builder');
  fmt.blank();

  // Validate LLM provider
  let invoker: (prompt: string) => Promise<string>;
  try {
    invoker = await createAgencyLLMInvoker(globals);
    fmt.ok('LLM provider configured.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('LLM provider not configured', msg);
    process.exitCode = 1;
    return;
  }

  // Extract agency config
  fmt.section('Extracting agency configuration...');

  let extracted: ExtractedAgencyConfig;
  try {
    extracted = await extractAgencyConfig(description, invoker);
    fmt.ok('Agency configuration extracted.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Extraction failed', msg);
    process.exitCode = 1;
    return;
  }

  // Preview
  fmt.section('Extracted Agency');
  fmt.kvPair('Name', accent(extracted.name));
  fmt.kvPair('Strategy', accent(extracted.strategy));
  if (extracted.sharedGoals && extracted.sharedGoals.length > 0) {
    fmt.kvPair('Shared Goals', extracted.sharedGoals.join('; '));
  }
  console.log();
  fmt.section('Agents');
  for (const [agentName, agentDef] of Object.entries(extracted.agents)) {
    const deps = agentDef.dependsOn?.length ? dim(` (depends on: ${agentDef.dependsOn.join(', ')})`) : '';
    const role = agentDef.role ? dim(` [${agentDef.role}]`) : '';
    console.log(`  ${sColor(getGlyphs().ok)} ${bright(agentName)}${role}${deps}`);
    console.log(`    ${dim(agentDef.instructions)}`);
  }
  fmt.blank();

  // Confirm (unless --yes)
  if (!globals.yes) {
    try {
      const { default: prompts } = await import('@clack/prompts');
      const confirm = await prompts.confirm({ message: 'Write this agency block to agent.config.json?' });
      if (prompts.isCancel(confirm) || !confirm) {
        console.log(dim('  Cancelled.'));
        return;
      }
    } catch {
      // If @clack/prompts not available, proceed
    }
  }

  // Write to agent.config.json
  const configPath = resolve(process.cwd(), 'agent.config.json');
  let existingConfig: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, 'utf8');
      existingConfig = JSON.parse(raw);
    } catch {
      // File exists but not valid JSON — start fresh
    }
  }

  // Build the agency block
  const agencyBlock: Record<string, unknown> = {
    name: extracted.name,
    strategy: extracted.strategy,
    agents: extracted.agents,
  };
  if (extracted.sharedGoals && extracted.sharedGoals.length > 0) {
    agencyBlock.sharedGoals = extracted.sharedGoals;
  }

  existingConfig.agency = agencyBlock;

  try {
    await writeFile(configPath, JSON.stringify(existingConfig, null, 2) + '\n', 'utf8');
    fmt.ok(`Agency block written to ${dim(configPath)}`);
    fmt.blank();
    fmt.note(
      `Run your agency:\n\n` +
      `  ${accent(`wunderland agency run ${extracted.name} "Your prompt here"`)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to write agent.config.json', msg);
    process.exitCode = 1;
  }

  fmt.blank();
}

/**
 * Manual agency creation (original behavior). Shows a JSON template when
 * the user provides a simple name without a description.
 */
function cmdCreateManual(name: string, flags: Record<string, string | boolean>): void {
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
  fmt.note(
    'Or use natural language:\n\n' +
    `  ${accent('wunderland agency create "research team with researcher, analyst, and writer"')}`,
  );
  fmt.blank();
}

/** `wunderland agency status <name>` — show agency status. */
async function cmdStatus(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing name', 'Usage: wunderland agency status <name>');
    process.exitCode = 1;
    return;
  }

  const { agencies, isDemo } = await loadAgencies(flags);
  const agency = agencies.find((a) => a.name === name);
  if (!agency) {
    fmt.errorBlock('Not found', `Agency "${name}" not found. Run ${accent('wunderland agency list')} to see available agencies.`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Agency: ${agency.name}` + (isDemo ? dim(' (demo)') : ''));
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
    ${dim('create <name>')}          Create agency (manual template)
    ${dim('create "<description>"')} Create agency from NL description (LLM-powered)
    ${dim('status <name>')}          Show agency status and agents
    ${dim('run <name> "<prompt>"')}  Execute an agency against a prompt
    ${dim('add-seat <agency> <agent>')}  Add agent to agency
    ${dim('handoff <from> <to>')}    Trigger agent handoff

  ${accent('Flags:')}
    ${dim('--strategy <name>')}    Strategy: sequential | parallel | graph | debate | review-loop | hierarchical
    ${dim('--seed <id>')}          Agent seed ID for backend queries
    ${dim('--stream')}             Stream output with agent events
    ${dim('--format json|table')}  Output format
    ${dim('--yes / -y')}           Skip confirmation prompt

  ${accent('Examples:')}
    ${dim('wunderland agency list')}
    ${dim('wunderland agency create research-team --strategy graph')}
    ${dim('wunderland agency create "research team with researcher, analyst, and writer"')}
    ${dim('wunderland agency run research-team "Summarize recent AI safety papers"')}
    ${dim('wunderland agency run research-team "Write a report on fusion energy" --stream')}
`);
    return;
  }

  try {
    if (sub === 'list') await cmdList(flags);
    else if (sub === 'create') await cmdCreate(args.slice(1), flags, globals);
    else if (sub === 'status') await cmdStatus(args.slice(1), flags);
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
