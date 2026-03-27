/**
 * @fileoverview `wunderland audio` — music and SFX generation via AgentOS providers.
 * @module wunderland/cli/commands/audio
 */
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { shutdownWunderlandOtel, startWunderlandOtel } from '../../observability/otel.js';

/**
 * Handles the `wunderland audio` CLI command.
 *
 * Subcommands:
 * - `music <prompt>` — generate music from a text prompt
 * - `sfx <prompt>` — generate a sound effect from a text prompt
 *
 * @param args - Positional arguments after the `audio` command token.
 * @param flags - Parsed flag map from the CLI argument parser.
 * @param globals - Global flags (config path, quiet mode, theme, etc.).
 */
export default async function cmdAudio(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland audio');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('music <prompt>')}      Generate music from a text prompt
    ${dim('sfx <prompt>')}        Generate a sound effect from a text prompt

  ${accent('Flags:')}
    ${dim('--provider <name>')}    Audio provider (suno, udio, elevenlabs, stability)
    ${dim('--model <model>')}      Explicit model override
    ${dim('--duration <secs>')}    Audio duration in seconds (default: 30 for music, 5 for sfx)
    ${dim('--bpm <number>')}       Tempo in beats per minute (music only)
    ${dim('--genre <name>')}       Music genre hint (e.g. electronic, jazz, ambient)
    ${dim('--mood <name>')}        Mood hint (e.g. upbeat, melancholic, intense, calm)
    ${dim('--output <path>')}      Save audio to file
`);
    return;
  }

  if (sub === 'music') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) {
      fmt.errorBlock('Missing prompt', 'Usage: wunderland audio music "your prompt here"');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const model = flags.model as string | undefined;
    const duration = flags.duration ? parseFloat(flags.duration as string) : undefined;
    const bpm = flags.bpm ? parseInt(flags.bpm as string, 10) : undefined;
    const genre = flags.genre as string | undefined;
    const mood = flags.mood as string | undefined;
    const output = flags.output as string | undefined;

    try {
      const { generateMusic } = await import('@framers/agentos');
      const { recordWunderlandTokenUsage } = await import('../../observability/token-usage.js');
      const request: Record<string, unknown> = { prompt };
      if (provider) request['provider'] = provider;
      if (model) request['model'] = model;
      if (duration) request['duration'] = duration;
      if (bpm) request['bpm'] = bpm;
      if (genre) request['genre'] = genre;
      if (mood) request['mood'] = mood;
      await startWunderlandOtel({ serviceName: 'wunderland-audio' });

      console.log(`\n  ${accent('●')} Generating music...`);
      const result = await generateMusic(request as any);
      await recordWunderlandTokenUsage({
        sessionId: `wunderland-audio-music-${Date.now()}`,
        providerId: result.provider,
        model: result.model,
        source: 'audio',
        configDirOverride: globals.config,
        usage: result.usage
          ? {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens,
              totalCostUSD: result.usage.totalCostUSD,
            }
          : null,
      });

      if (output && result.audio) {
        const { writeFile } = await import('node:fs/promises');
        const audio = result.audio;
        if (audio.base64) {
          await writeFile(output, Buffer.from(audio.base64, 'base64'));
          console.log(`  └── ${accent('✓')} Saved to ${output}\n`);
        } else if (audio.url) {
          console.log(`  └── ${accent('✓')} URL: ${audio.url}\n`);
        }
      } else {
        const audio = result.audio;
        if (audio?.url) {
          console.log(`  └── ${accent('✓')} URL: ${audio.url}\n`);
        } else if (audio?.base64) {
          console.log(`  └── ${accent('✓')} Generated (base64, ${audio.base64.length} chars). Use --output to save.\n`);
        } else {
          console.log(`  └── ${accent('✓')} Generated\n`);
        }
      }
    } catch (err) {
      fmt.errorBlock('Music generation failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
  } else if (sub === 'sfx') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) {
      fmt.errorBlock('Missing prompt', 'Usage: wunderland audio sfx "your prompt here"');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const model = flags.model as string | undefined;
    const duration = flags.duration ? parseFloat(flags.duration as string) : undefined;
    const output = flags.output as string | undefined;

    try {
      const { generateSFX } = await import('@framers/agentos');
      const { recordWunderlandTokenUsage } = await import('../../observability/token-usage.js');
      const request: Record<string, unknown> = { prompt };
      if (provider) request['provider'] = provider;
      if (model) request['model'] = model;
      if (duration) request['duration'] = duration;
      await startWunderlandOtel({ serviceName: 'wunderland-audio' });

      console.log(`\n  ${accent('●')} Generating sound effect...`);
      const result = await generateSFX(request as any);
      await recordWunderlandTokenUsage({
        sessionId: `wunderland-audio-sfx-${Date.now()}`,
        providerId: result.provider,
        model: result.model,
        source: 'audio',
        configDirOverride: globals.config,
        usage: result.usage
          ? {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens,
              totalCostUSD: result.usage.totalCostUSD,
            }
          : null,
      });

      if (output && result.audio) {
        const { writeFile } = await import('node:fs/promises');
        const audio = result.audio;
        if (audio.base64) {
          await writeFile(output, Buffer.from(audio.base64, 'base64'));
          console.log(`  └── ${accent('✓')} Saved to ${output}\n`);
        } else if (audio.url) {
          console.log(`  └── ${accent('✓')} URL: ${audio.url}\n`);
        }
      } else {
        const audio = result.audio;
        if (audio?.url) {
          console.log(`  └── ${accent('✓')} URL: ${audio.url}\n`);
        } else if (audio?.base64) {
          console.log(`  └── ${accent('✓')} Generated (base64, ${audio.base64.length} chars). Use --output to save.\n`);
        } else {
          console.log(`  └── ${accent('✓')} Generated\n`);
        }
      }
    } catch (err) {
      fmt.errorBlock('SFX generation failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland audio')} for help.`);
    process.exitCode = 1;
  }
}
