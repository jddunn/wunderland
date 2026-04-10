// @ts-nocheck
/**
 * @fileoverview Tool API keys wizard — collect keys for search, media, voice, and devtools.
 * @module wunderland/cli/wizards/tool-keys-wizard
 */

import * as p from '@clack/prompts';
import type { WizardState } from '../types.js';
import { TOOL_KEY_PROVIDERS } from '../constants.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { mergeEnv } from '../config/env-manager.js';

const CATEGORY_LABELS: Record<string, string> = {
  search: 'Web Search',
  media: 'Images & Media',
  voice: 'Voice & Speech',
  devtools: 'Developer Tools',
};

export async function runToolKeysWizard(state: WizardState): Promise<void> {
  fmt.section('Tool API Keys');
  fmt.note('These keys enable agent tools (web search, image search, voice, etc.).\nAll keys are optional — skip any you don\'t need.');
  fmt.blank();

  // Group providers by category
  const categories = [...new Set(TOOL_KEY_PROVIDERS.map((p) => p.category))];
  const g = glyphs();

  // Show what's already set
  const alreadySet = TOOL_KEY_PROVIDERS.filter((p) => process.env[p.envVar]);
  if (alreadySet.length > 0) {
    fmt.note(`${alreadySet.length} tool key${alreadySet.length > 1 ? 's' : ''} already set in environment:`);
    for (const p of alreadySet) {
      const masked = process.env[p.envVar]!;
      const last4 = masked.length > 4 ? '••••' + masked.slice(-4) : '••••';
      fmt.ok(`${p.label}: ${last4}`);
    }
    fmt.blank();
  }

  // Ask which categories to configure
  const missing = TOOL_KEY_PROVIDERS.filter((p) => !process.env[p.envVar]);
  if (missing.length === 0) {
    fmt.ok('All tool keys are already configured!');
    return;
  }

  const wantsConfigure = await p.confirm({
    message: `Configure ${missing.length} missing tool key${missing.length > 1 ? 's' : ''}?`,
    initialValue: false,
  });

  if (p.isCancel(wantsConfigure) || !wantsConfigure) return;

  // Collect keys per category
  const keysToSave: Record<string, string> = {};

  for (const category of categories) {
    const providers = missing.filter((p) => p.category === category);
    if (providers.length === 0) continue;

    const catLabel = CATEGORY_LABELS[category] || category;
    fmt.blank();
    fmt.note(accent(`${catLabel}:`));

    for (const provider of providers) {
      const key = await p.password({
        message: `${provider.label} (${provider.envVar}):`,
        validate: () => undefined, // all optional
      });

      if (p.isCancel(key)) return;
      if (key && (key as string).trim()) {
        keysToSave[provider.envVar] = (key as string).trim();
        fmt.ok(`${provider.label}: saved`);
      } else {
        console.log(`  ${dim(g.circle)} ${provider.label}: skipped`);
        if (provider.signupUrl) {
          console.log(`    ${dim('→')} ${dim(provider.signupUrl)}`);
        }
      }
    }
  }

  // Save all collected keys
  if (Object.keys(keysToSave).length > 0) {
    await mergeEnv(keysToSave);
    // Also put into state for downstream steps
    for (const [k, v] of Object.entries(keysToSave)) {
      state.toolKeys = state.toolKeys || {};
      state.toolKeys[k] = v;
    }
    fmt.blank();
    fmt.ok(`${Object.keys(keysToSave).length} tool key${Object.keys(keysToSave).length > 1 ? 's' : ''} saved to ~/.wunderland/.env`);
  }

  fmt.blank();
}
