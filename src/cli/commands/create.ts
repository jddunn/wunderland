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
import { extractAgentConfig, validateApiKeySetup } from '../../ai/NaturalLanguageAgentBuilder.js';
import type { ExtractedAgentConfig } from '../../ai/NaturalLanguageAgentBuilder.js';

/**
 * Create an LLM invoker for the configured provider.
 * TODO: This is a placeholder — integrate with actual LLM service.
 */
async function createLLMInvoker(): Promise<(prompt: string) => Promise<string>> {
  // Check for OpenAI API key
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && validateApiKeySetup('openai', openaiKey)) {
    // TODO: Use actual OpenAI client
    return async (_prompt: string): Promise<string> => {
      throw new Error('OpenAI integration not yet implemented. Coming soon!');
    };
  }

  // Check for Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && validateApiKeySetup('anthropic', anthropicKey)) {
    // TODO: Use actual Anthropic client
    return async (_prompt: string): Promise<string> => {
      throw new Error('Anthropic integration not yet implemented. Coming soon!');
    };
  }

  // Check for Ollama
  try {
    // TODO: Check if Ollama is running
    return async (_prompt: string): Promise<string> => {
      throw new Error('Ollama integration not yet implemented. Coming soon!');
    };
  } catch {
    // Ollama not available
  }

  throw new Error(
    'No LLM provider configured. Please set one of:\n' +
      '  - OPENAI_API_KEY (for OpenAI)\n' +
      '  - ANTHROPIC_API_KEY (for Anthropic)\n' +
      '  - Run local Ollama instance (https://ollama.ai/)\n\n' +
      'Run `wunderland api-keys` to configure.'
  );
}

/**
 * Command handler for `wunderland create <description>`.
 */
export default async function cmdCreate(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
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
  try {
    llmInvoker = await createLLMInvoker();
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
  const config: Record<string, unknown> = {
    seedId: extracted.seedId,
    displayName: extracted.displayName,
    bio: extracted.bio,
    systemPrompt: extracted.systemPrompt ?? 'You are an autonomous agent in the Wunderland network.',
    personality: extracted.personality,
    security: {
      tier: extracted.securityTier,
      preLLMClassifier: true,
      dualLLMAudit: true,
      outputSigning: true,
    },
    observability: {
      otel: { enabled: false, exportLogs: false },
    },
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
      `# Copy to .env and fill in real values
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
PORT=3777

# OBSERVABILITY (OpenTelemetry - opt-in)
# Enable OTEL in wunderland CLI runtime (wunderland start/chat):
# WUNDERLAND_OTEL_ENABLED=true
# WUNDERLAND_OTEL_LOGS_ENABLED=true
# OTEL_TRACES_EXPORTER=otlp
# OTEL_METRICS_EXPORTER=otlp
# OTEL_LOGS_EXPORTER=otlp
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
# OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# OTEL_TRACES_SAMPLER=parentbased_traceidratio
# OTEL_TRACES_SAMPLER_ARG=0.1
`,
      'utf8',
    );

    await writeFile(path.join(targetDir, '.gitignore'), '.env\nnode_modules\n', 'utf8');

    // Create skills directory
    const skillsDir = path.join(targetDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    await writeFile(path.join(skillsDir, '.gitkeep'), '', 'utf8');

    await writeFile(
      path.join(targetDir, 'README.md'),
      `# ${config.displayName}\n\nCreated via natural language agent builder.\n\n**Original description:** "${description}"\n\n## Run\n\n\`\`\`bash\ncp .env.example .env\nwunderland start\n\`\`\`\n\nAgent server:\n- GET http://localhost:3777/health\n- POST http://localhost:3777/chat { \"message\": \"Hello\", \"sessionId\": \"local\" }\n`,
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
