/**
 * @fileoverview `wunderland batch-create` — bulk agent creation from file or mission.
 * @module wunderland/cli/commands/batch-create
 *
 * Creates multiple agents in a single invocation. Supports three input modes:
 *
 * 1. **Text file** (`.txt`): One agent description per line.
 * 2. **JSON file** (`.json`): Array of description strings or objects with
 *    `{ description, role? }` shape.
 * 3. **Mission decomposition** (`--from-mission <text>`): An LLM breaks a
 *    high-level team mission into individual agent roles.
 *
 * Each description is fed through {@link extractAgentConfig} to derive a full
 * agent configuration, then scaffolded into its own directory.
 *
 * @example
 * ```bash
 * wunderland batch-create descriptions.txt
 * wunderland batch-create descriptions.json --output-dir ./agents
 * wunderland batch-create --from-mission "Build a content marketing team"
 * wunderland batch-create agents.txt --start-all
 * ```
 */

import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, dim, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { loadDotEnvIntoProcessUpward, mergeEnv } from '../config/env-manager.js';
import { runInitLlmStep } from '../wizards/init-llm-step.js';
import { openaiChatWithTools, type LLMProviderConfig } from '../../runtime/tool-calling.js';
import { SECURITY_TIERS, getSecurityTier, isValidSecurityTier, type SecurityTierName } from '../../security/SecurityTiers.js';
import { extractAgentConfig } from '../../ai/NaturalLanguageAgentBuilder.js';
import type { ExtractedAgentConfig } from '../../ai/NaturalLanguageAgentBuilder.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Represents a single agent to create, derived from input. */
interface AgentDescriptor {
  /** Natural language description of the agent. */
  description: string;
  /** Optional role label (used for display/logging). */
  role?: string;
}

/** Result of a single agent creation attempt. */
interface CreationResult {
  /** Whether the agent was created successfully. */
  success: boolean;
  /** Display name of the created agent (from extracted config). */
  displayName: string;
  /** Directory where the agent was scaffolded. */
  directory: string;
  /** Security tier of the created agent. */
  securityTier: string;
  /** Seed ID of the created agent. */
  seedId: string;
  /** Error message if creation failed. */
  error?: string;
}

// ── LLM invoker factory (mirrors create.ts) ──────────────────────────────────

/**
 * Creates an LLM invoker function using the configured provider.
 * Identical logic to create.ts / spawn.ts for consistency.
 *
 * @param globals - Global CLI flags for config resolution.
 * @returns The invoker function, provider name, and model name.
 */
async function createLLMInvoker(globals: GlobalFlags): Promise<{
  invoker: (prompt: string) => Promise<string>;
  provider: string;
  model: string;
}> {
  const llm = await runInitLlmStep({ nonInteractive: true });
  if (!llm) {
    throw new Error(
      'No LLM provider configured. Set an API key in your environment ' +
      '(e.g. OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY),\n' +
      'or run `wunderland init <dir>` to configure a project.',
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

    const invoker = async (prompt: string): Promise<string> => {
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

    return { invoker, provider, model };
  }

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

  const invoker = async (prompt: string): Promise<string> => {
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

  return { invoker, provider, model };
}

// ── Input parsing ────────────────────────────────────────────────────────────

/**
 * Parses a .txt file into agent descriptors.
 * Each non-empty, non-comment line becomes one agent description.
 *
 * @param filePath - Path to the .txt file.
 * @returns Array of agent descriptors.
 */
async function parseTextFile(filePath: string): Promise<AgentDescriptor[]> {
  const raw = await readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((description) => ({ description }));
}

/**
 * Parses a .json file into agent descriptors.
 * Supports two formats:
 * - Array of strings: `["description 1", "description 2"]`
 * - Array of objects: `[{ "description": "...", "role": "..." }]`
 *
 * @param filePath - Path to the .json file.
 * @returns Array of agent descriptors.
 */
async function parseJsonFile(filePath: string): Promise<AgentDescriptor[]> {
  const raw = await readFile(filePath, 'utf-8');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array in ${filePath}, got ${typeof parsed}`);
  }

  return parsed.map((item: unknown, idx: number) => {
    if (typeof item === 'string') {
      return { description: item };
    }
    if (typeof item === 'object' && item !== null && 'description' in item) {
      const obj = item as Record<string, unknown>;
      return {
        description: String(obj.description),
        role: typeof obj.role === 'string' ? obj.role : undefined,
      };
    }
    throw new Error(`Invalid entry at index ${idx}: expected string or { description, role? }`);
  });
}

/**
 * Decomposes a high-level team mission into individual agent role descriptions
 * using the configured LLM.
 *
 * The LLM is prompted to break the mission into discrete agent roles, returning
 * a JSON array of `{ description, role }` objects.
 *
 * @param mission - The high-level team mission text.
 * @param invoker - LLM invoker function.
 * @returns Array of agent descriptors derived from the mission.
 */
async function decomposeMission(
  mission: string,
  invoker: (prompt: string) => Promise<string>,
): Promise<AgentDescriptor[]> {
  const prompt = `You are an AI team architect. Given a team mission, break it down into individual autonomous agent roles.

Given this team mission: "${mission}"

Break it down into individual agent roles. For each agent, provide:
- A one-line natural language description suitable for creating an autonomous agent
- A short role label (2-4 words)
- Why this agent is needed for the team

Return ONLY a JSON array with NO surrounding markdown code fences:
[{ "description": "...", "role": "..." }]

Guidelines:
- Create 2-6 agents (no more than 6 unless the mission is very complex)
- Each agent should have a distinct, non-overlapping responsibility
- Descriptions should be specific enough to derive tools, skills, and personality
- Include any relevant platforms or integrations in the description

Example output for "Build a content marketing team":
[
  { "description": "A content strategist that researches trending topics, analyzes competitor content, and creates editorial calendars", "role": "Content Strategist" },
  { "description": "A blog writer that generates SEO-optimized articles, creates outlines, and adapts tone for different audiences", "role": "Blog Writer" },
  { "description": "A social media manager that schedules posts across Twitter, LinkedIn, and Instagram, responds to engagement, and tracks analytics", "role": "Social Media Manager" }
]`;

  const response = await invoker(prompt);

  // Extract JSON from the response (handle possible markdown fences).
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      'Failed to parse mission decomposition from LLM.\n' +
      `Raw response (first 500 chars): ${response.slice(0, 500)}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LLM returned an empty or non-array response for mission decomposition.');
  }

  return parsed.map((item: any) => ({
    description: String(item.description || ''),
    role: typeof item.role === 'string' ? item.role : undefined,
  }));
}

// ── .env builder (simplified — no secrets, just template) ────────────────────

/**
 * Builds a minimal .env.example file for a batch-created agent.
 *
 * @param llmProvider - The LLM provider name.
 * @param llmModel - The LLM model identifier.
 * @returns .env.example file contents.
 */
function buildEnvExample(llmProvider: string, llmModel: string): string {
  const lines: string[] = ['# Copy to .env and fill in real values'];

  if (llmProvider === 'openai') lines.push('OPENAI_API_KEY=sk-...');
  else if (llmProvider === 'openrouter') lines.push('OPENROUTER_API_KEY=...');
  else if (llmProvider === 'anthropic') lines.push('ANTHROPIC_API_KEY=...');
  else if (llmProvider === 'ollama') lines.push('# Ollama: no API key needed');
  else lines.push(`# Provider "${llmProvider}" not supported by CLI runtime`);

  lines.push(`OPENAI_MODEL=${llmModel}`);
  lines.push('PORT=3777', '');

  return lines.join('\n');
}

// ── Single agent creation ────────────────────────────────────────────────────

/**
 * Creates a single agent from a descriptor. Writes agent.config.json and
 * supporting files to the target directory.
 *
 * @param descriptor - The agent description and optional role.
 * @param baseDir - Parent directory for the agent folder.
 * @param llmInvoker - LLM invoker for config extraction.
 * @param llmProvider - Provider name for config/env files.
 * @param llmModel - Model name for config/env files.
 * @param index - Agent index (for progress display).
 * @param total - Total number of agents (for progress display).
 * @returns The creation result with success status and metadata.
 */
async function createSingleAgent(
  descriptor: AgentDescriptor,
  baseDir: string,
  llmInvoker: (prompt: string) => Promise<string>,
  llmProvider: string,
  llmModel: string,
  index: number,
  total: number,
): Promise<CreationResult> {
  const label = descriptor.role
    ? `[${index + 1}/${total}] ${descriptor.role}`
    : `[${index + 1}/${total}]`;

  fmt.note(`${label}: Extracting config...`);

  let extracted: ExtractedAgentConfig;
  try {
    extracted = await extractAgentConfig(descriptor.description, llmInvoker, undefined, 'self_hosted');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.fail(`${label}: Extraction failed — ${msg}`);
    return {
      success: false,
      displayName: descriptor.role ?? '(unknown)',
      directory: '',
      securityTier: 'balanced',
      seedId: '',
      error: msg,
    };
  }

  const dirName = extracted.seedId ?? `agent-${Date.now()}-${index}`;
  const targetDir = path.resolve(baseDir, dirName);

  // Skip if sealed.
  const sealedPath = path.join(targetDir, 'sealed.json');
  if (existsSync(sealedPath)) {
    fmt.fail(`${label}: Skipped — sealed agent at ${targetDir}`);
    return {
      success: false,
      displayName: extracted.displayName ?? dirName,
      directory: targetDir,
      securityTier: extracted.securityTier ?? 'balanced',
      seedId: extracted.seedId ?? dirName,
      error: 'Sealed agent exists',
    };
  }

  // Build config.
  const securityTier: SecurityTierName = extracted.securityTier && isValidSecurityTier(extracted.securityTier)
    ? extracted.securityTier
    : 'balanced';
  const tierConfig = getSecurityTier(securityTier);
  const permissionSetDefault = SECURITY_TIERS[securityTier].permissionSet;
  const wrapToolOutputs = securityTier !== 'dangerous';

  const config: Record<string, unknown> = {
    seedId: extracted.seedId,
    displayName: extracted.displayName,
    bio: extracted.bio,
    systemPrompt: extracted.systemPrompt ?? 'You are an autonomous agent in the Wunderland network.',
    personality: extracted.personality,
    security: {
      tier: securityTier,
      preLLMClassifier: tierConfig.pipelineConfig.enablePreLLM,
      dualLLMAudit: tierConfig.pipelineConfig.enableDualLLMAudit,
      outputSigning: tierConfig.pipelineConfig.enableOutputSigning,
      riskThreshold: tierConfig.riskThreshold,
      wrapToolOutputs,
    },
    permissionSet: extracted.permissionSet ?? permissionSetDefault,
    executionMode: extracted.executionMode ?? 'human-dangerous',
    observability: {
      otel: { enabled: false, exportLogs: false },
    },
    llmProvider,
    llmModel,
    skills: extracted.skills ?? [],
    extensions: extracted.extensions,
    suggestedChannels: extracted.channels ?? [],
    presetId: extracted.preset,
    skillsDir: './skills',
    toolAccessProfile: extracted.toolAccessProfile,
  };

  // Write files.
  try {
    await mkdir(targetDir, { recursive: true });

    await writeFile(
      path.join(targetDir, 'agent.config.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf8',
    );

    await writeFile(
      path.join(targetDir, '.env.example'),
      buildEnvExample(llmProvider, llmModel),
      'utf8',
    );

    await writeFile(path.join(targetDir, '.gitignore'), '.env\nnode_modules\n', 'utf8');

    const skillsDir = path.join(targetDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(path.join(skillsDir, '.gitkeep'), '', 'utf8');

    await writeFile(
      path.join(targetDir, 'README.md'),
      [
        `# ${config.displayName}`,
        '',
        'Created via `wunderland batch-create`.',
        '',
        `**Description:** "${descriptor.description}"`,
        descriptor.role ? `**Role:** ${descriptor.role}` : '',
        '',
        '## Run',
        '',
        '```bash',
        'cp .env.example .env',
        'wunderland start',
        '```',
        '',
      ].filter(Boolean).join('\n'),
      'utf8',
    );

    fmt.ok(`${label}: ${accent(String(config.displayName))} -> ${dim(targetDir)}`);

    return {
      success: true,
      displayName: String(config.displayName ?? dirName),
      directory: targetDir,
      securityTier,
      seedId: String(extracted.seedId ?? dirName),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.fail(`${label}: Write failed — ${msg}`);
    return {
      success: false,
      displayName: String(config.displayName ?? dirName),
      directory: targetDir,
      securityTier,
      seedId: String(extracted.seedId ?? dirName),
      error: msg,
    };
  }
}

// ── Command handler ──────────────────────────────────────────────────────────

/**
 * Command handler for `wunderland batch-create`.
 *
 * Creates multiple agents from a descriptions file or an LLM-decomposed
 * mission. Optionally auto-starts all created agents.
 *
 * @param args - Positional arguments; first arg is the file path (optional if
 *   `--from-mission` is provided).
 * @param flags - Named flags: `--from-mission`, `--output-dir`, `--start-all`.
 * @param globals - Global CLI flags.
 */
export default async function cmdBatchCreate(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  fmt.blank();
  fmt.panel({
    title: 'Batch Agent Creator',
    style: 'info',
    content: [
      'Create multiple agents from a descriptions file or a team mission.',
      'Each agent gets its own directory with a full configuration.',
    ].join('\n'),
  });
  fmt.blank();

  // ── Step 1: Parse input ────────────────────────────────────────────────
  const filePath = args[0];
  const fromMission = typeof flags['from-mission'] === 'string' ? flags['from-mission'] : undefined;

  if (!filePath && !fromMission) {
    fmt.errorBlock(
      'Missing input',
      'Provide a file path (.txt or .json) or use --from-mission.\n\n' +
      `Usage:\n` +
      `  ${accent('wunderland batch-create descriptions.txt')}\n` +
      `  ${accent('wunderland batch-create descriptions.json')}\n` +
      `  ${accent('wunderland batch-create --from-mission "Build a content marketing team"')}`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Step 2: Validate LLM provider ─────────────────────────────────────
  fmt.section('Validating LLM provider...');

  let llmInvoker: (prompt: string) => Promise<string>;
  let llmProvider = '';
  let llmModel = '';
  try {
    const res = await createLLMInvoker(globals);
    llmInvoker = res.invoker;
    llmProvider = res.provider;
    llmModel = res.model;
    fmt.ok('LLM provider configured.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('LLM provider not configured', msg);
    process.exitCode = 1;
    return;
  }

  // ── Step 3: Load descriptors ──────────────────────────────────────────
  let descriptors: AgentDescriptor[] = [];

  if (fromMission) {
    // Mission decomposition mode.
    fmt.section('Decomposing mission into agent roles...');
    try {
      descriptors = await decomposeMission(fromMission, llmInvoker);
      fmt.ok(`Decomposed into ${descriptors.length} agent role(s).`);
      fmt.blank();

      // Preview the roles.
      for (const [i, d] of descriptors.entries()) {
        const roleLabel = d.role ? accent(d.role) : `Agent ${i + 1}`;
        fmt.kvPair(roleLabel, d.description.slice(0, 80));
      }
      fmt.blank();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fmt.errorBlock('Mission decomposition failed', msg);
      process.exitCode = 1;
      return;
    }
  } else if (filePath) {
    // File mode.
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!existsSync(resolvedPath)) {
      fmt.errorBlock('File not found', resolvedPath);
      process.exitCode = 1;
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();

    try {
      if (ext === '.json') {
        descriptors = await parseJsonFile(resolvedPath);
      } else if (ext === '.txt') {
        descriptors = await parseTextFile(resolvedPath);
      } else {
        fmt.errorBlock(
          'Unsupported file format',
          `Expected .txt or .json, got "${ext}".\n` +
          '.txt: one description per line\n' +
          '.json: array of strings or { description, role? } objects',
        );
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fmt.errorBlock('Failed to parse input file', msg);
      process.exitCode = 1;
      return;
    }

    fmt.ok(`Loaded ${descriptors.length} description(s) from ${dim(resolvedPath)}.`);
  }

  // Validate we have at least one descriptor.
  if (descriptors.length === 0) {
    fmt.errorBlock('No descriptions found', 'The input file is empty or contains only comments.');
    process.exitCode = 1;
    return;
  }

  // Filter out empty descriptions.
  descriptors = descriptors.filter((d) => d.description.trim().length > 0);
  if (descriptors.length === 0) {
    fmt.errorBlock('No valid descriptions', 'All descriptions were empty after filtering.');
    process.exitCode = 1;
    return;
  }

  // ── Step 4: Resolve output directory ──────────────────────────────────
  const baseDir = typeof flags['output-dir'] === 'string'
    ? path.resolve(process.cwd(), flags['output-dir'])
    : process.cwd();

  try {
    await mkdir(baseDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to create output directory', msg);
    process.exitCode = 1;
    return;
  }

  // ── Step 5: Create agents sequentially ────────────────────────────────
  fmt.section(`Creating ${descriptors.length} agent(s)...`);

  const results: CreationResult[] = [];

  for (let i = 0; i < descriptors.length; i++) {
    const result = await createSingleAgent(
      descriptors[i],
      baseDir,
      llmInvoker,
      llmProvider,
      llmModel,
      i,
      descriptors.length,
    );
    results.push(result);
  }

  // ── Step 6: Summary table ─────────────────────────────────────────────
  const g = glyphs();
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  fmt.blank();
  fmt.section('Summary');

  await fmt.table({
    title: `${successCount} created, ${failCount} failed`,
    columns: [
      { label: 'Status', width: 8 },
      { label: 'Name', width: 28 },
      { label: 'Seed ID', width: 28 },
      { label: 'Security', width: 12 },
    ],
    rows: results.map((r) => [
      r.success ? sColor(g.ok) : wColor(g.fail),
      r.displayName.slice(0, 28),
      r.seedId.slice(0, 28),
      r.securityTier,
    ]),
  });

  // Print directory listing for successful agents.
  if (successCount > 0) {
    fmt.blank();
    fmt.section('Agent Directories');
    for (const r of results.filter((r) => r.success)) {
      fmt.kvPair(r.displayName, dim(r.directory));
    }
  }

  // Print errors for failed agents.
  if (failCount > 0) {
    fmt.blank();
    fmt.section('Errors');
    for (const r of results.filter((r) => !r.success)) {
      fmt.fail(`${r.displayName}: ${r.error ?? 'Unknown error'}`);
    }
  }

  // ── Step 7: Auto-start (--start-all) ──────────────────────────────────
  const startAll = flags['start-all'] === true;
  const successfulResults = results.filter((r) => r.success);

  if (startAll && successfulResults.length > 0) {
    fmt.blank();
    fmt.section(`Starting ${successfulResults.length} agent(s) as daemons...`);

    const { spawn } = await import('node:child_process');
    const wunderlandBin = process.argv[1];

    if (!wunderlandBin || !existsSync(wunderlandBin)) {
      fmt.errorBlock(
        'Binary not found',
        'Could not resolve the wunderland binary path.\n' +
        'Agents were created successfully — start them manually with:\n' +
        accent('cd <agent-dir> && wunderland serve'),
      );
      return;
    }

    // Start each agent as a background daemon with incrementing ports.
    let basePort = 3777;
    for (const result of successfulResults) {
      const port = basePort++;
      const childArgs = [
        wunderlandBin,
        'serve',
        '--port', String(port),
        '--quiet',
        '--yes',
      ];

      try {
        const child = spawn(process.execPath, childArgs, {
          cwd: result.directory,
          stdio: 'inherit',
          env: { ...process.env },
        });

        await new Promise<void>((resolve, reject) => {
          child.on('close', (code) => {
            if (code && code !== 0) {
              reject(new Error(`serve exited with code ${code}`));
            } else {
              resolve();
            }
          });
          child.on('error', reject);
        });

        fmt.ok(`${result.displayName} -> http://localhost:${port}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fmt.fail(`${result.displayName}: Failed to start — ${msg}`);
      }
    }
  }

  // ── Final output ──────────────────────────────────────────────────────
  fmt.blank();

  if (successCount > 0 && !startAll) {
    fmt.panel({
      title: `${g.ok} Batch Creation Complete`,
      style: 'success',
      content: [
        `Created ${successCount} agent(s)${failCount > 0 ? ` (${failCount} failed)` : ''}.`,
        '',
        'Next steps:',
        `  ${accent('cd <agent-dir>')}`,
        `  ${accent('cp .env.example .env')}    # Add your API keys`,
        `  ${accent('wunderland start')}         # Start the agent`,
        '',
        `Or start all at once: ${accent('wunderland batch-create <file> --start-all')}`,
      ].join('\n'),
    });
  } else if (startAll && successCount > 0) {
    fmt.panel({
      title: `${g.ok} Batch Creation + Start Complete`,
      style: 'success',
      content: [
        `Created and started ${successCount} agent(s).`,
        '',
        `Status:  ${accent('wunderland ps')}`,
        `Stop:    ${accent('wunderland stop --all')}`,
      ].join('\n'),
    });
  }

  fmt.blank();

  if (failCount > 0) {
    process.exitCode = 1;
  }
}
