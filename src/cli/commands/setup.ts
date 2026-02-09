/**
 * @fileoverview `wunderland setup` — interactive onboarding wizard entry point.
 * @module wunderland/cli/commands/setup
 */

import type { GlobalFlags } from '../types.js';
import { runSetupWizard } from '../wizards/setup-wizard.js';

export default async function cmdSetup(
  _args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await runSetupWizard(globals);
}
