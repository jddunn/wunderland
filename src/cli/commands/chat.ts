/**
 * @fileoverview `wunderland chat` — interactive terminal assistant with tool calling.
 * Ported from bin/wunderland.js cmdChat() with colored output.
 * @module wunderland/cli/commands/chat
 */

import { createInterface } from 'node:readline/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor, tool as tColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../config/workspace.js';
import { SkillRegistry, resolveDefaultSkillsDirs } from '../../skills/index.js';
import { runToolCallingTurn, safeJsonStringify, truncateString, type ToolInstance } from '../openai/tool-calling.js';
import { createSchemaOnDemandTools } from '../openai/schema-on-demand.js';

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdChat(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

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
  const lazyTools = flags['lazy-tools'] === true;
  const workspaceBaseDir = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(`chat-${path.basename(process.cwd())}`);

  const toolMap = new Map<string, ToolInstance>();
  const preloadedPackages: string[] = [];

  if (!lazyTools) {
    // Load tools from curated extensions (eager)
    const [cliExecutor, webSearch, webBrowser, giphy, imageSearch, voiceSynthesis, newsSearch] = await Promise.all([
      import('@framers/agentos-ext-cli-executor'),
      import('@framers/agentos-ext-web-search'),
      import('@framers/agentos-ext-web-browser'),
      import('@framers/agentos-ext-giphy'),
      import('@framers/agentos-ext-image-search'),
      import('@framers/agentos-ext-voice-synthesis'),
      import('@framers/agentos-ext-news-search'),
    ]);

    const skillsExtModule: string = '@framers/agentos-ext-skills';
    const skillsExt = await import(skillsExtModule).catch(() => null);

    const packs = [
      cliExecutor.createExtensionPack({
        options: {
          filesystem: { allowRead: true, allowWrite: true },
          agentWorkspace: {
            agentId: workspaceAgentId,
            baseDir: workspaceBaseDir,
            createIfMissing: true,
            subdirs: ['assets', 'exports', 'tmp'],
          },
          dangerouslySkipSecurityChecks: dangerouslySkipCommandSafety,
        },
        logger: console,
      }),
      skillsExt ? skillsExt.createExtensionPack({ options: {}, logger: console }) : null,
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
    ].filter(Boolean);

    await Promise.all(
      packs
        .map((p: any) =>
          typeof p?.onActivate === 'function'
            ? p.onActivate({ logger: console, getSecret: () => undefined })
            : null
        )
        .filter(Boolean),
    );

    const tools: ToolInstance[] = packs
      .flatMap((p: any) => (p?.descriptors || []).filter((d: { kind: string }) => d?.kind === 'tool').map((d: { payload: unknown }) => d.payload))
      .filter(Boolean) as ToolInstance[];

    for (const tool of tools) {
      if (!tool?.name) continue;
      toolMap.set(tool.name, tool);
    }

    preloadedPackages.push(
      '@framers/agentos-ext-cli-executor',
      '@framers/agentos-ext-web-search',
      '@framers/agentos-ext-web-browser',
      '@framers/agentos-ext-giphy',
      '@framers/agentos-ext-image-search',
      '@framers/agentos-ext-voice-synthesis',
      '@framers/agentos-ext-news-search',
    );
    if (skillsExt) preloadedPackages.push('@framers/agentos-ext-skills');
  }

  // Schema-on-demand meta tools (always available)
  for (const tool of createSchemaOnDemandTools({
    toolMap,
    runtimeDefaults: {
      workingDirectory: process.cwd(),
      headlessBrowser: true,
      dangerouslySkipCommandSafety,
      agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    },
    initialEnabledPackages: preloadedPackages,
    logger: console,
  })) {
    toolMap.set(tool.name, tool);
  }

  // Skills — load from filesystem dirs + config-declared skills
  let skillsPrompt = '';
  if (enableSkills) {
    const parts: string[] = [];

    // 1. Directory-based skills (local ./skills/ dirs, --skills-dir flag)
    const skillRegistry = new SkillRegistry();
    const dirs = resolveDefaultSkillsDirs({
      cwd: process.cwd(),
      skillsDirFlag: typeof flags['skills-dir'] === 'string' ? flags['skills-dir'] : undefined,
    });
    if (dirs.length > 0) {
      await skillRegistry.loadFromDirs(dirs);
      const snapshot = skillRegistry.buildSnapshot({ platform: process.platform, strict: true });
      if (snapshot.prompt) parts.push(snapshot.prompt);
    }

    // 2. Config-declared skills (from agent.config.json "skills" array)
    const configPath = path.resolve(process.cwd(), 'agent.config.json');
    try {
      const { readFile } = await import('node:fs/promises');
      const cfgRaw = JSON.parse(await readFile(configPath, 'utf8'));
      if (Array.isArray(cfgRaw.skills) && cfgRaw.skills.length > 0) {
        const { resolveSkillsByNames } = await import('../../core/PresetSkillResolver.js');
        const presetSnapshot = await resolveSkillsByNames(cfgRaw.skills as string[]);
        if (presetSnapshot.prompt) parts.push(presetSnapshot.prompt);
      }
    } catch { /* non-fatal — no config or registry not installed */ }

    skillsPrompt = parts.filter(Boolean).join('\n\n');
  }

  const systemPrompt = [
    'You are Wunderland CLI, an interactive terminal assistant.',
    lazyTools
      ? 'Use extensions_list + extensions_enable to load tools on demand (schema-on-demand).'
      : 'Tools are preloaded, and you can also use extensions_enable to load additional packs on demand.',
    'When you need up-to-date information, use web_search and/or browser_* tools (enable them first if missing).',
    autoApproveToolCalls
      ? 'All tool calls are auto-approved (fully autonomous mode).'
      : 'Tool calls that have side effects may require user approval.',
    skillsPrompt || '',
  ].filter(Boolean).join('\n\n');

  const sessionId = `wunderland-cli-${Date.now()}`;
  const toolContext = { gmiId: sessionId, personaId: sessionId, userContext: { userId: process.env['USER'] || 'local-user' } };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

  fmt.section('Interactive Chat');
  fmt.kvPair('Model', accent(model));
  fmt.kvPair('Tools', `${toolMap.size} loaded`);
  fmt.kvPair('Skills', enableSkills ? sColor('on') : muted('off'));
  fmt.kvPair('Lazy Tools', lazyTools ? sColor('on') : muted('off'));
  fmt.kvPair('Authorization', autoApproveToolCalls ? wColor('fully autonomous') : sColor('tiered (Tier 1/2/3)'));
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
      toolContext,
      maxRounds: 8,
      dangerouslySkipPermissions: autoApproveToolCalls,
      askPermission,
      onToolCall: (tool: ToolInstance, args: Record<string, unknown>) => {
        console.log(
          `  ${tColor('\u25B6')} ${tColor(tool.name)} ${dim(truncateString(JSON.stringify(args), 120))}`
        );
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
