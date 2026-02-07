/**
 * @fileoverview `wunderland voice` — voice call provider management and status.
 */

import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadEnv } from '../config/env-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';

const VOICE_PROVIDERS = [
  { id: 'twilio', label: 'Twilio', envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] },
  { id: 'telnyx', label: 'Telnyx', envVars: ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'] },
  { id: 'plivo', label: 'Plivo', envVars: ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN'] },
] as const;

async function voiceStatus(globals: GlobalFlags): Promise<void> {
  fmt.section('Voice Providers');
  fmt.blank();

  const env = await loadEnv(globals.config);
  const secretStatus = checkEnvSecrets();

  for (const provider of VOICE_PROVIDERS) {
    const allSet = provider.envVars.every(v => !!(env[v] || process.env[v]));
    const status = allSet ? sColor('configured') : wColor('not configured');
    console.log(`    ${accent(provider.label.padEnd(20))} ${status}`);

    for (const envVar of provider.envVars) {
      const secret = secretStatus.find(s => s.envVar === envVar);
      const isSet = !!(env[envVar] || process.env[envVar]);
      const val = isSet ? dim(secret?.maskedValue || 'set') : muted('not set');
      console.log(`      ${dim(envVar.padEnd(28))} ${val}`);
    }
  }
  fmt.blank();
  fmt.note(`Configure voice providers via ${accent('wunderland setup')} or by setting environment variables.`);
  fmt.blank();
}

export default async function cmdVoice(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'status' || !sub) {
    await voiceStatus(globals);
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${sub}" is not a voice subcommand. Available: status`);
  process.exitCode = 1;
}
