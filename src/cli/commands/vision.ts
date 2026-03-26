/**
 * @fileoverview `wunderland vision` — vision pipeline for OCR, image description, and CLIP embeddings.
 *
 * Subcommands:
 *   ocr <image>       — Extract text from an image using the progressive vision pipeline.
 *   describe <image>  — Generate a natural-language description of an image.
 *   embed <image>     — Generate a CLIP embedding vector for an image.
 *
 * The vision pipeline uses a 3-tier progressive enhancement architecture:
 *   - Tier 0: Local OCR (PaddleOCR / Tesseract.js)
 *   - Tier 1: Enhanced local (TrOCR, Florence-2, CLIP via @huggingface/transformers)
 *   - Tier 2: Cloud vision (Google Cloud Vision, OpenAI GPT Vision, Anthropic Vision)
 *
 * @module wunderland/cli/commands/vision
 */
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { shutdownWunderlandOtel, startWunderlandOtel } from '../../observability/otel.js';

/**
 * Handles the `wunderland vision` CLI command.
 *
 * @param args - Positional arguments after the `vision` command token.
 * @param flags - Parsed flag map from the CLI argument parser.
 * @param globals - Global flags (config path, quiet mode, theme, etc.).
 */
export default async function cmdVision(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland vision');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('ocr <image>')}           Extract text from an image
    ${dim('describe <image>')}      Describe image content in natural language
    ${dim('embed <image>')}         Generate a CLIP embedding vector

  ${accent('Flags:')}
    ${dim('--strategy <name>')}    Vision strategy (progressive, local-only, cloud-only, parallel)
    ${dim('--provider <name>')}    Cloud provider override (openai, google-cloud-vision, anthropic)
    ${dim('--output <path>')}      Save result to file (JSON)
    ${dim('--format <fmt>')}       Output format: text (default), json
`);
    return;
  }

  if (sub === 'ocr') {
    const imagePath = args[1];
    if (!imagePath) {
      fmt.errorBlock('Missing image path', 'Usage: wunderland vision ocr <image>');
      process.exitCode = 1;
      return;
    }

    const strategy = (flags.strategy as string) || 'progressive';
    const outputPath = flags.output as string | undefined;
    const formatFlag = (flags.format as string) || 'text';

    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { createVisionPipeline } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-vision' });

      const imageBuffer = await readFile(imagePath);
      console.log(`\n  ${accent('●')} Extracting text (strategy: ${strategy})...`);

      const vision = await createVisionPipeline({ strategy } as any);
      const result = await vision.process(imageBuffer);

      if (formatFlag === 'json') {
        const json = JSON.stringify({
          text: result.text,
          confidence: result.confidence,
          contentType: result.contentType,
          regions: result.regions,
          tierBreakdown: result.tierBreakdown,
        }, null, 2);

        if (outputPath) {
          await writeFile(outputPath, json, 'utf8');
          console.log(`  └── ${accent('✓')} Saved OCR result to ${outputPath}\n`);
        } else {
          console.log(json);
        }
      } else {
        console.log();
        if (result.text) {
          console.log(result.text);
        } else {
          console.log(`  ${dim('(no text detected)')}`);
        }
        console.log();
        console.log(`  ${dim('Confidence:')} ${(result.confidence * 100).toFixed(1)}%`);
        console.log(`  ${dim('Content type:')} ${result.contentType}`);
        if (result.tierBreakdown?.length) {
          const tiers = result.tierBreakdown
            .filter((t: any) => !t.skipped)
            .map((t: any) => `T${t.tier}:${t.durationMs}ms`)
            .join(', ');
          console.log(`  ${dim('Tiers:')} ${tiers}`);
        }
        console.log();

        if (outputPath) {
          await writeFile(outputPath, result.text || '', 'utf8');
          console.log(`  └── ${accent('✓')} Saved text to ${outputPath}\n`);
        }
      }

      await vision.dispose?.();
    } catch (err) {
      fmt.errorBlock('OCR failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
    return;
  }

  if (sub === 'describe') {
    const imagePath = args[1];
    if (!imagePath) {
      fmt.errorBlock('Missing image path', 'Usage: wunderland vision describe <image>');
      process.exitCode = 1;
      return;
    }

    const provider = flags.provider as string | undefined;
    const outputPath = flags.output as string | undefined;

    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { createVisionPipeline } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-vision' });

      const imageBuffer = await readFile(imagePath);
      console.log(`\n  ${accent('●')} Describing image...`);

      const visionOpts: Record<string, unknown> = { strategy: 'cloud-only' };
      if (provider) {
        visionOpts['tier2'] = { provider };
      }
      const vision = await createVisionPipeline(visionOpts as any);
      const result = await vision.process(imageBuffer);

      console.log();
      if (result.description) {
        console.log(result.description);
      } else if (result.text) {
        console.log(result.text);
      } else {
        console.log(`  ${dim('(no description available — ensure a cloud provider is configured)')}`);
      }
      console.log();

      if (outputPath) {
        await writeFile(outputPath, result.description || result.text || '', 'utf8');
        console.log(`  └── ${accent('✓')} Saved description to ${outputPath}\n`);
      }

      await vision.dispose?.();
    } catch (err) {
      fmt.errorBlock('Image description failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
    return;
  }

  if (sub === 'embed') {
    const imagePath = args[1];
    if (!imagePath) {
      fmt.errorBlock('Missing image path', 'Usage: wunderland vision embed <image>');
      process.exitCode = 1;
      return;
    }

    const outputPath = flags.output as string | undefined;

    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { createVisionPipeline } = await import('@framers/agentos');
      await startWunderlandOtel({ serviceName: 'wunderland-vision' });

      const imageBuffer = await readFile(imagePath);
      console.log(`\n  ${accent('●')} Generating CLIP embedding...`);

      const vision = await createVisionPipeline({
        strategy: 'local-only',
        tier1: { enableCLIP: true },
      } as any);
      const result = await vision.embed(imageBuffer);

      console.log();
      console.log(`  ${dim('Model:')} ${result.model || 'clip-vit-base-patch32'}`);
      console.log(`  ${dim('Dimensions:')} ${result.embedding?.length ?? 512}`);

      if (outputPath) {
        const json = JSON.stringify({
          model: result.model || 'clip-vit-base-patch32',
          dimensions: result.embedding?.length ?? 512,
          embedding: Array.from(result.embedding || []),
        }, null, 2);
        await writeFile(outputPath, json, 'utf8');
        console.log(`  └── ${accent('✓')} Saved embedding to ${outputPath}\n`);
      } else {
        // Print a preview of the first 8 dimensions
        const preview = Array.from(result.embedding || [])
          .slice(0, 8)
          .map((v) => Number(v).toFixed(4))
          .join(', ');
        console.log(`  ${dim('Preview:')} [${preview}, ...]`);
        console.log(`  ${dim('Use --output <file> to save the full vector as JSON.')}`);
      }
      console.log();

      await vision.dispose?.();
    } catch (err) {
      fmt.errorBlock('Embedding failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      await shutdownWunderlandOtel();
    }
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland vision')} for help.`);
  process.exitCode = 1;
}
