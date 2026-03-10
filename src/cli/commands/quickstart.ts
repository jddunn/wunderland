/**
 * @fileoverview `wunderland quickstart` — detect env, scaffold, and start in one command.
 * @module wunderland/cli/commands/quickstart
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { LLM_PROVIDERS } from '../constants.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

export default async function cmdQuickstart(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const g = glyphs();
  fmt.section('Quickstart');

  // Step 1: Detect existing API keys
  let detectedProvider: string | null = null;
  let detectedModel: string | null = null;

  for (const provider of LLM_PROVIDERS) {
    if (provider.envVar && process.env[provider.envVar]) {
      detectedProvider = provider.id;
      detectedModel = provider.models[0] as string;
      fmt.ok(`${provider.label} key detected in environment`);
      break;
    }
  }

  if (!detectedProvider) {
    fmt.warning('No LLM API key found in environment.');
    fmt.blank();
    fmt.note('Set one of these in your .env or environment:');
    for (const provider of LLM_PROVIDERS.slice(0, 4)) {
      if (provider.envVar) {
        console.log(`  ${dim(provider.envVar)}  ${dim('→')} ${dim(provider.signupUrl)}`);
      }
    }
    fmt.blank();
    fmt.note(`Or run ${accent('wunderland setup')} for interactive configuration.`);
    return;
  }

  // Step 2: Scaffold agent in current directory or new directory
  const dirName = typeof flags['dir'] === 'string' ? flags['dir'] : 'wunderbot';
  const targetDir = path.resolve(process.cwd(), dirName);

  if (existsSync(path.join(targetDir, 'agent.config.json'))) {
    fmt.ok(`Agent already scaffolded at ${accent(dirName)}/`);
  } else {
    // Import and run init
    const cmdInit = (await import('./init.js')).default;
    await cmdInit(
      [dirName],
      { preset: 'personal-assistant', yes: true, ...flags },
      globals,
    );
  }

  // Step 3: Offer to start
  fmt.blank();
  fmt.panel({
    title: `${g.ok} Ready to Go`,
    style: 'success',
    content: [
      `Agent:    ${accent(dirName)}`,
      `Provider: ${accent(detectedProvider)}`,
      `Model:    ${accent(detectedModel || 'default')}`,
      '',
      'Next steps:',
      `  ${accent(`cd ${dirName}`)}`,
      `  ${accent('wunderland start')}`,
      '',
      `Or try: ${accent('wunderland chat')} for an interactive session`,
      `        ${accent('wunderland skills search <query>')} to find tools`,
      `        ${accent('wunderland doctor')} to verify everything`,
    ].join('\n'),
  });
  fmt.blank();
}
