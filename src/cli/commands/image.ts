/**
 * @fileoverview `wunderland image` — image generation via AgentOS providers.
 * @module wunderland/cli/commands/image
 */
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { shutdownWunderlandOtel, startWunderlandOtel } from '../../observability/otel.js';

/**
 * Handles the `wunderland image` CLI command.
 *
 * Subcommands:
 * - `generate <prompt>` — generate an image from a text prompt
 *
 * @param args - Positional arguments after the `image` command token.
 * @param flags - Parsed flag map from the CLI argument parser.
 * @param globals - Global flags (config path, quiet mode, theme, etc.).
 */
export default async function cmdImage(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland image');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('generate <prompt>')}     Generate an image from a text prompt

  ${accent('Flags:')}
    ${dim('--provider <name>')}    Image provider (openai, stability, replicate, ollama)
    ${dim('--model <model>')}      Explicit model override
    ${dim('--size <WxH>')}         Image dimensions (e.g. 1024x1024)
    ${dim('--output <path>')}      Save image to file
`);
    return;
  }

  if (sub === 'generate') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) {
      fmt.errorBlock('Missing prompt', 'Usage: wunderland image generate "your prompt here"');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const model = flags.model as string | undefined;
    const size = flags.size as string | undefined;
    const output = flags.output as string | undefined;

	    try {
	      const { generateImage } = await import('@framers/agentos');
        const { recordWunderlandTokenUsage } = await import('../../observability/token-usage.js');
	      const request: Record<string, unknown> = { prompt };
	      if (provider) request['provider'] = provider;
	      if (model) request['model'] = model;
	      if (size) request['size'] = size;
	      await startWunderlandOtel({ serviceName: 'wunderland-image' });

	      console.log(`\n  ${accent('●')} Generating image...`);
	      const result = await generateImage(request as any);
        await recordWunderlandTokenUsage({
          sessionId: `wunderland-image-${Date.now()}`,
          providerId: result.provider,
          model: result.model,
          source: 'image',
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

	      if (output && result.images?.[0]) {
	        // If output path specified, save the image (base64) or print the URL.
	        const { writeFile } = await import('node:fs/promises');
	        const img = result.images[0];
	        if (img.base64) {
	          await writeFile(output, Buffer.from(img.base64, 'base64'));
	          console.log(`  └── ${accent('✓')} Saved to ${output}\n`);
	        } else if (img.url) {
	          console.log(`  └── ${accent('✓')} URL: ${img.url}\n`);
	        }
	      } else {
	        const img = result.images?.[0];
	        if (img?.url) {
	          console.log(`  └── ${accent('✓')} URL: ${img.url}\n`);
	        } else if (img?.base64) {
	          console.log(`  └── ${accent('✓')} Generated (base64, ${img.base64.length} chars). Use --output to save.\n`);
	        } else {
	          console.log(`  └── ${accent('✓')} Generated (${result.images?.length ?? 0} images)\n`);
	        }
      }
	    } catch (err) {
	      fmt.errorBlock('Image generation failed', err instanceof Error ? err.message : String(err));
	      process.exitCode = 1;
	    } finally {
	      await shutdownWunderlandOtel();
	    }
	  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland image')} for help.`);
    process.exitCode = 1;
  }
}
