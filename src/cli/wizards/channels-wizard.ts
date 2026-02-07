/**
 * @fileoverview Channels wizard — platform selection + credential prompts.
 * @module wunderland/cli/wizards/channels-wizard
 */

import * as p from '@clack/prompts';
import type { WizardState } from '../types.js';
import { CHANNEL_PLATFORMS } from '../constants.js';
import { getSecretsForPlatform } from '../config/secrets.js';
import * as fmt from '../ui/format.js';

export async function runChannelsWizard(state: WizardState): Promise<void> {
  const options = CHANNEL_PLATFORMS.map((ch) => ({
    value: ch.id,
    label: `${ch.icon}  ${ch.label}`,
    hint: ch.tier === 'p0' ? 'stable' : ch.tier === 'p1' ? 'beta' : 'experimental',
  }));

  const defaultChannels = state.mode === 'quickstart' ? ['webchat'] : [];

  const selected = await p.multiselect({
    message: 'Connect messaging channels:',
    options,
    required: false,
    initialValues: defaultChannels,
  });

  if (p.isCancel(selected)) return;

  state.channels = selected as string[];

  // Collect credentials for each selected channel
  for (const channelId of state.channels) {
    const secrets = getSecretsForPlatform(channelId);
    if (secrets.length === 0) continue;

    const creds: Record<string, string> = {};

    for (const secret of secrets) {
      // Check env first
      const existing = process.env[secret.envVar];
      if (existing) {
        fmt.ok(`${secret.label}: already set`);
        creds[secret.envVar] = existing;
        continue;
      }

      const value = await p.password({
        message: `${secret.label}:`,
        validate: (val: string) => {
          if (!val && !secret.optional) return `${secret.label} is required`;
          return undefined;
        },
      });

      if (p.isCancel(value)) break;
      if (value) creds[secret.envVar] = value as string;

      if (secret.docsUrl) {
        fmt.note(`Get one at: ${fmt.link(secret.docsUrl)}`);
      }
    }

    if (Object.keys(creds).length > 0) {
      state.channelCredentials[channelId] = creds;
    }
  }
}
