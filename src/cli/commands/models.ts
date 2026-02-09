/**
 * @fileoverview `wunderland models` — list providers/models, set defaults, test connectivity.
 * @module wunderland/cli/commands/models
 */

import chalk from 'chalk';
import type { GlobalFlags } from '../types.js';
import { LLM_PROVIDERS } from '../constants.js';
import { accent, dim, muted, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadConfig, updateConfig } from '../config/config-manager.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

// ── Sub-commands ────────────────────────────────────────────────────────────

async function listModels(flags: Record<string, string | boolean>): Promise<void> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (format === 'json') {
    console.log(JSON.stringify(LLM_PROVIDERS, null, 2));
    return;
  }

  fmt.section('LLM Providers & Models');
  fmt.blank();

  for (const provider of LLM_PROVIDERS) {
    const envSet = provider.envVar ? !!process.env[provider.envVar] : true;
    const statusIcon = envSet ? sColor('\u2713') : muted('\u25CB');
    const envHint = provider.envVar ? (envSet ? sColor('configured') : muted('not set')) : muted('no key needed');

    console.log(`    ${statusIcon} ${accent(provider.id.padEnd(18))} ${chalk.white(provider.label)}`);
    console.log(`      ${muted('Key:')} ${envHint}${provider.envVar ? dim(` (${provider.envVar})`) : ''}`);
    console.log(`      ${muted('Models:')} ${provider.models.map((m) => dim(m)).join(', ')}`);
    console.log();
  }

  fmt.kvPair('Total Providers', `${LLM_PROVIDERS.length}`);
  fmt.blank();
}

async function setDefault(args: string[], globals: GlobalFlags): Promise<void> {
  const provider = args[0];
  const model = args[1];

  if (!provider || !model) {
    fmt.errorBlock('Missing arguments', 'Usage: wunderland models set-default <provider> <model>');
    process.exitCode = 1;
    return;
  }

  // Validate provider
  const providerEntry = LLM_PROVIDERS.find((p) => p.id === provider);
  if (!providerEntry) {
    fmt.errorBlock(
      'Unknown provider',
      `"${provider}" is not a recognized LLM provider.\nAvailable: ${LLM_PROVIDERS.map((p) => p.id).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  // Warn if model is not in the known list (but still allow it)
  const knownModels = providerEntry.models as readonly string[];
  if (!knownModels.includes(model)) {
    fmt.warning(`"${model}" is not in the known model list for ${providerEntry.label}. Setting anyway.`);
  }

  await updateConfig(
    { llmProvider: provider, llmModel: model },
    globals.config,
  );

  fmt.ok(`Default LLM set to ${accent(providerEntry.label)} / ${accent(model)}`);
  fmt.blank();
}

async function testProvider(args: string[], globals: GlobalFlags): Promise<void> {
  // Load env files so API keys are available
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const config = await loadConfig(globals.config);
  const providerArg = args[0] || config.llmProvider;

  if (!providerArg) {
    fmt.errorBlock(
      'No provider specified',
      'Usage: wunderland models test [provider]\nOr set a default: wunderland models set-default <provider> <model>',
    );
    process.exitCode = 1;
    return;
  }

  const providerEntry = LLM_PROVIDERS.find((p) => p.id === providerArg);
  if (!providerEntry) {
    fmt.errorBlock('Unknown provider', `"${providerArg}" is not a recognized LLM provider.`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Testing ${providerEntry.label}`);
  fmt.blank();

  // Check API key
  if (providerEntry.envVar) {
    const keyValue = process.env[providerEntry.envVar];
    if (!keyValue) {
      fmt.fail(`${providerEntry.envVar} is not set. Cannot test connectivity.`);
      fmt.note(`Set it in .env or export it: export ${providerEntry.envVar}=...`);
      fmt.blank();
      process.exitCode = 1;
      return;
    }
    fmt.ok(`${providerEntry.envVar} is set`);
  }

  // Attempt connectivity test based on provider
  const start = Date.now();
  try {
    let reachable = false;
    let latency = 0;

    if (providerEntry.id === 'openai') {
      const res = await fetchWithTimeout('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env['OPENAI_API_KEY']}` },
      });
      reachable = res.ok;
      latency = Date.now() - start;
    } else if (providerEntry.id === 'anthropic') {
      // Anthropic doesn't have a public list endpoint; just check reachability
      const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env['ANTHROPIC_API_KEY'] || '',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      // 200 or 4xx means the API is reachable (auth might fail but endpoint is up)
      reachable = res.status < 500;
      latency = Date.now() - start;
    } else if (providerEntry.id === 'ollama') {
      const res = await fetchWithTimeout('http://localhost:11434/api/tags', {});
      reachable = res.ok;
      latency = Date.now() - start;
    } else if (providerEntry.id === 'gemini') {
      const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env['GEMINI_API_KEY'] || ''}`, {});
      reachable = res.status < 500;
      latency = Date.now() - start;
    } else {
      // Generic check: just see if the docs URL responds
      const res = await fetchWithTimeout(providerEntry.docsUrl, {});
      reachable = res.ok || res.status < 500;
      latency = Date.now() - start;
    }

    if (reachable) {
      fmt.ok(`API reachable (${latency}ms)`);
    } else {
      fmt.fail(`API returned error (${latency}ms)`);
      process.exitCode = 1;
    }
  } catch (err) {
    const latency = Date.now() - start;
    fmt.fail(`Connection failed (${latency}ms): ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }

  fmt.blank();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdModels(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'list' || !sub) {
    await listModels(flags);
    return;
  }

  if (sub === 'set-default') {
    await setDefault(args.slice(1), globals);
    return;
  }

  if (sub === 'test') {
    await testProvider(args.slice(1), globals);
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${sub}" is not a valid models subcommand.\nUsage: wunderland models <list|set-default|test> [options]`);
  process.exitCode = 1;
}
