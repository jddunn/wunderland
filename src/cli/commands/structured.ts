/**
 * @fileoverview `wunderland structured` — structured data extraction using LLM.
 * Accepts unstructured text (CLI arg or stdin) and a JSON schema definition,
 * then uses generateText to extract a JSON object matching that schema.
 * @module wunderland/cli/commands/structured
 */
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

/**
 * Handles the `wunderland structured` CLI command.
 *
 * Subcommands:
 * - `extract <text>` — extract structured fields from natural language text
 *
 * @param args - Positional arguments after the `structured` command token.
 * @param flags - Parsed flag map from the CLI argument parser.
 * @param globals - Global flags (config path, quiet mode, theme, etc.).
 */
export default async function cmdStructured(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland structured');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('extract <text>')}       Extract structured data from text

  ${accent('Flags:')}
    ${dim('--schema <json>')}      JSON schema for extraction (e.g. '{"name":"string","age":"number"}')
    ${dim('--provider <name>')}    LLM provider to use
`);
    return;
  }

  if (sub === 'extract') {
    const text = args.slice(1).join(' ');
    const schemaStr = flags.schema as string | undefined;

    // Support piped stdin when no inline text is provided.
    let inputText = text;
    if (!inputText) {
      const { readFileSync } = await import('node:fs');
      try {
        inputText = readFileSync('/dev/stdin', 'utf-8').trim();
      } catch {
        // No stdin available — will surface the missing-input error below.
      }
    }

    if (!inputText) {
      fmt.errorBlock(
        'Missing input',
        'Usage: wunderland structured extract "text to extract from" --schema \'{"field":"type"}\'',
      );
      process.exitCode = 1;
      return;
    }

    if (!schemaStr) {
      fmt.errorBlock(
        'Missing schema',
        'Provide --schema with JSON field definitions (e.g. --schema \'{"name":"string","age":"number"}\')',
      );
      process.exitCode = 1;
      return;
    }

    let schema: unknown;
    try {
      schema = JSON.parse(schemaStr);
    } catch {
      fmt.errorBlock('Invalid schema', 'The --schema value must be a valid JSON object.');
      process.exitCode = 1;
      return;
    }

    try {
      const { generateText } = await import('@framers/agentos');
      const provider = flags.provider as string | undefined;

      const prompt = [
        'Extract structured data from the following text.',
        `Schema: ${JSON.stringify(schema)}`,
        'Respond with ONLY a valid JSON object matching the schema. No other text.',
        '',
        `Text: ${inputText}`,
      ].join('\n');

      const result = await generateText({
        provider: provider,
        prompt,
      });

      // Pretty-print parsed JSON; fall back to raw text if the LLM emits markdown fences.
      try {
        const cleaned = result.text
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        const parsed = JSON.parse(cleaned);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        // Not valid JSON — print the raw response so the caller can inspect it.
        console.log(result.text);
      }
    } catch (err) {
      fmt.errorBlock('Extraction failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland structured')} for help.`);
    process.exitCode = 1;
  }
}
