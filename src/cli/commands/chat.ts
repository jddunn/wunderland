/**
 * @fileoverview `wunderland chat` — interactive terminal assistant with tool calling.
 * Ported from bin/wunderland.js cmdChat() with colored output.
 * @module wunderland/cli/commands/chat
 */

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import * as path from 'node:path';
import os from 'node:os';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor, tool as tColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcess } from '../config/env-manager.js';
import { SkillRegistry } from '../../skills/index.js';
import { runToolCallingTurn, safeJsonStringify, truncateString, type ToolInstance } from '../openai/tool-calling.js';

// ── Skills resolver ─────────────────────────────────────────────────────────

function resolveSkillsDirs(flags: Record<string, string | boolean>): string[] {
  const dirs: string[] = [];
  const skillsDirFlag = flags['skills-dir'];
  if (typeof skillsDirFlag === 'string' && skillsDirFlag.trim()) {
    for (const part of skillsDirFlag.split(',')) {
      const p = part.trim();
      if (p) dirs.push(path.resolve(process.cwd(), p));
    }
  }
  const codexHome = typeof process.env['CODEX_HOME'] === 'string' ? process.env['CODEX_HOME'].trim() : '';
  if (codexHome) dirs.push(path.join(codexHome, 'skills'));
  dirs.push(path.join(os.homedir(), '.codex', 'skills'));
  dirs.push(path.join(process.cwd(), 'skills'));

  const seen = new Set<string>();
  return dirs.filter((d) => {
    if (!d) return false;
    const key = path.resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return existsSync(key);
  });
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdChat(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcess(
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
  );

  const apiKey = process.env['OPENAI_API_KEY'] || '';
  if (!apiKey) {
    fmt.errorBlock('Missing API key', 'OPENAI_API_KEY is required for `wunderland chat`.');
    process.exitCode = 1;
    return;
  }

  const model = typeof flags['model'] === 'string' ? flags['model'] : (process.env['OPENAI_MODEL'] || 'gpt-4o-mini');
  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const dangerouslySkipCommandSafety =
    flags['dangerously-skip-command-safety'] === true || dangerouslySkipPermissions;
  const autoApproveToolCalls = globals.yes || dangerouslySkipPermissions;
  const enableSkills = flags['no-skills'] !== true;

  // Load tools from curated extensions
  const [cliExecutor, webSearch, webBrowser, giphy, imageSearch, voiceSynthesis, newsSearch] = await Promise.all([
    import('@framers/agentos-ext-cli-executor'),
    import('@framers/agentos-ext-web-search'),
    import('@framers/agentos-ext-web-browser'),
    import('@framers/agentos-ext-giphy'),
    import('@framers/agentos-ext-image-search'),
    import('@framers/agentos-ext-voice-synthesis'),
    import('@framers/agentos-ext-news-search'),
  ]);

  const packs = [
    cliExecutor.createExtensionPack({
      options: {
        workingDirectory: process.cwd(),
        dangerouslySkipSecurityChecks: dangerouslySkipCommandSafety,
      },
      logger: console,
    }),
    webSearch.createExtensionPack({
      options: {
        serperApiKey: process.env['SERPER_API_KEY'],
        serpApiKey: process.env['SERPAPI_API_KEY'],
        braveApiKey: process.env['BRAVE_API_KEY'],
      },
      logger: console,
    }),
    webBrowser.createExtensionPack({ options: { headless: true }, logger: console }),
    giphy.createExtensionPack({ options: { giphyApiKey: process.env['GIPHY_API_KEY'] }, logger: console }),
    imageSearch.createExtensionPack({
      options: {
        pexelsApiKey: process.env['PEXELS_API_KEY'],
        unsplashApiKey: process.env['UNSPLASH_ACCESS_KEY'],
        pixabayApiKey: process.env['PIXABAY_API_KEY'],
      },
      logger: console,
    }),
    voiceSynthesis.createExtensionPack({ options: { elevenLabsApiKey: process.env['ELEVENLABS_API_KEY'] }, logger: console }),
    newsSearch.createExtensionPack({ options: { newsApiKey: process.env['NEWSAPI_API_KEY'] }, logger: console }),
  ];

  const tools: ToolInstance[] = packs
    .flatMap((p) => (p?.descriptors || []).filter((d: { kind: string }) => d?.kind === 'tool').map((d: { payload: unknown }) => d.payload))
    .filter(Boolean) as ToolInstance[];

  const toolMap = new Map<string, ToolInstance>();
  for (const tool of tools) {
    if (!tool?.name) continue;
    toolMap.set(tool.name, tool);
  }

  const toolDefs = [...toolMap.values()].map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));

  // Skills
  let skillsPrompt = '';
  if (enableSkills) {
    const skillRegistry = new SkillRegistry();
    const dirs = resolveSkillsDirs(flags);
    if (dirs.length > 0) {
      await skillRegistry.loadFromDirs(dirs);
      const snapshot = skillRegistry.buildSnapshot({ platform: process.platform });
      skillsPrompt = snapshot.prompt || '';
    }
  }

  const systemPrompt = [
    'You are Wunderland CLI, an interactive terminal assistant.',
    'You can use tools to read/write files, run shell commands, and browse the web.',
    'When you need up-to-date information, use web_search and/or browser_* tools.',
    'Tool calls that have side effects may require user approval.',
    skillsPrompt || '',
  ].filter(Boolean).join('\n\n');

  const sessionId = `wunderland-cli-${Date.now()}`;
  const toolContext = { gmiId: sessionId, personaId: sessionId, userContext: { userId: process.env['USER'] || 'local-user' } };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

  fmt.section('Interactive Chat');
  fmt.kvPair('Model', accent(model));
  fmt.kvPair('Tools', `${toolDefs.length} loaded`);
  fmt.kvPair('Skills', enableSkills ? sColor('on') : muted('off'));
  fmt.blank();
  fmt.note(`Type ${accent('/help')} for commands, ${accent('/exit')} to quit`);
  fmt.blank();

  const askPermission = async (tool: ToolInstance, args: Record<string, unknown>): Promise<boolean> => {
    const preview = safeJsonStringify(args, 800);
    const q = `  ${wColor('\u26A0')} Allow ${tColor(tool.name)} (side effects)?\n${dim(preview)}\n  ${muted('[y/N]')} `;
    const answer = (await rl.question(q)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  };

  for (;;) {
    const line = await rl.question(`  ${accent('\u276F')} `);
    const input = (line || '').trim();
    if (!input) continue;

    if (input === '/exit' || input === 'exit' || input === 'quit') break;

    if (input === '/help') {
      fmt.blank();
      fmt.note(`${accent('/help')}    Show this help`);
      fmt.note(`${accent('/tools')}   List available tools`);
      fmt.note(`${accent('/exit')}    Quit`);
      fmt.blank();
      continue;
    }

    if (input === '/tools') {
      const names = [...toolMap.keys()].sort();
      fmt.blank();
      for (const n of names) fmt.toolName(n);
      fmt.blank();
      continue;
    }

    messages.push({ role: 'user', content: input });

	    const reply = await runToolCallingTurn({
	      apiKey,
	      model,
	      messages,
	      toolMap,
	      toolDefs,
	      toolContext,
	      maxRounds: 8,
	      dangerouslySkipPermissions: autoApproveToolCalls,
	      askPermission,
	      onToolCall: (tool: ToolInstance, args: Record<string, unknown>) => {
	        console.log(`  ${tColor('\u25B6')} ${tColor(tool.name)} ${dim(truncateString(JSON.stringify(args), 120))}`);
	      },
	    });

    if (reply) {
      console.log();
      console.log(`  ${reply}`);
      console.log();
    }
  }

  rl.close();
  fmt.blank();
  fmt.ok('Session ended.');
  fmt.blank();
}
