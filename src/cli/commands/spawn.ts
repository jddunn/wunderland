/**
 * @fileoverview `wunderland spawn <description>` — create + start an agent in one command.
 * @module wunderland/cli/commands/spawn
 *
 * Combines the natural language agent creation flow (`wunderland create`) with
 * the server startup sequence (`wunderland start`) into a single ergonomic
 * command. The intent is "describe it and it runs" — zero interactive prompts.
 *
 * Features:
 * - Accepts a natural language description as a positional argument.
 * - Calls {@link extractAgentConfig} to derive agent.config.json fields.
 * - Auto-populates a `.env` file by forwarding known secret env vars from the
 *   current process environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).
 * - Writes agent.config.json, .env, .gitignore, README.md, and skills/ dir.
 * - Starts the agent via `wunderland start` (foreground) or `wunderland serve`
 *   (background with `--background`).
 * - Supports `--port`, `--background`, and `--dir` flags.
 *
 * @example
 * ```bash
 * wunderland spawn "a research assistant that monitors Hacker News daily"
 * wunderland spawn "customer support bot for our Shopify store" --port 3001
 * wunderland spawn "creative writer that generates blog posts" --background
 * wunderland spawn "DevOps monitor" --dir ./agents/devops --background
 * ```
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { loadDotEnvIntoProcessUpward, mergeEnv } from '../config/env-manager.js';
import { runInitLlmStep } from '../wizards/init-llm-step.js';
import { openaiChatWithTools, type LLMProviderConfig } from '../openai/tool-calling.js';
import { SECURITY_TIERS, getSecurityTier, isValidSecurityTier, type SecurityTierName } from '../../security/SecurityTiers.js';
import { extractAgentConfig } from '../../ai/NaturalLanguageAgentBuilder.js';
import type { ExtractedAgentConfig } from '../../ai/NaturalLanguageAgentBuilder.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Default server port when none is specified. */
const DEFAULT_PORT = 3777;

/**
 * Environment variable names that are forwarded from the parent process into
 * the spawned agent's `.env` file. These cover the most common LLM provider
 * keys, tool API keys, and service tokens used by Wunderland agents.
 */
const KNOWN_SECRET_ENV_VARS = [
  // LLM providers
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_AI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',

  // Tool / service keys
  'SERPER_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'GITHUB_TOKEN',
  'GIPHY_API_KEY',
  'WOLFRAM_APP_ID',
  'NEWSAPI_KEY',

  // Voice / media
  'ELEVENLABS_API_KEY',
  'DEEPGRAM_API_KEY',
  'STABILITY_API_KEY',
  'REPLICATE_API_TOKEN',
  'RUNWAY_API_KEY',
  'SUNO_API_KEY',
  'PIKA_API_KEY',

  // Cloud / infra
  'GOOGLE_CLOUD_VISION_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',

  // Social platforms
  'DISCORD_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'TWITTER_BEARER_TOKEN',
] as const;

// ── LLM invoker factory (mirrors create.ts) ──────────────────────────────────

/**
 * Creates an LLM invoker function using the configured provider.
 * Mirrors the logic in create.ts to maintain consistency.
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

  // Persist newly-entered keys into the process env.
  for (const [k, v] of Object.entries(llm.apiKeys)) {
    if (v) process.env[k] = v;
  }
  if (Object.keys(llm.apiKeys).length > 0) {
    await mergeEnv(llm.apiKeys, globals.config);
  }

  const provider = llm.llmProvider;
  const model = llm.llmModel;

  // Anthropic uses a dedicated fetch-based invoker.
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

  // All other providers use OpenAI-compatible chat completions.
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

// ── Env auto-population ──────────────────────────────────────────────────────

/**
 * Builds a `.env` file body by copying known secret environment variables from
 * the current process into key=value lines. Only variables that are actually
 * set in the process environment are included.
 *
 * @param port - Server port to include in the file.
 * @param llmProvider - Provider name for contextual comments.
 * @param llmModel - Model name for the OPENAI_MODEL line.
 * @returns The serialized .env file contents.
 */
function buildAutoEnv(port: number, _llmProvider: string, llmModel: string): string {
  const lines: string[] = [
    '# Auto-populated by wunderland spawn',
    `# Generated ${new Date().toISOString()}`,
    '',
  ];

  // Always set the model + port.
  lines.push(`OPENAI_MODEL=${llmModel}`);
  lines.push(`PORT=${port}`);
  lines.push('');

  // Copy known secret env vars from the current process.
  const copied: string[] = [];
  for (const varName of KNOWN_SECRET_ENV_VARS) {
    const value = process.env[varName];
    if (value) {
      lines.push(`${varName}=${value}`);
      copied.push(varName);
    }
  }

  if (copied.length > 0) {
    lines.push('');
    lines.push(`# ${copied.length} secret(s) forwarded from parent environment.`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── Command handler ──────────────────────────────────────────────────────────

/**
 * Command handler for `wunderland spawn <description>`.
 *
 * Combines agent creation (NL extraction, file scaffolding) and server startup
 * into a single non-interactive command. Designed for scripting and quick
 * iteration — no confirmation prompts.
 *
 * @param args - Positional arguments; joined as the agent description.
 * @param flags - Named flags: `--port`, `--background`/`-b`, `--dir`.
 * @param globals - Global CLI flags (--quiet, --yes, etc.).
 */
export default async function cmdSpawn(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  fmt.blank();
  fmt.panel({
    title: 'Spawn Agent',
    style: 'info',
    content: [
      'Describe your agent in plain English.',
      'It will be created and started in one step.',
    ].join('\n'),
  });
  fmt.blank();

  // ── Step 1: Get description ────────────────────────────────────────────
  const description = args.join(' ').trim();

  if (!description) {
    fmt.errorBlock(
      'Missing description',
      'Provide a natural language description of the agent you want to spawn.\n\n' +
      `Usage: ${accent('wunderland spawn "a research assistant that monitors Hacker News"')}`,
    );
    process.exitCode = 1;
    return;
  }

  if (description.length < 10) {
    fmt.errorBlock(
      'Description too short',
      'Please provide a more detailed description (at least 10 characters).',
    );
    process.exitCode = 1;
    return;
  }

  // ── Step 2: Resolve port ───────────────────────────────────────────────
  let port = DEFAULT_PORT;
  if (typeof flags['port'] === 'string') {
    const parsed = parseInt(flags['port'], 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
      port = parsed;
    } else {
      fmt.errorBlock('Invalid port', `"${flags['port']}" is not a valid port number (1-65535).`);
      process.exitCode = 1;
      return;
    }
  } else if (process.env['PORT']) {
    const envPort = parseInt(process.env['PORT'], 10);
    if (!isNaN(envPort) && envPort >= 1 && envPort <= 65535) port = envPort;
  }

  const background = flags['background'] === true || flags['b'] === true;

  // ── Step 3: Validate LLM provider ─────────────────────────────────────
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

  // ── Step 4: Extract configuration via LLM ──────────────────────────────
  fmt.section('Extracting agent configuration...');

  let extracted: ExtractedAgentConfig;
  try {
    extracted = await extractAgentConfig(description, llmInvoker, undefined, 'self_hosted');
    fmt.ok('Configuration extracted successfully.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to extract configuration', msg);
    process.exitCode = 1;
    return;
  }

  // ── Step 5: Show extracted config summary ──────────────────────────────
  fmt.section('Extracted Configuration');
  fmt.kvPair('Display Name', accent(extracted.displayName ?? '(unnamed)'));
  fmt.kvPair('Seed ID', extracted.seedId ?? '(auto-generated)');
  if (extracted.bio) {
    fmt.kvPair('Bio', String(extracted.bio).slice(0, 80));
  }
  if (extracted.preset) {
    fmt.kvPair('Preset', extracted.preset);
  }
  if (extracted.skills && extracted.skills.length > 0) {
    fmt.kvPair('Skills', extracted.skills.join(', '));
  }
  if (extracted.channels && extracted.channels.length > 0) {
    fmt.kvPair('Channels', extracted.channels.join(', '));
  }
  fmt.kvPair('Security Tier', extracted.securityTier ?? 'balanced');
  fmt.blank();

  // ── Step 6: Prepare output directory ───────────────────────────────────
  const dirName = typeof flags['dir'] === 'string'
    ? flags['dir']
    : extracted.seedId ?? `agent-${Date.now()}`;

  const targetDir = path.resolve(process.cwd(), dirName);

  // Refuse to overwrite a sealed agent.
  const sealedPath = path.join(targetDir, 'sealed.json');
  if (existsSync(sealedPath)) {
    fmt.errorBlock(
      'Refusing to overwrite sealed agent',
      `${sealedPath} exists.\nThis agent is sealed and should be treated as immutable.`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await mkdir(targetDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to create directory', msg);
    process.exitCode = 1;
    return;
  }

  // ── Step 7: Build and write agent files ────────────────────────────────
  fmt.section('Writing agent files...');

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

  try {
    // agent.config.json
    await writeFile(
      path.join(targetDir, 'agent.config.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf8',
    );

    // .env — auto-populated from process environment
    const envContent = buildAutoEnv(port, llmProvider, llmModel);
    await writeFile(path.join(targetDir, '.env'), envContent, 'utf8');

    // .env.example — template without secrets
    const exampleLines = [
      '# Copy to .env and fill in real values',
      `# Provider: ${llmProvider}`,
      llmProvider === 'openai' ? 'OPENAI_API_KEY=sk-...' :
      llmProvider === 'openrouter' ? 'OPENROUTER_API_KEY=...' :
      llmProvider === 'anthropic' ? 'ANTHROPIC_API_KEY=...' :
      llmProvider === 'ollama' ? '# Ollama: no API key needed' :
      `# Provider "${llmProvider}" — set the appropriate API key`,
      `OPENAI_MODEL=${llmModel}`,
      `PORT=${port}`,
      '',
    ];
    await writeFile(path.join(targetDir, '.env.example'), exampleLines.join('\n'), 'utf8');

    // .gitignore
    await writeFile(path.join(targetDir, '.gitignore'), '.env\nnode_modules\n', 'utf8');

    // skills/ directory
    const skillsDir = path.join(targetDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(path.join(skillsDir, '.gitkeep'), '', 'utf8');

    // README.md
    await writeFile(
      path.join(targetDir, 'README.md'),
      [
        `# ${config.displayName}`,
        '',
        'Created via `wunderland spawn`.',
        '',
        `**Original description:** "${description}"`,
        '',
        '## Run',
        '',
        '```bash',
        'wunderland start',
        '```',
        '',
        'Agent server:',
        `- GET http://localhost:${port}/health`,
        `- POST http://localhost:${port}/chat { "message": "Hello", "sessionId": "local" }`,
        `- HITL UI: http://localhost:${port}/hitl`,
        '',
      ].join('\n'),
      'utf8',
    );

    fmt.ok('Agent files written.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to write files', msg);
    process.exitCode = 1;
    return;
  }

  // ── Step 8: Start the agent ────────────────────────────────────────────
  const g = glyphs();

  if (background) {
    // Daemon mode — shell out to `wunderland serve` in the target directory.
    fmt.section('Starting agent as daemon...');

    const { spawn } = await import('node:child_process');

    const wunderlandBin = process.argv[1];
    if (!wunderlandBin || !existsSync(wunderlandBin)) {
      fmt.errorBlock(
        'Binary not found',
        'Could not resolve the wunderland binary path.\n' +
        `Agent created at ${dim(targetDir)} — start manually:\n` +
        accent(`cd ${dirName} && wunderland serve --port ${port}`),
      );
      process.exitCode = 1;
      return;
    }

    const childArgs = [
      wunderlandBin,
      'serve',
      '--port', String(port),
      '--quiet',
      '--yes',
    ];

    const child = spawn(process.execPath, childArgs, {
      cwd: targetDir,
      stdio: 'inherit',
      env: { ...process.env },
    });

    // Wait for the serve command to finish writing daemon info.
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code && code !== 0) {
          reject(new Error(`wunderland serve exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on('error', reject);
    });

    fmt.blank();
    fmt.panel({
      title: `${g.ok} Agent Spawned (background)`,
      style: 'success',
      content: [
        `Agent:     ${accent(String(config.displayName))}`,
        `Directory: ${dim(targetDir)}`,
        `Port:      ${String(port)}`,
        `Security:  ${securityTier}`,
        '',
        `URL:       ${sColor(`http://localhost:${port}`)}`,
        '',
        `Status:    ${accent('wunderland ps')}`,
        `Logs:      ${accent(`wunderland logs ${config.seedId}`)}`,
        `Stop:      ${accent(`wunderland stop ${config.seedId}`)}`,
      ].join('\n'),
    });
    fmt.blank();
  } else {
    // Foreground mode — import and call cmdStart directly.
    fmt.blank();
    fmt.panel({
      title: `${g.ok} Agent Created — Starting Server`,
      style: 'success',
      content: [
        `Agent:     ${accent(String(config.displayName))}`,
        `Directory: ${dim(targetDir)}`,
        `Port:      ${String(port)}`,
        `Security:  ${securityTier}`,
        '',
        `URL:       ${sColor(`http://localhost:${port}`)}`,
      ].join('\n'),
    });
    fmt.blank();

    // Change working directory to the agent directory so that `wunderland start`
    // picks up the agent.config.json and .env automatically.
    process.chdir(targetDir);

    const { default: cmdStart } = await import('./start/index.js');
    await cmdStart(
      [],
      {
        ...flags,
        port: String(port),
      },
      {
        ...globals,
        yes: true,
        quiet: false,
      },
    );
  }
}
