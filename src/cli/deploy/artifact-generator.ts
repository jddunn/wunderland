// @ts-nocheck
/**
 * @fileoverview Deploy artifact generator — reads agent.config.json and
 * resolves packages, secrets, and templates into deployable file contents.
 * @module wunderland/cli/deploy/artifact-generator
 */

import { createRequire } from 'node:module';
import {
  TOOL_CATALOG,
  CHANNEL_CATALOG,
  PROVIDER_CATALOG,
} from '@framers/agentos-extensions-registry';
import { SKILLS_CATALOG } from '@framers/agentos-skills-registry';
import type { DeployTarget } from './templates.js';
import {
  buildDockerfile,
  buildDockerCompose,
  buildRailwayToml,
  buildFlyToml,
  buildReadme,
  buildGitignore,
} from './templates.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DeployConfig {
  agentConfig: Record<string, unknown>;
  target: DeployTarget;
  port: number;
  outputDir: string;
  region?: string;
}

export interface DeployArtifacts {
  files: Map<string, string>;
  summary: DeploySummary;
}

export interface DeploySummary {
  target: DeployTarget;
  port: number;
  displayName: string;
  extensionPackages: string[];
  channelPackages: string[];
  requiredEnvVars: string[];
  missingChannelNotes: string[];
  skills: string[];
  channels: string[];
}

// ── Secret ID → Env Var ────────────────────────────────────────────────────

type SecretDef = { id: string; envVar?: string };

const require = createRequire(import.meta.url);

let _secretCatalog: SecretDef[] | null = null;
function getSecretCatalog(): SecretDef[] {
  if (_secretCatalog === null) {
    try {
      _secretCatalog = require('@framers/agentos/config/extension-secrets.json') as SecretDef[];
    } catch {
      _secretCatalog = [];
    }
  }
  return _secretCatalog;
}

/**
 * Convert a secret ID (e.g. "openai.apiKey") to its canonical env var name.
 * Mirrors the logic in `security/env-secrets.ts`.
 */
function secretIdToEnvVar(secretId: string): string {
  // Custom overrides matching the Rabbithole self-hosted page
  const OVERRIDES: Record<string, string> = {
    'unsplash.apiKey': 'UNSPLASH_ACCESS_KEY',
    'imessage.serverUrl': 'BLUEBUBBLES_SERVER_URL',
    'imessage.password': 'BLUEBUBBLES_PASSWORD',
    'googlechat.serviceAccount': 'GOOGLE_CHAT_SERVICE_ACCOUNT',
    'email.smtpHost': 'SMTP_HOST',
    'email.smtpUser': 'SMTP_USER',
    'email.smtpPassword': 'SMTP_PASSWORD',
  };
  if (OVERRIDES[secretId]) return OVERRIDES[secretId];

  // Check the canonical catalog
  const catalog = getSecretCatalog();
  const entry = catalog.find((s) => s.id === secretId);
  if (entry?.envVar) return entry.envVar;

  // Fallback: camelCase → SCREAMING_SNAKE_CASE
  const base = String(secretId ?? '').trim();
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

// ── Public channel packages (published on npm) ─────────────────────────────

const PUBLIC_CHANNEL_PACKAGES = new Set<string>([
  '@framers/agentos-ext-channel-telegram',
  '@framers/agentos-ext-channel-discord',
  '@framers/agentos-ext-channel-slack',
  '@framers/agentos-ext-channel-whatsapp',
  '@framers/agentos-ext-channel-webchat',
]);

// ── Package resolution ─────────────────────────────────────────────────────

export function resolveRequiredPackages(agentConfig: Record<string, unknown>): {
  toolPackages: string[];
  channelPackages: string[];
  missingChannelNotes: string[];
} {
  const extensions = (agentConfig.extensions ?? {}) as {
    tools?: string[];
    voice?: string[];
    productivity?: string[];
  };
  const channels = Array.isArray(agentConfig.channels) ? (agentConfig.channels as string[]) : [];

  const allToolNames = [
    ...(extensions.tools ?? []),
    ...(extensions.voice ?? []),
    ...(extensions.productivity ?? []),
  ];

  const toolEntryByName = new Map(TOOL_CATALOG.map((t) => [t.name, t] as const));
  const toolPackages = allToolNames
    .map((name) => toolEntryByName.get(name)?.packageName)
    .filter((pkg): pkg is string => typeof pkg === 'string' && pkg.trim().length > 0)
    .filter((pkg) => pkg !== '@framers/agentos-skills');

  const channelPackages: string[] = [];
  const missingChannelNotes: string[] = [];

  for (const platformId of channels) {
    const entry = CHANNEL_CATALOG.find((c) => c.platform === platformId);
    if (!entry?.packageName) continue;
    if (PUBLIC_CHANNEL_PACKAGES.has(entry.packageName)) {
      channelPackages.push(entry.packageName);
    } else {
      missingChannelNotes.push(entry.displayName);
    }
  }

  return {
    toolPackages: Array.from(new Set(toolPackages)),
    channelPackages: Array.from(new Set(channelPackages)),
    missingChannelNotes,
  };
}

// ── Secret resolution ──────────────────────────────────────────────────────

export function resolveRequiredSecrets(agentConfig: Record<string, unknown>): string[] {
  const secretIds = new Set<string>();

  // LLM provider secrets
  const providerId =
    typeof agentConfig.llmProvider === 'string' ? agentConfig.llmProvider.trim() : 'openai';
  const providerEntry = PROVIDER_CATALOG.find((p) => p.providerId === providerId);
  for (const s of providerEntry?.requiredSecrets ?? []) secretIds.add(s);

  // Extension secrets (tools + voice + productivity)
  const extensions = (agentConfig.extensions ?? {}) as {
    tools?: string[];
    voice?: string[];
    productivity?: string[];
  };
  const allToolNames = [
    ...(extensions.tools ?? []),
    ...(extensions.voice ?? []),
    ...(extensions.productivity ?? []),
  ];
  const toolEntryByName = new Map(TOOL_CATALOG.map((t) => [t.name, t] as const));
  for (const name of allToolNames) {
    for (const s of toolEntryByName.get(name)?.requiredSecrets ?? []) secretIds.add(s);
  }

  // Channel secrets
  const channels = Array.isArray(agentConfig.channels) ? (agentConfig.channels as string[]) : [];
  for (const platformId of channels) {
    const entry = CHANNEL_CATALOG.find((c) => c.platform === platformId);
    for (const s of entry?.requiredSecrets ?? []) secretIds.add(s);
  }

  // Skill secrets
  const skills = Array.isArray(agentConfig.skills) ? (agentConfig.skills as string[]) : [];
  for (const skillName of skills) {
    const entry = SKILLS_CATALOG.find((s) => s.name === skillName);
    for (const s of entry?.requiredSecrets ?? []) secretIds.add(s);
  }

  // Voice config
  const voiceConfig = agentConfig.voiceConfig as Record<string, unknown> | undefined;
  if (voiceConfig?.provider === 'elevenlabs') secretIds.add('elevenlabs.apiKey');

  return Array.from(secretIds);
}

// ── Env template generation ────────────────────────────────────────────────

export function generateEnvTemplate(opts: {
  secretIds: string[];
  channels: string[];
  port: number;
  llmModel?: string;
}): string {
  const envVars = opts.secretIds
    .map((id) => secretIdToEnvVar(id))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const lines: string[] = ['# Copy to .env and fill in real values'];
  lines.push(`PORT=${opts.port}`);
  lines.push(`OPENAI_MODEL=${opts.llmModel ?? 'gpt-4o'}`);
  lines.push('');

  if (envVars.length > 0) {
    lines.push('# Required secrets (derived from agent config)');
    for (const envVar of envVars) {
      if (envVar === 'DISCORD_BOT_TOKEN') {
        lines.push('DISCORD_BOT_TOKEN=');
        lines.push('# DISCORD_TOKEN=  # alias (supported by the Discord adapter)');
        continue;
      }
      lines.push(`${envVar}=`);
    }
    lines.push('');
  }

  // Channel-specific webhook env sections (mirrors Rabbithole self-hosted page)
  if (opts.channels.includes('line')) {
    lines.push('# LINE WEBHOOKS (optional)', '# LINE_WEBHOOK_PATH=/webhooks/line', '');
  }
  if (opts.channels.includes('sms')) {
    lines.push(
      '# TWILIO SMS WEBHOOK (optional)',
      '# TWILIO_SMS_WEBHOOK_PATH=/webhooks/twilio/sms',
      '# TWILIO_SMS_PUBLIC_BASE_URL=https://your-domain.com',
      '# TWILIO_SMS_WEBHOOK_URL=https://your-domain.com/webhooks/twilio/sms',
      '# TWILIO_SMS_SKIP_SIGNATURE_VALIDATION=false  # dev only',
      '',
    );
  }
  if (opts.channels.includes('imessage')) {
    lines.push(
      '# BLUEBUBBLES WEBHOOK (optional)',
      '# BLUEBUBBLES_WEBHOOK_PATH=/bluebubbles-webhook',
      '',
    );
  }
  if (opts.channels.includes('google-chat')) {
    lines.push(
      '# GOOGLE CHAT WEBHOOK (required for inbound events)',
      '# GOOGLE_CHAT_WEBHOOK_PATH=/google-chat-webhook',
      '# GOOGLE_CHAT_AUDIENCE_TYPE=chat',
      '# GOOGLE_CHAT_AUDIENCE=',
      '',
    );
  }
  if (opts.channels.includes('teams')) {
    lines.push(
      '# MICROSOFT TEAMS WEBHOOK (required for inbound events)',
      '# TEAMS_WEBHOOK_PATH=/teams-webhook',
      '',
    );
  }
  if (opts.channels.includes('feishu')) {
    lines.push(
      '# FEISHU / LARK WEBHOOK (required for inbound events)',
      '# FEISHU_WEBHOOK_PATH=/feishu-webhook',
      '',
    );
  }
  if (opts.channels.includes('zalouser')) {
    lines.push(
      '# ZALO PERSONAL (zca-cli) (unofficial)',
      '# ZCA_PROFILE=default',
      '# ZCA_CLI_PATH=zca',
      '',
    );
  }
  if (opts.channels.includes('irc')) {
    lines.push(
      '# IRC (optional)',
      '# IRC_TLS=false',
      '# IRC_NICKSERV_PASSWORD=',
      '# IRC_NICKSERV_SERVICE=NickServ',
      '',
    );
  }

  lines.push(
    '# OBSERVABILITY (OpenTelemetry - opt-in)',
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

// ── Main artifact generation ───────────────────────────────────────────────

export function generateDeployArtifacts(config: DeployConfig): DeployArtifacts {
  const { agentConfig, target, port, region } = config;

  const displayName =
    typeof agentConfig.displayName === 'string' ? agentConfig.displayName : 'Wunderbot';
  const llmModel =
    typeof agentConfig.llmModel === 'string' ? agentConfig.llmModel : undefined;
  const channels = Array.isArray(agentConfig.channels)
    ? (agentConfig.channels as string[])
    : [];
  const skills = Array.isArray(agentConfig.skills)
    ? (agentConfig.skills as string[])
    : [];

  // Resolve packages and secrets
  const { toolPackages, channelPackages, missingChannelNotes } =
    resolveRequiredPackages(agentConfig);
  const allPackages = Array.from(new Set([...toolPackages, ...channelPackages])).sort();
  const secretIds = resolveRequiredSecrets(agentConfig);

  // Build file contents
  const files = new Map<string, string>();

  files.set(
    'Dockerfile',
    buildDockerfile({ installPackages: allPackages, missingChannelNotes, port }),
  );

  files.set(
    '.env.example',
    generateEnvTemplate({ secretIds, channels, port, llmModel }),
  );

  files.set('.gitignore', buildGitignore());
  files.set('agent.config.json', JSON.stringify(agentConfig, null, 2) + '\n');
  files.set('README.md', buildReadme({ displayName, target, port }));

  // Target-specific files
  if (target === 'docker') {
    files.set('docker-compose.yml', buildDockerCompose(port));
  } else if (target === 'railway') {
    files.set('railway.toml', buildRailwayToml(port));
  } else if (target === 'fly') {
    files.set('fly.toml', buildFlyToml(port, region));
  }

  return {
    files,
    summary: {
      target,
      port,
      displayName,
      extensionPackages: toolPackages,
      channelPackages,
      requiredEnvVars: secretIds.map((id) => secretIdToEnvVar(id)).filter(Boolean).sort(),
      missingChannelNotes,
      skills,
      channels,
    },
  };
}
