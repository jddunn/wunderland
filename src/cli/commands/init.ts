/**
 * @fileoverview `wunderland init <dir>` — scaffold a new Wunderbot project.
 * Ported from bin/wunderland.js cmdInit() with color output + preset support.
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
import { isValidSecurityTier, getSecurityTier } from '../../security/SecurityTiers.js';
import type { SecurityTierName } from '../../security/SecurityTiers.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function toSeedId(dirName: string): string {
  const base = dirName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return base ? `seed_${base}` : `seed_${Date.now()}`;
}

function toDisplayName(dirName: string): string {
  const cleaned = dirName.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'My Agent';
  return cleaned
    .split(' ')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

// ── Command ─────────────────────────────────────────────────────────────────

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

  // Check if dir exists and non-empty
  if (existsSync(targetDir)) {
    const entries = await readdir(targetDir).catch(() => []);
    if (entries.length > 0 && flags['force'] !== true) {
      fmt.errorBlock('Directory not empty', `${targetDir}\nRe-run with --force to write files anyway.`);
      process.exitCode = 1;
      return;
    }
  }

  await mkdir(targetDir, { recursive: true });

  // Resolve personality preset
  const presetKey = typeof flags['preset'] === 'string' ? flags['preset'].toUpperCase().replace(/-/g, '_') : undefined;
  const hexacoValues = presetKey && HEXACO_PRESETS[presetKey as keyof typeof HEXACO_PRESETS]
    ? HEXACO_PRESETS[presetKey as keyof typeof HEXACO_PRESETS]
    : undefined;

  // Warn if --preset was given but didn't match any known preset
  if (presetKey && !hexacoValues) {
    fmt.warning(`Unknown preset "${flags['preset']}". Using default personality values.`);
    fmt.note(`Run ${accent('wunderland list-presets')} to see available presets.`);
  }

  const personality = hexacoValues
    ? {
        honesty: hexacoValues.honesty_humility,
        emotionality: hexacoValues.emotionality,
        extraversion: hexacoValues.extraversion,
        agreeableness: hexacoValues.agreeableness,
        conscientiousness: hexacoValues.conscientiousness,
        openness: hexacoValues.openness,
      }
    : {
        honesty: 0.7,
        emotionality: 0.5,
        extraversion: 0.6,
        agreeableness: 0.65,
        conscientiousness: 0.8,
        openness: 0.75,
      };

  // Resolve security tier
  const VALID_TIERS = ['dangerous', 'permissive', 'balanced', 'strict', 'paranoid'];
  const securityTierFlag = typeof flags['security-tier'] === 'string' ? flags['security-tier'].toLowerCase() : undefined;
  let securityTierName: SecurityTierName | undefined;

  if (securityTierFlag) {
    if (isValidSecurityTier(securityTierFlag)) {
      securityTierName = securityTierFlag;
    } else {
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

  const config: Record<string, unknown> = {
    seedId: toSeedId(dirName),
    displayName: toDisplayName(dirName),
    bio: 'Autonomous Wunderland agent',
    personality,
    systemPrompt: 'You are an autonomous agent in the Wunderland network.',
    security,
    skills: [],
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
  await writeFile(
    path.join(skillsDir, '.gitkeep'),
    '',
    'utf8',
  );

  await writeFile(
    path.join(targetDir, 'README.md'),
    `# ${config.displayName}\n\nScaffolded by the Wunderland CLI.\n\n## Run\n\n\`\`\`bash\ncp .env.example .env\nwunderland start\n\`\`\`\n\nAgent server:\n- GET http://localhost:3777/health\n- POST http://localhost:3777/chat { \"message\": \"Hello\", \"sessionId\": \"local\" }\n\nNotes:\n- By default, side-effect tools are disabled (shell execution + file writes).\n- Enable side effects with: \`wunderland start --yes\` (shell safety checks remain on).\n- Fully disable shell safety checks with: \`wunderland start --dangerously-skip-permissions\`.\n\n## Skills\n\nAdd custom SKILL.md files to the \`skills/\` directory.\nEnable curated skills with: \`wunderland skills enable <name>\`\n`,
    'utf8',
  );

  // Output
  fmt.section('Project Initialized');
  fmt.kvPair('Directory', accent(targetDir));
  fmt.kvPair('Seed ID', String(config.seedId));
  fmt.kvPair('Display Name', String(config.displayName));
  if (presetKey && hexacoValues) {
    const preset = PERSONALITY_PRESETS.find((p) => p.id === presetKey);
    fmt.kvPair('Personality', preset ? preset.label : presetKey);
  }
  if (securityTierName && tierConfig) {
    fmt.kvPair('Security Tier', accent(tierConfig.displayName));
    fmt.kvPair('', dim(tierConfig.description));
  }
  fmt.kvPair('Skills Dir', dim('./skills'));
  fmt.blank();
  fmt.note(`Next: ${sColor(`cd ${dirName}`)} && ${sColor('cp .env.example .env')} && ${sColor('wunderland start')}`);
  fmt.blank();
}
