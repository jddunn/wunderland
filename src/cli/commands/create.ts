/**
 * @fileoverview `wunderland create <description>` — natural language agent creation.
 * @module wunderland/cli/commands/create
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, dim, warn } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward, mergeEnv } from '../config/env-manager.js';
import { runInitLlmStep } from '../wizards/init-llm-step.js';
import { openaiChatWithTools, type LLMProviderConfig } from '../openai/tool-calling.js';
import { SECURITY_TIERS, getSecurityTier, isValidSecurityTier, type SecurityTierName } from '../../security/SecurityTiers.js';
import { extractAgentConfig } from '../../ai/NaturalLanguageAgentBuilder.js';
import type { ExtractedAgentConfig } from '../../ai/NaturalLanguageAgentBuilder.js';

function buildEnvExample(opts: { llmProvider?: string; llmModel?: string }): string {
  const provider = typeof opts.llmProvider === 'string' ? opts.llmProvider.trim().toLowerCase() : 'openai';
  const model = typeof opts.llmModel === 'string' && opts.llmModel.trim() ? opts.llmModel.trim() : 'gpt-4o-mini';

  const lines: string[] = ['# Copy to .env and fill in real values'];

  if (provider === 'openai') lines.push('OPENAI_API_KEY=sk-...');
  else if (provider === 'openrouter') lines.push('OPENROUTER_API_KEY=...');
  else if (provider === 'anthropic') lines.push('ANTHROPIC_API_KEY=...');
  else if (provider === 'ollama') lines.push('# Ollama: no API key needed');
  else lines.push(`# Provider "${provider}" not supported by CLI runtime`);

  lines.push(`OPENAI_MODEL=${model}`);
  lines.push('PORT=3777', '');

  lines.push(
    '# OBSERVABILITY (OpenTelemetry - opt-in)',
    '# Enable OTEL in wunderland CLI runtime (wunderland start/chat):',
    '# WUNDERLAND_OTEL_ENABLED=true',
    '# WUNDERLAND_OTEL_LOGS_ENABLED=true',
    '# OTEL_TRACES_EXPORTER=otlp',
    '# OTEL_METRICS_EXPORTER=otlp',
    '# OTEL_LOGS_EXPORTER=otlp',
    '# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318',
    '# OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    '# OTEL_TRACES_SAMPLER=parentbased_traceidratio',
    '# OTEL_TRACES_SAMPLER_ARG=0.1',
    '',
  );

  return lines.join('\n');
}

/**
 * Create an LLM invoker for the configured provider.
 */
async function createLLMInvoker(globals: GlobalFlags): Promise<{ invoker: (prompt: string) => Promise<string>; provider: string; model: string }> {
  // Reuse the init wizard step so provider/model selection is consistent.
  const llm = await runInitLlmStep({ nonInteractive: globals.yes === true });
  if (!llm) {
    throw new Error(
      'No LLM provider configured. Set an API key in your environment (e.g. OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY),\n' +
      'or run `wunderland init <dir>` to configure a project.',
    );
  }

  // Ensure freshly-entered keys are available for this process and persisted globally.
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

  // Everything else uses OpenAI-compatible chat completions.
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

/**
 * Command handler for `wunderland create <description>`.
 */
export default async function cmdCreate(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  p.intro(accent('Natural Language Agent Creator'));

  // ── Step 1: Get description ─────────────────────────────────────────────
  let description = args.join(' ').trim();

  if (!description) {
    const input = await p.text({
      message: 'Describe your agent in plain English:',
      placeholder: 'e.g., I need a research bot that searches the web and summarizes articles',
      validate: (val: string) => {
        if (!val || val.trim().length === 0) return 'Description cannot be empty';
        if (val.trim().length < 10) return 'Please provide a more detailed description (at least 10 characters)';
        return undefined;
      },
    });

    if (p.isCancel(input)) {
      p.cancel('Agent creation cancelled.');
      return;
    }

    description = input as string;
  }

  // ── Step 2: Validate API key setup ──────────────────────────────────────
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

  // ── Step 3: Extract configuration ───────────────────────────────────────
  fmt.section('Extracting agent configuration...');

  let extracted: ExtractedAgentConfig;
  try {
    const hostingMode = typeof flags['managed'] === 'boolean' && flags['managed']
      ? 'managed'
      : 'self_hosted';

    extracted = await extractAgentConfig(description, llmInvoker, undefined, hostingMode);
    fmt.ok('Configuration extracted successfully.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to extract configuration', msg);
    process.exitCode = 1;
    return;
  }

  // ── Step 4: Show preview with confidence scores ─────────────────────────
  fmt.section('Extracted Configuration');

  const confidence = extracted.confidence ?? {};

  function formatField(label: string, value: unknown, confidenceKey: string): string {
    const conf = confidence[confidenceKey];
    let confBadge = '';
    if (conf !== undefined) {
      if (conf >= 0.8) confBadge = sColor(`✓ ${Math.round(conf * 100)}%`);
      else if (conf >= 0.5) confBadge = warn(`⚠ ${Math.round(conf * 100)}%`);
      else confBadge = warn(`✗ ${Math.round(conf * 100)}%`);
    }

    const valueStr = typeof value === 'object' ? JSON.stringify(value, null, 2).slice(0, 100) : String(value);
    return `${label}: ${accent(valueStr)} ${confBadge}`;
  }

  fmt.kvPair('Display Name', extracted.displayName ? formatField('', extracted.displayName, 'displayName') : dim('(not set)'));
  fmt.kvPair('Seed ID', extracted.seedId ?? dim('(auto-generated)'));
  fmt.kvPair('Bio', extracted.bio ? String(extracted.bio).slice(0, 80) : dim('(not set)'));

  if (extracted.preset) {
    fmt.kvPair('Preset', formatField('', extracted.preset, 'preset'));
  }

  if (extracted.skills && extracted.skills.length > 0) {
    fmt.kvPair('Skills', `${extracted.skills.join(', ')} ${confidence.skills ? sColor(`✓ ${Math.round(confidence.skills * 100)}%`) : ''}`);
  }

  if (extracted.extensions) {
    const extParts: string[] = [];
    if (extracted.extensions.tools?.length) extParts.push(`tools: ${extracted.extensions.tools.join(', ')}`);
    if (extracted.extensions.voice?.length) extParts.push(`voice: ${extracted.extensions.voice.join(', ')}`);
    if (extracted.extensions.productivity?.length) extParts.push(`productivity: ${extracted.extensions.productivity.join(', ')}`);
    if (extParts.length > 0) {
      fmt.kvPair('Extensions', extParts.join('; '));
    }
  }

  if (extracted.channels && extracted.channels.length > 0) {
    fmt.kvPair('Channels', extracted.channels.join(', '));
  }

  fmt.kvPair('Security Tier', extracted.securityTier ?? 'balanced');
  fmt.kvPair('Permission Set', extracted.permissionSet ?? 'supervised');
  fmt.kvPair('Tool Access Profile', extracted.toolAccessProfile ?? 'assistant');
  fmt.kvPair('Execution Mode', extracted.executionMode ?? 'human-dangerous');

  if (extracted.personality) {
    const traits = Object.entries(extracted.personality)
      .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
      .join(', ');
    fmt.kvPair('Personality (HEXACO)', traits);
  }

  fmt.blank();

  // ── Step 5: Confirm ──────────────────────────────────────────────────────
  if (!globals.yes) {
    const confirm = await p.confirm({ message: 'Create agent with this configuration?' });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Agent creation cancelled.');
      return;
    }
  }

  // ── Step 6: Save agent.config.json ───────────────────────────────────────
  const dirName = typeof flags['dir'] === 'string'
    ? flags['dir']
    : extracted.seedId ?? `agent-${Date.now()}`;

  const targetDir = path.resolve(process.cwd(), dirName);

  try {
    await mkdir(targetDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to create directory', msg);
    process.exitCode = 1;
    return;
  }

  // Build agent.config.json
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

  // Write files
  try {
    await writeFile(
      path.join(targetDir, 'agent.config.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf8',
    );

    await writeFile(
      path.join(targetDir, '.env.example'),
      buildEnvExample({ llmProvider, llmModel }),
      'utf8',
    );

    await writeFile(path.join(targetDir, '.gitignore'), '.env\nnode_modules\n', 'utf8');

    // Create skills directory
    const skillsDir = path.join(targetDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(path.join(skillsDir, '.gitkeep'), '', 'utf8');

    await writeFile(
      path.join(targetDir, 'README.md'),
      `# ${config.displayName}\n\nCreated via natural language agent builder.\n\n**Original description:** "${description}"\n\n## Run\n\n\`\`\`bash\ncp .env.example .env\nwunderland start\n\`\`\`\n\nAgent server:\n- GET http://localhost:3777/health\n- POST http://localhost:3777/chat { "message": "Hello", "sessionId": "local" }\n- HITL UI: http://localhost:3777/hitl\n`,
      'utf8',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.errorBlock('Failed to write files', msg);
    process.exitCode = 1;
    return;
  }

  // ── Output ───────────────────────────────────────────────────────────────
  p.outro(sColor('Agent created successfully!'));
  fmt.blank();
  fmt.note(`Next: ${sColor(`cd ${dirName}`)} && ${sColor('cp .env.example .env')} && ${sColor('wunderland start')}`);
  fmt.blank();
}
