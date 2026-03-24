/**
 * @fileoverview `wunderland image` — image generation via AgentOS providers.
 * @module wunderland/cli/commands/image
 */
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

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

      console.log(`\n  ${accent('●')} Generating image...`);
      const result = await generateImage({
        provider: provider,
        model: model,
        prompt,
        size,
      });

      if (output && result.images?.[0]) {
        // If output path specified, save the image (base64) or print the URL.
        const { writeFile } = await import('node:fs/promises');
        const img = result.images[0];
        if (img.b64_json) {
          await writeFile(output, Buffer.from(img.b64_json, 'base64'));
          console.log(`  └── ${accent('✓')} Saved to ${output}\n`);
        } else if (img.url) {
          console.log(`  └── ${accent('✓')} URL: ${img.url}\n`);
        }
      } else {
        const img = result.images?.[0];
        if (img?.url) {
          console.log(`  └── ${accent('✓')} URL: ${img.url}\n`);
        } else if (img?.b64_json) {
          console.log(`  └── ${accent('✓')} Generated (base64, ${img.b64_json.length} chars). Use --output to save.\n`);
        } else {
          console.log(`  └── ${accent('✓')} Generated (${result.images?.length ?? 0} images)\n`);
        }
      }
    } catch (err) {
      fmt.errorBlock('Image generation failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland image')} for help.`);
    process.exitCode = 1;
  }
}
