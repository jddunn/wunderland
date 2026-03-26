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
 * - `edit <input-image> --prompt "..." [--mask <mask>] [--strength 0.75] [--output <file>]` — img2img / inpaint
 * - `upscale <input-image> [--scale 4] [--output <file>]` — super resolution
 * - `variate <input-image> [--n 3] [--output <file>]` — create variations
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
    ${dim('generate <prompt>')}             Generate an image from a text prompt
    ${dim('edit <image> --prompt "..."')}   Edit an image (img2img, inpainting)
    ${dim('upscale <image>')}               Upscale an image (2x/4x super resolution)
    ${dim('variate <image>')}               Create variations of an image

  ${accent('Flags:')}
    ${dim('--provider <name>')}    Image provider (openai, stability, replicate, ollama)
    ${dim('--model <model>')}      Explicit model override
    ${dim('--size <WxH>')}         Image dimensions (e.g. 1024x1024)
    ${dim('--output <path>')}      Save image to file
    ${dim('--prompt <text>')}      Edit prompt (edit subcommand)
    ${dim('--mask <path>')}        Mask image for inpainting (edit subcommand)
    ${dim('--strength <0-1>')}     Transformation strength (edit subcommand, default: 0.75)
    ${dim('--scale <2|4>')}        Upscale factor (upscale subcommand, default: 2)
    ${dim('--n <count>')}          Number of variations (variate subcommand, default: 1)
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
  } else if (sub === 'edit') {
    const inputImage = args[1];
    if (!inputImage) {
      fmt.errorBlock('Missing input image', 'Usage: wunderland image edit <image> --prompt "your edit prompt"');
      process.exitCode = 1;
      return;
    }

    const prompt = flags.prompt as string | undefined;
    if (!prompt) {
      fmt.errorBlock('Missing prompt', 'Usage: wunderland image edit <image> --prompt "your edit prompt"');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const maskPath = flags.mask as string | undefined;
    const strength = flags.strength ? parseFloat(flags.strength as string) : 0.75;
    const output = flags.output as string | undefined;

    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { editImage } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-image' });

      const imageBuffer = await readFile(inputImage);
      const request: Record<string, unknown> = { image: imageBuffer, prompt, strength };
      if (provider) request['provider'] = provider;
      if (maskPath) {
        const maskBuffer = await readFile(maskPath);
        request['mask'] = maskBuffer;
      }

      console.log(`\n  ${accent('●')} Editing image...`);
      const result = await editImage(request as any);

      if (output && result.images?.[0]) {
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
          console.log(`  └── ${accent('✓')} Edited (base64, ${img.base64.length} chars). Use --output to save.\n`);
        } else {
          console.log(`  └── ${accent('✓')} Edited (${result.images?.length ?? 0} images)\n`);
        }
      }
    } catch (err) {
      fmt.errorBlock('Image editing failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
  } else if (sub === 'upscale') {
    const inputImage = args[1];
    if (!inputImage) {
      fmt.errorBlock('Missing input image', 'Usage: wunderland image upscale <image> [--scale 4] [--output <file>]');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const scale = flags.scale ? parseInt(flags.scale as string, 10) : 2;
    const output = flags.output as string | undefined;

    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { upscaleImage } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-image' });

      const imageBuffer = await readFile(inputImage);
      const request: Record<string, unknown> = { image: imageBuffer, scale };
      if (provider) request['provider'] = provider;

      console.log(`\n  ${accent('●')} Upscaling image (${scale}x)...`);
      const result = await upscaleImage(request as any);

      if (output && result.images?.[0]) {
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
          console.log(`  └── ${accent('✓')} Upscaled (base64, ${img.base64.length} chars). Use --output to save.\n`);
        } else {
          console.log(`  └── ${accent('✓')} Upscaled\n`);
        }
      }
    } catch (err) {
      fmt.errorBlock('Image upscaling failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
  } else if (sub === 'variate') {
    const inputImage = args[1];
    if (!inputImage) {
      fmt.errorBlock('Missing input image', 'Usage: wunderland image variate <image> [--n 3] [--output <file>]');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const n = flags.n ? parseInt(flags.n as string, 10) : 1;
    const output = flags.output as string | undefined;

    try {
      const { readFile } = await import('node:fs/promises');
      const { variateImage } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-image' });

      const imageBuffer = await readFile(inputImage);
      const request: Record<string, unknown> = { image: imageBuffer, n };
      if (provider) request['provider'] = provider;

      console.log(`\n  ${accent('●')} Creating ${n} variation(s)...`);
      const result = await variateImage(request as any);

      if (output && result.images?.length) {
        const { writeFile: wf } = await import('node:fs/promises');
        const { dirname, join, parse } = await import('node:path');
        const { mkdirSync } = await import('node:fs');

        for (let i = 0; i < result.images.length; i++) {
          const img = result.images[i];
          if (img.base64) {
            const parsed = parse(output);
            const outPath = result.images.length > 1
              ? join(parsed.dir, `${parsed.name}-${i + 1}${parsed.ext || '.png'}`)
              : output;
            mkdirSync(dirname(outPath), { recursive: true });
            await wf(outPath, Buffer.from(img.base64, 'base64'));
            console.log(`  └── ${accent('✓')} Saved variation ${i + 1} to ${outPath}`);
          } else if (img.url) {
            console.log(`  └── ${accent('✓')} Variation ${i + 1} URL: ${img.url}`);
          }
        }
        console.log();
      } else {
        console.log(`  └── ${accent('✓')} Created ${result.images?.length ?? 0} variation(s)\n`);
      }
    } catch (err) {
      fmt.errorBlock('Image variation failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
	  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland image')} for help.`);
    process.exitCode = 1;
  }
}
