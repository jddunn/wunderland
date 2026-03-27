/**
 * @fileoverview `wunderland video` — video generation and analysis via AgentOS providers.
 * @module wunderland/cli/commands/video
 */
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { shutdownWunderlandOtel, startWunderlandOtel } from '../../observability/otel.js';

/**
 * Handles the `wunderland video` CLI command.
 *
 * Subcommands:
 * - `generate <prompt>` — generate a video from a text prompt
 * - `animate <image> <prompt>` — generate a video from an image + text prompt
 * - `analyze <file>` — analyze a video file
 *
 * @param args - Positional arguments after the `video` command token.
 * @param flags - Parsed flag map from the CLI argument parser.
 * @param globals - Global flags (config path, quiet mode, theme, etc.).
 */
export default async function cmdVideo(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland video');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('generate <prompt>')}                Generate a video from a text prompt
    ${dim('animate <image> <prompt>')}         Generate a video from an image + text prompt
    ${dim('analyze <file>')}                   Analyze a video file (describe, transcribe)

  ${accent('Flags:')}
    ${dim('--provider <name>')}    Video provider (runway, pika, stability, replicate)
    ${dim('--model <model>')}      Explicit model override
    ${dim('--duration <secs>')}    Video duration in seconds (default: 4)
    ${dim('--aspect-ratio <r>')}   Aspect ratio (16:9, 9:16, 1:1, 4:3)
    ${dim('--resolution <res>')}   Resolution (720p, 1080p, 4k)
    ${dim('--output <path>')}      Save video to file
`);
    return;
  }

  if (sub === 'generate') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) {
      fmt.errorBlock('Missing prompt', 'Usage: wunderland video generate "your prompt here"');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const model = flags.model as string | undefined;
    const duration = flags.duration ? parseFloat(flags.duration as string) : undefined;
    const aspectRatio = (flags['aspect-ratio'] ?? flags.aspectRatio) as string | undefined;
    const resolution = flags.resolution as string | undefined;
    const output = flags.output as string | undefined;

    try {
      const { generateVideo } = await import('@framers/agentos');
      const { recordWunderlandTokenUsage } = await import('../../observability/token-usage.js');
      const request: Record<string, unknown> = { prompt };
      if (provider) request['provider'] = provider;
      if (model) request['model'] = model;
      if (duration) request['duration'] = duration;
      if (aspectRatio) request['aspectRatio'] = aspectRatio;
      if (resolution) request['resolution'] = resolution;
      await startWunderlandOtel({ serviceName: 'wunderland-video' });

      console.log(`\n  ${accent('●')} Generating video...`);
      const result = await generateVideo(request as any);
      await recordWunderlandTokenUsage({
        sessionId: `wunderland-video-${Date.now()}`,
        providerId: result.provider,
        model: result.model,
        source: 'video',
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

      if (output && result.video) {
        const { writeFile } = await import('node:fs/promises');
        const vid = result.video;
        if (vid.base64) {
          await writeFile(output, Buffer.from(vid.base64, 'base64'));
          console.log(`  └── ${accent('✓')} Saved to ${output}\n`);
        } else if (vid.url) {
          console.log(`  └── ${accent('✓')} URL: ${vid.url}\n`);
        }
      } else {
        const vid = result.video;
        if (vid?.url) {
          console.log(`  └── ${accent('✓')} URL: ${vid.url}\n`);
        } else if (vid?.base64) {
          console.log(`  └── ${accent('✓')} Generated (base64, ${vid.base64.length} chars). Use --output to save.\n`);
        } else {
          console.log(`  └── ${accent('✓')} Generated\n`);
        }
      }
    } catch (err) {
      fmt.errorBlock('Video generation failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
  } else if (sub === 'animate') {
    const inputImage = args[1];
    const prompt = args.slice(2).join(' ');
    if (!inputImage) {
      fmt.errorBlock('Missing input image', 'Usage: wunderland video animate <image> "your prompt here"');
      process.exitCode = 1;
      return;
    }
    if (!prompt) {
      fmt.errorBlock('Missing prompt', 'Usage: wunderland video animate <image> "your prompt here"');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const model = flags.model as string | undefined;
    const duration = flags.duration ? parseFloat(flags.duration as string) : undefined;
    const aspectRatio = (flags['aspect-ratio'] ?? flags.aspectRatio) as string | undefined;
    const resolution = flags.resolution as string | undefined;
    const output = flags.output as string | undefined;

    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { generateVideo } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-video' });

      const imageBuffer = await readFile(inputImage);
      const request: Record<string, unknown> = { prompt, image: imageBuffer };
      if (provider) request['provider'] = provider;
      if (model) request['model'] = model;
      if (duration) request['duration'] = duration;
      if (aspectRatio) request['aspectRatio'] = aspectRatio;
      if (resolution) request['resolution'] = resolution;

      console.log(`\n  ${accent('●')} Animating image...`);
      const result = await generateVideo(request as any);

      if (output && result.video) {
        const vid = result.video;
        if (vid.base64) {
          await writeFile(output, Buffer.from(vid.base64, 'base64'));
          console.log(`  └── ${accent('✓')} Saved to ${output}\n`);
        } else if (vid.url) {
          console.log(`  └── ${accent('✓')} URL: ${vid.url}\n`);
        }
      } else {
        const vid = result.video;
        if (vid?.url) {
          console.log(`  └── ${accent('✓')} URL: ${vid.url}\n`);
        } else if (vid?.base64) {
          console.log(`  └── ${accent('✓')} Animated (base64, ${vid.base64.length} chars). Use --output to save.\n`);
        } else {
          console.log(`  └── ${accent('✓')} Animated\n`);
        }
      }
    } catch (err) {
      fmt.errorBlock('Video animation failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
  } else if (sub === 'analyze') {
    const inputFile = args[1];
    if (!inputFile) {
      fmt.errorBlock('Missing video file', 'Usage: wunderland video analyze <file>');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const output = flags.output as string | undefined;

    try {
      const { readFile } = await import('node:fs/promises');
      const { analyzeVideo } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-video' });

      const videoBuffer = await readFile(inputFile);
      const request: Record<string, unknown> = { video: videoBuffer };
      if (provider) request['provider'] = provider;

      console.log(`\n  ${accent('●')} Analyzing video...`);
      const result = await analyzeVideo(request as any);

      if (output) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(output, JSON.stringify(result, null, 2));
        console.log(`  └── ${accent('✓')} Analysis saved to ${output}\n`);
      } else {
        if (result.description) {
          console.log(`  └── ${accent('Description:')} ${result.description}`);
        }
        if (result.transcript) {
          console.log(`  └── ${accent('Transcript:')} ${result.transcript.slice(0, 200)}${result.transcript.length > 200 ? '...' : ''}`);
        }
        if (result.scenes?.length) {
          console.log(`  └── ${accent('Scenes:')} ${result.scenes.length} detected`);
        }
        console.log();
      }
    } catch (err) {
      fmt.errorBlock('Video analysis failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland video')} for help.`);
    process.exitCode = 1;
  }
}
