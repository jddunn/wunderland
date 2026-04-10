// @ts-nocheck
/**
 * @fileoverview `wunderland deploy` — generate deployment artifacts from agent.config.json.
 *
 * Reads the agent config in the current directory (or --config path) and
 * generates a deployment bundle: Dockerfile, docker-compose.yml (or
 * railway.toml / fly.toml), .env template, agent.config.json copy, and README.
 *
 * @module wunderland/cli/commands/deploy
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import type { DeployTarget } from '../deploy/templates.js';
import { accent, success as sColor, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { generateDeployArtifacts } from '../deploy/artifact-generator.js';

const VALID_TARGETS: DeployTarget[] = ['docker', 'railway', 'fly'];
const DEFAULT_PORT = 3777;
const DEFAULT_TARGET: DeployTarget = 'docker';

export default async function cmdDeploy(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // ── Resolve agent.config.json path ────────────────────────────────────
  const configPath =
    typeof flags['config'] === 'string'
      ? path.resolve(process.cwd(), flags['config'])
      : path.resolve(process.cwd(), 'agent.config.json');

  if (!existsSync(configPath)) {
    fmt.errorBlock(
      'Config not found',
      `Could not find ${configPath}\nRun from a directory with agent.config.json, or use --config <path>.`,
    );
    process.exitCode = 1;
    return;
  }

  let agentConfig: Record<string, unknown>;
  try {
    const raw = await readFile(configPath, 'utf-8');
    agentConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    fmt.errorBlock(
      'Invalid config',
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Resolve output directory ──────────────────────────────────────────
  const outputDir =
    typeof flags['output'] === 'string'
      ? path.resolve(process.cwd(), flags['output'])
      : path.resolve(process.cwd(), 'deploy');

  // ── Resolve target ────────────────────────────────────────────────────
  let target: DeployTarget;
  if (typeof flags['target'] === 'string') {
    const t = flags['target'].toLowerCase() as DeployTarget;
    if (!VALID_TARGETS.includes(t)) {
      fmt.errorBlock(
        'Invalid target',
        `"${flags['target']}" is not a valid target.\nValid targets: ${VALID_TARGETS.join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }
    target = t;
  } else {
    target = DEFAULT_TARGET;
  }

  // ── Resolve port ──────────────────────────────────────────────────────
  let port: number;
  if (typeof flags['port'] === 'string') {
    port = parseInt(flags['port'], 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      fmt.errorBlock('Invalid port', `"${flags['port']}" is not a valid port number (1-65535).`);
      process.exitCode = 1;
      return;
    }
  } else {
    port = DEFAULT_PORT;
  }

  // ── Interactive prompts (if TTY and not --yes) ────────────────────────
  const isInteractive =
    !globals.yes && !globals.quiet && process.stdin.isTTY && process.stdout.isTTY;

  if (isInteractive && typeof flags['target'] !== 'string') {
    const p = await import('@clack/prompts');
    const selected = await p.select({
      message: 'Deployment target:',
      options: [
        { value: 'docker' as const, label: 'Docker Compose', hint: 'Dockerfile + docker-compose.yml' },
        { value: 'railway' as const, label: 'Railway', hint: 'Dockerfile + railway.toml' },
        { value: 'fly' as const, label: 'Fly.io', hint: 'Dockerfile + fly.toml' },
      ],
    });
    if (p.isCancel(selected)) {
      fmt.note('Cancelled.');
      return;
    }
    target = selected as DeployTarget;
  }

  if (isInteractive && typeof flags['port'] !== 'string') {
    const p = await import('@clack/prompts');
    const portInput = await p.text({
      message: 'Agent port:',
      initialValue: String(DEFAULT_PORT),
      validate(value) {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1 || n > 65535) return 'Enter a valid port (1-65535)';
        return undefined;
      },
    });
    if (p.isCancel(portInput)) {
      fmt.note('Cancelled.');
      return;
    }
    port = parseInt(portInput as string, 10);
  }

  // ── Dry-run check ─────────────────────────────────────────────────────
  const dryRun = globals.dryRun;

  // ── Generate artifacts ────────────────────────────────────────────────
  const result = generateDeployArtifacts({
    agentConfig,
    target,
    port,
    outputDir,
    region: typeof flags['region'] === 'string' ? flags['region'] : undefined,
  });

  // ── Check for existing output dir ─────────────────────────────────────
  if (!dryRun && existsSync(outputDir)) {
    const isForce = flags['force'] === true;
    if (!isForce && isInteractive) {
      const p = await import('@clack/prompts');
      const overwrite = await p.confirm({
        message: `Output directory ${outputDir} already exists. Overwrite?`,
        initialValue: false,
      });
      if (p.isCancel(overwrite) || !overwrite) {
        fmt.note('Cancelled. Use --force to overwrite.');
        return;
      }
    } else if (!isForce) {
      fmt.errorBlock('Output exists', `${outputDir} already exists. Use --force to overwrite.`);
      process.exitCode = 1;
      return;
    }
  }

  // ── Write files ───────────────────────────────────────────────────────
  if (!dryRun) {
    await mkdir(outputDir, { recursive: true });
    await mkdir(path.join(outputDir, 'workspaces'), { recursive: true });
    await mkdir(path.join(outputDir, 'skills'), { recursive: true });

    for (const [filename, content] of result.files) {
      await writeFile(path.join(outputDir, filename), content, 'utf-8');
    }

    // .gitkeep placeholders
    await writeFile(path.join(outputDir, 'workspaces', '.gitkeep'), '', 'utf-8');
    await writeFile(path.join(outputDir, 'skills', '.gitkeep'), '', 'utf-8');
  }

  // ── Print summary ─────────────────────────────────────────────────────
  const { summary } = result;
  const relOutput = path.relative(process.cwd(), outputDir) || '.';
  const g = glyphs();
  const generatedFiles = Array.from(result.files.keys());

  const summaryLines: (string | null)[] = [
    `Target:  ${accent(summary.target)}`,
    `Agent:   ${accent(summary.displayName)}`,
    `Port:    ${String(summary.port)}`,
    `Output:  ${accent(relOutput)}`,
    `Files:   ${dim(generatedFiles.join(', '))}`,
  ];

  const allPkgs = [...summary.extensionPackages, ...summary.channelPackages];
  if (allPkgs.length > 0) summaryLines.push(`Packages: ${allPkgs.join(', ')}`);
  if (summary.channels.length > 0) summaryLines.push(`Channels: ${summary.channels.join(', ')}`);
  if (summary.skills.length > 0) summaryLines.push(`Skills:  ${summary.skills.join(', ')}`);
  if (summary.requiredEnvVars.length > 0) summaryLines.push(`Env vars: ${summary.requiredEnvVars.length} required (see .env.example)`);

  if (!dryRun) {
    const deployCmd = target === 'docker'
      ? `cd ${relOutput} && cp .env.example .env && docker compose up -d --build`
      : target === 'railway'
        ? `cd ${relOutput} && cp .env.example .env && railway up`
        : `cd ${relOutput} && cp .env.example .env && fly launch --copy-config`;
    summaryLines.push('', `Next: ${sColor(deployCmd)}`);
  }

  fmt.blank();
  fmt.panel({
    title: dryRun ? 'Deploy (dry run)' : `${g.ok} Deploy Artifacts Generated`,
    style: dryRun ? 'info' : 'success',
    content: summaryLines.filter(Boolean).join('\n'),
  });

  if (summary.missingChannelNotes.length > 0) {
    fmt.blank();
    fmt.warning(`Channel packs not on public npm: ${summary.missingChannelNotes.join(', ')}`);
    fmt.note('These channels require deploying from source or publishing the packages.');
  }

  fmt.blank();
}
