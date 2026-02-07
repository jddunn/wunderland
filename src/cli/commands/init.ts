/**
 * @fileoverview `wunderland init <dir>` — scaffold a new Wunderbot project.
 * @module wunderland/cli/commands/init
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { PERSONALITY_PRESETS } from '../constants.js';
import { accent, success as sColor, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { HEXACO_PRESETS } from '../../core/WunderlandSeed.js';
import { PresetLoader, type AgentPreset } from '../../core/PresetLoader.js';
import { isValidSecurityTier, getSecurityTier } from '../../security/SecurityTiers.js';
import type { SecurityTierName } from '../../security/SecurityTiers.js';

function toSeedId(dirName: string): string {
  const base = dirName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return base ? `seed_${base}` : `seed_${Date.now()}`;
}

function toDisplayName(dirName: string): string {
  const cleaned = dirName.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'My Agent';
  return cleaned.split(' ').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
}

export default async function cmdInit(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const dirName = args[0];
  if (!dirName) {
    fmt.errorBlock('Missing directory name', 'Usage: wunderland init <dir>');
    process.exitCode = 1;
    return;
  }

  const targetDir = path.resolve(process.cwd(), dirName);

  if (existsSync(targetDir)) {
    const entries = await readdir(targetDir).catch(() => []);
    if (entries.length > 0 && flags['force'] !== true) {
      fmt.errorBlock('Directory not empty', `${targetDir}\nRe-run with --force to write files anyway.`);
      process.exitCode = 1;
      return;
    }
  }

  await mkdir(targetDir, { recursive: true });

  // ── Resolve preset ────────────────────────────────────────────────────
  const presetFlag = typeof flags['preset'] === 'string' ? flags['preset'] : undefined;
  let agentPreset: AgentPreset | undefined;
  let hexacoValues: (typeof HEXACO_PRESETS)[keyof typeof HEXACO_PRESETS] | undefined;

  if (presetFlag) {
    // Try agent presets first (lowercase-hyphen IDs like "research-assistant")
    try {
      const loader = new PresetLoader();
      agentPreset = loader.loadPreset(presetFlag.toLowerCase().replace(/_/g, '-'));
    } catch {
      // Not an agent preset — try HEXACO personality presets
    }

    if (!agentPreset) {
      const key = presetFlag.toUpperCase().replace(/-/g, '_');
      hexacoValues = HEXACO_PRESETS[key as keyof typeof HEXACO_PRESETS];
    }

    if (!agentPreset && !hexacoValues) {
      fmt.warning(`Unknown preset "${presetFlag}". Using default personality values.`);
      fmt.note(`Run ${accent('wunderland list-presets')} to see available presets.`);
    }
  }

  // ── Personality ────────────────────────────────────────────────────────
  let personality: Record<string, number>;
  if (agentPreset) {
    const t = agentPreset.hexacoTraits;
    personality = {
      honesty: t.honesty,
      emotionality: t.emotionality,
      extraversion: t.extraversion,
      agreeableness: t.agreeableness,
      conscientiousness: t.conscientiousness,
      openness: t.openness,
    };
  } else if (hexacoValues) {
    personality = {
      honesty: hexacoValues.honesty_humility,
      emotionality: hexacoValues.emotionality,
      extraversion: hexacoValues.extraversion,
      agreeableness: hexacoValues.agreeableness,
      conscientiousness: hexacoValues.conscientiousness,
      openness: hexacoValues.openness,
    };
  } else {
    personality = {
      honesty: 0.7,
      emotionality: 0.5,
      extraversion: 0.6,
      agreeableness: 0.65,
      conscientiousness: 0.8,
      openness: 0.75,
    };
  }

  // ── Security ───────────────────────────────────────────────────────────
  const VALID_TIERS = ['dangerous', 'permissive', 'balanced', 'strict', 'paranoid'];
  const securityTierFlag = typeof flags['security-tier'] === 'string'
    ? flags['security-tier'].toLowerCase()
    : agentPreset?.securityTier?.toLowerCase();
  let securityTierName: SecurityTierName | undefined;

  if (securityTierFlag) {
    if (isValidSecurityTier(securityTierFlag)) {
      securityTierName = securityTierFlag;
    } else if (typeof flags['security-tier'] === 'string') {
      fmt.errorBlock(
        'Invalid security tier',
        `"${securityTierFlag}" is not a valid tier.\nValid tiers: ${VALID_TIERS.join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const tierConfig = securityTierName ? getSecurityTier(securityTierName) : undefined;
  const security = tierConfig
    ? {
        tier: tierConfig.name,
        preLLMClassifier: tierConfig.pipelineConfig.enablePreLLM,
        dualLLMAudit: tierConfig.pipelineConfig.enableDualLLMAudit,
        outputSigning: tierConfig.pipelineConfig.enableOutputSigning,
        riskThreshold: tierConfig.riskThreshold,
      }
    : { preLLMClassifier: true, dualLLMAudit: true, outputSigning: true };

  // ── Build config ───────────────────────────────────────────────────────
  const config: Record<string, unknown> = {
    seedId: toSeedId(dirName),
    displayName: agentPreset?.name ?? toDisplayName(dirName),
    bio: agentPreset?.description ?? 'Autonomous Wunderland agent',
    personality,
    systemPrompt: 'You are an autonomous agent in the Wunderland network.',
    security,
    skills: agentPreset?.suggestedSkills ?? [],
    suggestedChannels: agentPreset?.suggestedChannels ?? [],
    presetId: agentPreset?.id,
    skillsDir: './skills',
  };

  // Write files
  await writeFile(
    path.join(targetDir, 'agent.config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );

  await writeFile(
    path.join(targetDir, '.env.example'),
    `# Copy to .env and fill in real values\nOPENAI_API_KEY=sk-...\nOPENAI_MODEL=gpt-4o-mini\nPORT=3777\n`,
    'utf8',
  );

  await writeFile(path.join(targetDir, '.gitignore'), '.env\nnode_modules\n', 'utf8');

  // Create skills directory
  const skillsDir = path.join(targetDir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  await writeFile(path.join(skillsDir, '.gitkeep'), '', 'utf8');

  // Copy PERSONA.md from preset if available
  if (agentPreset?.persona) {
    await writeFile(path.join(targetDir, 'PERSONA.md'), agentPreset.persona, 'utf8');
  }

  await writeFile(
    path.join(targetDir, 'README.md'),
    `# ${config.displayName}\n\nScaffolded by the Wunderland CLI.\n\n## Run\n\n\`\`\`bash\ncp .env.example .env\nwunderland start\n\`\`\`\n\nAgent server:\n- GET http://localhost:3777/health\n- POST http://localhost:3777/chat { "message": "Hello", "sessionId": "local" }\n\nNotes:\n- By default, \`wunderland start\` runs in headless-safe mode (no interactive approvals).\n- Enable the full toolset with: \`wunderland start --yes\` (shell command safety checks remain on).\n- Disable shell safety checks with: \`wunderland start --dangerously-skip-command-safety --yes\` or \`wunderland start --dangerously-skip-permissions\`.\n\n## Skills\n\nAdd custom SKILL.md files to the \`skills/\` directory.\nEnable curated skills with: \`wunderland skills enable <name>\`\n`,
    'utf8',
  );

  // ── Output ─────────────────────────────────────────────────────────────
  fmt.section('Project Initialized');
  fmt.kvPair('Directory', accent(targetDir));
  fmt.kvPair('Seed ID', String(config.seedId));
  fmt.kvPair('Display Name', String(config.displayName));

  if (agentPreset) {
    fmt.kvPair('Preset', accent(agentPreset.id));
    fmt.kvPair('Security Tier', accent(agentPreset.securityTier));
    if (agentPreset.suggestedSkills.length > 0) {
      fmt.kvPair('Skills', agentPreset.suggestedSkills.join(', '));
    }
    if (agentPreset.suggestedChannels.length > 0) {
      fmt.kvPair('Channels', agentPreset.suggestedChannels.join(', '));
    }
  } else {
    const presetKey = presetFlag?.toUpperCase().replace(/-/g, '_');
    if (presetKey && hexacoValues) {
      const preset = PERSONALITY_PRESETS.find((p) => p.id === presetKey);
      fmt.kvPair('Personality', preset ? preset.label : presetKey);
    }
    if (securityTierName && tierConfig) {
      fmt.kvPair('Security Tier', accent(tierConfig.displayName));
      fmt.kvPair('', dim(tierConfig.description));
    }
  }

  fmt.kvPair('Skills Dir', dim('./skills'));
  fmt.blank();
  fmt.note(`Next: ${sColor(`cd ${dirName}`)} && ${sColor('cp .env.example .env')} && ${sColor('wunderland start')}`);
  fmt.blank();
}
