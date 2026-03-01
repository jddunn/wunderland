/**
 * @fileoverview `wunderland chat` — interactive terminal assistant with tool calling.
 * Ported from bin/wunderland.js cmdChat() with colored output.
 * @module wunderland/cli/commands/chat
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import chalk from 'chalk';
import { HEX, accent, success as sColor, warn as wColor, tool as tColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { visibleLength } from '../ui/ansi-utils.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../config/workspace.js';
import { SkillRegistry, resolveDefaultSkillsDirs } from '../../skills/index.js';
import { runToolCallingTurn, safeJsonStringify, truncateString, type ToolInstance, type LLMProviderConfig } from '../openai/tool-calling.js';
import { createSchemaOnDemandTools } from '../openai/schema-on-demand.js';
import { startWunderlandOtel, shutdownWunderlandOtel } from '../observability/otel.js';
import { WunderlandAdaptiveExecutionRuntime } from '../../runtime/adaptive-execution.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
} from '../security/runtime-policy.js';
import { verifySealedConfig } from '../seal-utils.js';
import { createEnvSecretResolver } from '../security/env-secrets.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../../core/index.js';
import { WunderlandDiscoveryManager, type WunderlandDiscoveryConfig } from '../../discovery/index.js';

// ── Chat Frame Palette (mirrors dashboard.ts) ──────────────────────────────

const C = HEX;

const frameBorder  = chalk.hex(C.cyan);
const accentBorder = chalk.hex(C.lavender);

function chatFrameGlyphs(): { tl: string; tr: string; bl: string; br: string; h: string; v: string } {
  const ui = getUiRuntime();
  if (ui.ascii) return { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  return { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };
}

/** Get terminal width, floored at 60. */
function getChatWidth(): number {
  return Math.max((process.stdout.columns || 80) - 4, 60);
}

/** Frame a content line inside ║ ... ║ borders. */
function frameLine(content: string, innerWidth: number): string {
  const frame = chatFrameGlyphs();
  const vLen = visibleLength(content);
  const pad = Math.max(0, innerWidth - vLen);
  return `  ${frameBorder(frame.v)}${content}${' '.repeat(pad)}${frameBorder(frame.v)}`;
}

/** Print the framed chat startup header. */
function printChatHeader(info: {
  provider: string;
  model: string;
  tools: number;
  skills: boolean;
  fallback: boolean;
  lazyTools: boolean;
  autoApprove: boolean;
  turnApproval: string;
}): void {
  const contentWidth = getChatWidth();
  const innerWidth = contentWidth - 2;

  const frame = chatFrameGlyphs();
  const topBorder = `  ${frameBorder(frame.tl)}${frameBorder(frame.h.repeat(innerWidth))}${frameBorder(frame.tr)}`;
  const botBorder = `  ${frameBorder(frame.bl)}${frameBorder(frame.h.repeat(innerWidth))}${frameBorder(frame.br)}`;
  const empty = frameLine(' '.repeat(innerWidth), innerWidth);

  // Title
  const titleText = chalk.hex(C.magenta).bold('INTERACTIVE CHAT');
  const titleVis = 16; // "INTERACTIVE CHAT"
  const titlePadL = Math.max(0, Math.floor((innerWidth - titleVis) / 2));

  // Divider
  const divDeco = ` ${chalk.hex(C.magenta)('<>')} `;
  const divDecoVis = 4;
  const divHalfL = Math.max(0, Math.floor((innerWidth - divDecoVis) / 2));
  const divHalfR = Math.max(0, innerWidth - divDecoVis - divHalfL);
  const g = glyphs();
  const divContent = accentBorder(g.hr.repeat(divHalfL)) + divDeco + accentBorder(g.hr.repeat(divHalfR));

  // Key-value pairs
  const kvLine = (label: string, value: string): string => {
    const kvContent = `   ${chalk.hex(C.brightCyan)(g.bullet)} ${chalk.hex(C.muted)(label.padEnd(18))} ${value}`;
    return frameLine(kvContent, innerWidth);
  };

  const lines: string[] = [];
  lines.push(topBorder);
  lines.push(empty);
  lines.push(frameLine(`${' '.repeat(titlePadL)}${titleText}`, innerWidth));
  lines.push(empty);
  lines.push(frameLine(divContent, innerWidth));
  lines.push(empty);
  lines.push(kvLine('Provider', chalk.hex(C.cyan)(info.provider)));
  lines.push(kvLine('Model', chalk.hex(C.cyan)(info.model)));
  lines.push(kvLine('Tools', `${info.tools} loaded`));
  lines.push(kvLine('Skills', info.skills ? sColor('on') : chalk.hex(C.muted)('off')));
  if (info.fallback) lines.push(kvLine('Fallback', sColor('OpenRouter (auto)')));
  lines.push(kvLine('Lazy Tools', info.lazyTools ? sColor('on') : chalk.hex(C.muted)('off')));
  lines.push(kvLine('Authorization', info.autoApprove ? wColor('fully autonomous') : sColor('tiered (Tier 1/2/3)')));
  if (info.turnApproval !== 'off') lines.push(kvLine('Turn Checkpoints', sColor(info.turnApproval)));
  lines.push(empty);

  // Help hint
  const helpHint = `   Type ${chalk.hex(C.cyan)('/help')} for commands, ${chalk.hex(C.cyan)('/exit')} to quit`;
  lines.push(frameLine(helpHint, innerWidth));
  lines.push(empty);
  lines.push(botBorder);
  lines.push('');

  console.log(lines.join('\n'));
}

/** Print a framed assistant response. */
function printAssistantReply(text: string): void {
  const g = glyphs();
  const contentWidth = getChatWidth();
  const innerWidth = contentWidth - 2;
  const maxTextWidth = innerWidth - 6; // 3 indent + 3 margin

  // Word-wrap the reply text
  const wrappedLines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      wrappedLines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > maxTextWidth && current.length > 0) {
        wrappedLines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) wrappedLines.push(current);
  }

  const topLine = `  ${accentBorder(g.box.tl)}${accentBorder(g.box.h.repeat(innerWidth - 2))}${accentBorder(g.box.tr)}`;
  const botLine = `  ${accentBorder(g.box.bl)}${accentBorder(g.box.h.repeat(innerWidth - 2))}${accentBorder(g.box.br)}`;
  const replyFrame = (content: string): string => {
    const vLen = visibleLength(content);
    const pad = Math.max(0, innerWidth - 2 - vLen);
    return `  ${accentBorder(g.box.v)}${content}${' '.repeat(pad)}${accentBorder(g.box.v)}`;
  };
  const emptyReply = replyFrame(' '.repeat(innerWidth - 2));

  const lines: string[] = [];
  lines.push('');
  lines.push(topLine);
  lines.push(emptyReply);
  for (const wl of wrappedLines) {
    lines.push(replyFrame(`   ${chalk.hex(C.text)(wl)}`));
  }
  lines.push(emptyReply);
  lines.push(botLine);
  lines.push('');

  console.log(lines.join('\n'));
}

/** Styled chat prompt string. */
function chatPrompt(): string {
  const frame = chatFrameGlyphs();
  const g = glyphs();
  return `  ${frameBorder(frame.v)} ${chalk.hex(C.brightCyan)(g.cursor)} `;
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdChat(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
  ): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const configPath = path.resolve(process.cwd(), 'agent.config.json');
  const sealedPath = path.resolve(process.cwd(), 'sealed.json');
  let cfg: any | null = null;

  // Observability (OTEL) is opt-in, and agent.config.json can override env.
  try {
    if (existsSync(configPath)) {
      const configRaw = await readFile(configPath, 'utf8');
      if (existsSync(sealedPath)) {
        const sealedRaw = await readFile(sealedPath, 'utf8');
        const verification = verifySealedConfig({ configRaw, sealedRaw });
        if (!verification.ok) {
          fmt.errorBlock(
            'Seal verification failed',
            `${verification.error || 'Verification failed.'}\nRun: ${chalk.white('wunderland verify-seal')}`,
          );
          process.exitCode = 1;
          return;
        }
        if (!verification.signaturePresent) {
          fmt.warning('Sealed config has no signature (hash-only verification).');
        }
      }

      cfg = JSON.parse(configRaw);
      const cfgOtelEnabled = cfg?.observability?.otel?.enabled;
      if (typeof cfgOtelEnabled === 'boolean') {
        process.env['WUNDERLAND_OTEL_ENABLED'] = cfgOtelEnabled ? 'true' : 'false';
      }
      const cfgOtelLogsEnabled = cfg?.observability?.otel?.exportLogs;
      if (typeof cfgOtelLogsEnabled === 'boolean') {
        process.env['WUNDERLAND_OTEL_LOGS_ENABLED'] = cfgOtelLogsEnabled ? 'true' : 'false';
      }
    }
  } catch (err) {
    if (existsSync(sealedPath)) {
      fmt.errorBlock('Seal verification failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    // Unsealed config parse errors are non-fatal (defaults apply).
  }

  await startWunderlandOtel({ serviceName: 'wunderland-chat' });

  const policy = normalizeRuntimePolicy(cfg || {});
  const permissions = getPermissionsForSet(policy.permissionSet);
  const turnApprovalMode = (() => {
    const raw = (cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl))
      ? (cfg.hitl as any).turnApprovalMode ?? (cfg.hitl as any).turnApproval
      : undefined;
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (v === 'after-each-turn') return 'after-each-turn';
    if (v === 'after-each-round') return 'after-each-round';
    return 'off';
  })();

  const providerFlag = typeof flags['provider'] === 'string' ? String(flags['provider']).trim() : '';
  const providerFromConfig = typeof cfg?.llmProvider === 'string' ? String(cfg.llmProvider).trim() : '';
  const providerId = (flags['ollama'] === true ? 'ollama' : (providerFlag || providerFromConfig || 'openai')).toLowerCase();
  if (!new Set(['openai', 'openrouter', 'ollama', 'anthropic']).has(providerId)) {
    fmt.errorBlock(
      'Unsupported LLM provider',
      `Provider "${providerId}" is not supported by this CLI runtime.\nSupported: openai, openrouter, ollama, anthropic`,
    );
    process.exitCode = 1;
    return;
  }

  const modelFromConfig = typeof cfg?.llmModel === 'string' ? String(cfg.llmModel).trim() : '';
  const model = typeof flags['model'] === 'string'
    ? String(flags['model'])
    : (modelFromConfig || (process.env['OPENAI_MODEL'] || 'gpt-4o-mini'));

  // OpenRouter fallback (OpenAI provider only)
  const openrouterApiKey = process.env['OPENROUTER_API_KEY'] || '';
  const openrouterFallback: LLMProviderConfig | undefined = openrouterApiKey
    ? {
        apiKey: openrouterApiKey,
        model: typeof flags['openrouter-model'] === 'string' ? flags['openrouter-model'] : 'auto',
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: { 'HTTP-Referer': 'https://wunderland.sh', 'X-Title': 'Wunderbot' },
      }
    : undefined;

  const llmBaseUrl =
    providerId === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : providerId === 'ollama' ? 'http://localhost:11434/v1'
    : undefined;
  // Resolve auth method (OAuth or API key)
  const authMethod: 'api-key' | 'oauth' =
    (cfg.llmAuthMethod === 'oauth' || flags['oauth'] === true) && providerId === 'openai'
      ? 'oauth'
      : 'api-key';

  let llmApiKey: string;
  let oauthGetApiKey: (() => Promise<string>) | undefined;

  if (authMethod === 'oauth') {
    try {
      const { OpenAIOAuthFlow, FileTokenStore } = await import('@framers/agentos/auth');
      const flow = new OpenAIOAuthFlow({ tokenStore: new FileTokenStore() });
      const initialKey = await flow.getAccessToken();
      llmApiKey = initialKey;
      oauthGetApiKey = () => flow.getAccessToken();
    } catch {
      fmt.errorBlock(
        'OAuth authentication required',
        `Run ${accent('wunderland login')} to authenticate with your OpenAI subscription.`,
      );
      process.exitCode = 1;
      return;
    }
  } else {
    llmApiKey =
      providerId === 'openrouter' ? openrouterApiKey
      : providerId === 'ollama' ? 'ollama'
      : providerId === 'openai' ? (process.env['OPENAI_API_KEY'] || '')
      : providerId === 'anthropic' ? (process.env['ANTHROPIC_API_KEY'] || '')
      : (process.env['OPENAI_API_KEY'] || '');
  }

  const canUseLLM =
    authMethod === 'oauth'
      ? true
      : providerId === 'ollama'
        ? true
        : providerId === 'openrouter'
          ? !!openrouterApiKey
          : providerId === 'anthropic'
            ? !!process.env['ANTHROPIC_API_KEY']
            : !!llmApiKey || !!openrouterFallback;

  if (!canUseLLM) {
    fmt.errorBlock(
      'Missing API key',
      'Configure an LLM provider in agent.config.json, set OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY, use `wunderland login` for OAuth, or use Ollama.',
    );
    process.exitCode = 1;
    return;
  }

  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const dangerouslySkipCommandSafety =
    flags['dangerously-skip-command-safety'] === true || dangerouslySkipPermissions;
  const autoApproveToolCalls =
    globals.autoApproveTools || dangerouslySkipPermissions || policy.executionMode === 'autonomous';
  const enableSkills = flags['no-skills'] !== true;
  const lazyTools = flags['lazy-tools'] === true;
  const workspaceBaseDir = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(`chat-${path.basename(process.cwd())}`);

  const toolMap = new Map<string, ToolInstance>();
  const preloadedPackages: string[] = [];

  if (!lazyTools) {
    // Read extensions from agent.config.json if present
    let extensionsFromConfig: any = null;
    let extensionOverrides: any = null;
    let configSecrets: any = null;
    try {
      const configPath = path.resolve(process.cwd(), 'agent.config.json');
      if (existsSync(configPath)) {
        const cfg = JSON.parse(await readFile(configPath, 'utf8'));
        extensionsFromConfig = cfg.extensions;
        extensionOverrides = cfg.extensionOverrides;
        configSecrets = cfg.secrets;
      }
    } catch {
      // ignore
    }

    let toolExtensions: string[] = [];
    let voiceExtensions: string[] = [];
    let productivityExtensions: string[] = [];

    if (extensionsFromConfig) {
      toolExtensions = extensionsFromConfig.tools || [];
      voiceExtensions = extensionsFromConfig.voice || [];
      productivityExtensions = extensionsFromConfig.productivity || [];
      fmt.note(`Loading ${toolExtensions.length + voiceExtensions.length + productivityExtensions.length} extensions from config...`);
    } else {
      // Fall back to hardcoded defaults
      toolExtensions = ['cli-executor', 'web-search', 'web-browser', 'giphy', 'image-search', 'news-search'];
      voiceExtensions = ['voice-synthesis'];
      productivityExtensions = [];
      fmt.note('No extensions configured, using defaults...');
    }

    // Resolve extensions using PresetExtensionResolver
    try {
      const { resolveExtensionsByNames } = await import('../../core/PresetExtensionResolver.js');
      const configOverrides = (extensionOverrides && typeof extensionOverrides === 'object')
        ? (extensionOverrides as Record<string, any>)
        : {};

      const runtimeOverrides: Record<string, any> = {
        'cli-executor': {
          options: {
            filesystem: { allowRead: permissions.filesystem.read, allowWrite: permissions.filesystem.write },
            agentWorkspace: {
              agentId: workspaceAgentId,
              baseDir: workspaceBaseDir,
              createIfMissing: true,
              subdirs: ['assets', 'exports', 'tmp'],
            },
            dangerouslySkipSecurityChecks: dangerouslySkipCommandSafety,
          },
        },
        'web-search': {
          options: {
            serperApiKey: process.env['SERPER_API_KEY'],
            serpApiKey: process.env['SERPAPI_API_KEY'],
            braveApiKey: process.env['BRAVE_API_KEY'],
          },
        },
        'web-browser': {
          options: {
            headless: true,
            executablePath:
              process.env['PUPPETEER_EXECUTABLE_PATH'] ||
              process.env['CHROME_EXECUTABLE_PATH'] ||
              process.env['CHROME_PATH'],
          },
        },
        giphy: { options: { giphyApiKey: process.env['GIPHY_API_KEY'] } },
        'image-search': {
          options: {
            pexelsApiKey: process.env['PEXELS_API_KEY'],
            unsplashApiKey: process.env['UNSPLASH_ACCESS_KEY'],
            pixabayApiKey: process.env['PIXABAY_API_KEY'],
          },
        },
        'voice-synthesis': { options: { elevenLabsApiKey: process.env['ELEVENLABS_API_KEY'] } },
        'news-search': { options: { newsApiKey: process.env['NEWSAPI_API_KEY'] } },
        'wunderbot-feeds': {
          options: {
            feeds: (cfg as any)?.feeds ?? {},
          },
        },
      };

      function mergeOverride(base: any, extra: any): any {
        const out = { ...(base || {}), ...(extra || {}) };
        if ((base && base.options) || (extra && extra.options)) {
          out.options = { ...(base?.options || {}), ...(extra?.options || {}) };
        }
        return out;
      }

      const mergedOverrides: Record<string, any> = { ...configOverrides };
      for (const [name, override] of Object.entries(runtimeOverrides)) {
        mergedOverrides[name] = mergeOverride(configOverrides[name], override);
      }

      const cfgSecrets = (configSecrets && typeof configSecrets === 'object' && !Array.isArray(configSecrets))
        ? (configSecrets as Record<string, string>)
        : undefined;
      const getSecret = createEnvSecretResolver({ configSecrets: cfgSecrets });
      const secrets = new Proxy<Record<string, string>>({} as any, {
        get: (_target, prop) => (typeof prop === 'string' ? getSecret(prop) : undefined),
      });

      const channelsFromConfig = Array.isArray((cfg as any)?.channels)
        ? ((cfg as any).channels as unknown[])
        : Array.isArray((cfg as any)?.suggestedChannels)
          ? ((cfg as any).suggestedChannels as unknown[])
          : [];
      const channelsToLoad = Array.from(new Set(
        channelsFromConfig
          .map((v) => String(v ?? '').trim())
          .filter((v) => v.length > 0),
      ));

      const resolved = await resolveExtensionsByNames(
        toolExtensions,
        voiceExtensions,
        productivityExtensions,
        mergedOverrides,
        { secrets: secrets as any, channels: channelsToLoad.length > 0 ? channelsToLoad : 'none' }
      );

      const packs: any[] = [];

      for (const packEntry of resolved.manifest.packs) {
        try {
          if ((packEntry as any)?.enabled === false) continue;

          if (typeof (packEntry as any)?.factory === 'function') {
            const pack = await (packEntry as any).factory();
            if (pack) {
              packs.push(pack);
              if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
            }
            continue;
          }

          let packageName: string | undefined;
          if ('package' in (packEntry as any)) packageName = (packEntry as any).package as string;
          else if ('module' in (packEntry as any)) packageName = (packEntry as any).module as string;
          if (!packageName) continue;

          const extModule = await import(packageName);
          const factory = extModule.createExtensionPack ?? extModule.default?.createExtensionPack ?? extModule.default;
          if (typeof factory !== 'function') continue;

          const options: any = (packEntry as any).options || {};
          const pack = await factory({ options, logger: console, getSecret });
          packs.push(pack);
          if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fmt.warning(`Failed to load extension pack: ${msg}`);
        }
      }

      // Optional skills extension (may not be installed in standalone builds)
      try {
        const skillsPkg = '@framers/agentos-ext-skills';
        const skillsExt: any = await import(/* webpackIgnore: true */ skillsPkg);
        if (skillsExt?.createExtensionPack) {
          packs.push(skillsExt.createExtensionPack({ options: {}, logger: console, getSecret }));
          preloadedPackages.push(skillsPkg);
        }
      } catch {
        // Not available — skip silently
      }

      await Promise.all(
        packs
          .map((p: any) =>
            typeof p?.onActivate === 'function'
              ? p.onActivate({ logger: console, getSecret })
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

      fmt.ok(`Loaded ${tools.length} tools from ${packs.length} extensions`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fmt.warning(`Extension loading failed, using empty toolset: ${msg}`);
    }
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

  // Enforce tool access profile + permission set (agent.config.json only).
  // For generic `wunderland chat` without a project config, keep legacy behavior.
  if (cfg) {
    const filtered = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: policy.toolAccessProfile,
      permissions,
    });
    toolMap.clear();
    for (const [k, v] of filtered.toolMap.entries()) toolMap.set(k, v);
  }

  // Capability discovery — semantic search + graph re-ranking
  const discoveryOpts: WunderlandDiscoveryConfig = {};
  if (cfg?.discovery) {
    const d = cfg.discovery as Record<string, unknown>;
    if (typeof d.enabled === 'boolean') discoveryOpts.enabled = d.enabled;
    if (d.recallProfile === 'aggressive' || d.recallProfile === 'balanced' || d.recallProfile === 'precision') {
      discoveryOpts.recallProfile = d.recallProfile;
    }
    if (typeof d.embeddingProvider === 'string') discoveryOpts.embeddingProvider = d.embeddingProvider;
    if (typeof d.embeddingModel === 'string') discoveryOpts.embeddingModel = d.embeddingModel;
    if (typeof d.scanManifests === 'boolean') discoveryOpts.scanManifestDirs = d.scanManifests;
    const budgetFields = { tier0Budget: 'tier0TokenBudget', tier1Budget: 'tier1TokenBudget', tier2Budget: 'tier2TokenBudget', tier1TopK: 'tier1TopK', tier2TopK: 'tier2TopK' } as const;
    const configOverrides: Record<string, number> = {};
    for (const [src, dest] of Object.entries(budgetFields)) {
      if (typeof d[src] === 'number') configOverrides[dest] = d[src] as number;
    }
    if (Object.keys(configOverrides).length > 0) discoveryOpts.config = configOverrides as any;
  }
  // Skills — load from filesystem dirs + config-declared skills (BEFORE discovery so we can pass entries)
  let skillsPrompt = '';
  const skillEntries: Array<{ name: string; description: string; content: string; category?: string; tags?: string[] }> = [];
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
      // Extract entries for discovery indexing
      if (typeof skillRegistry.listAll === 'function') {
        for (const entry of skillRegistry.listAll() as any[]) {
          const skill = entry.skill ?? entry;
          skillEntries.push({
            name: skill.name ?? 'unknown',
            description: skill.description ?? '',
            content: skill.content ?? '',
          });
        }
      }
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
        // Extract skill names for discovery
        if (Array.isArray(presetSnapshot.skills)) {
          const existing = new Set(skillEntries.map((e) => e.name));
          for (const skill of presetSnapshot.skills as any[]) {
            const name = typeof skill === 'string' ? skill : skill.name ?? 'unknown';
            if (!existing.has(name)) {
              skillEntries.push({ name, description: '', content: '' });
            }
          }
        }
      }
    } catch { /* non-fatal — no config or registry not installed */ }

    skillsPrompt = parts.filter(Boolean).join('\n\n');
  }

  // Discovery — initialized after skills so skillEntries can be indexed
  const discoveryManager = new WunderlandDiscoveryManager(discoveryOpts);
  try {
    await discoveryManager.initialize({
      toolMap,
      skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
      llmConfig: { providerId, apiKey: llmApiKey, baseUrl: llmBaseUrl },
    });
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, {
        name: metaTool.name,
        description: metaTool.description,
        inputSchema: metaTool.inputSchema as any,
        hasSideEffects: metaTool.hasSideEffects,
        category: 'productivity',
        execute: metaTool.execute as any,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.warning(`Discovery initialization failed (continuing without): ${msg}`);
  }

  const adaptiveRuntime = new WunderlandAdaptiveExecutionRuntime({
    toolFailureMode: cfg?.toolFailureMode,
    taskOutcomeTelemetry: cfg?.taskOutcomeTelemetry,
    adaptiveExecution: cfg?.adaptiveExecution,
    logger: console,
  });
  await adaptiveRuntime.initialize();

  const seedId = cfg?.seedId ? String(cfg.seedId) : `seed_chat_${Date.now()}`;
  const displayName = cfg?.displayName ? String(cfg.displayName) : 'Wunderland CLI';
  const bio = cfg?.bio ? String(cfg.bio) : 'Interactive terminal assistant';
  const personality = cfg?.personality || {};
  const seed = createWunderlandSeed({
    seedId,
    name: displayName,
    description: bio,
    hexacoTraits: {
      honesty_humility: Number.isFinite(personality.honesty) ? personality.honesty : 0.8,
      emotionality: Number.isFinite(personality.emotionality) ? personality.emotionality : 0.5,
      extraversion: Number.isFinite(personality.extraversion) ? personality.extraversion : 0.6,
      agreeableness: Number.isFinite(personality.agreeableness) ? personality.agreeableness : 0.7,
      conscientiousness: Number.isFinite(personality.conscientiousness) ? personality.conscientiousness : 0.8,
      openness: Number.isFinite(personality.openness) ? personality.openness : 0.7,
    },
    baseSystemPrompt: typeof cfg?.systemPrompt === 'string' ? cfg.systemPrompt : undefined,
    securityProfile: DEFAULT_SECURITY_PROFILE,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });

  const systemPrompt = [
    typeof seed.baseSystemPrompt === 'string' ? seed.baseSystemPrompt : String(seed.baseSystemPrompt),
    'You are Wunderland CLI, an interactive terminal assistant.',
    cfg
      ? `Execution mode: ${policy.executionMode}. Permission set: ${policy.permissionSet}. Tool access profile: ${policy.toolAccessProfile}.`
      : '',
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
  const toolContext = {
    gmiId: sessionId,
    personaId: seedId,
    userContext: { userId: process.env['USER'] || 'local-user' },
    agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    interactiveSession: true,
    ...(cfg ? {
      permissionSet: policy.permissionSet,
      securityTier: policy.securityTier,
      executionMode: policy.executionMode,
      toolAccessProfile: policy.toolAccessProfile,
      wrapToolOutputs: policy.wrapToolOutputs,
      turnApprovalMode,
    } : null),
    ...(cfg && policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
  };
  const localUserId = String((toolContext as any)?.userContext?.userId ?? 'local-user');
  const tenantId = typeof (cfg as any)?.organizationId === 'string' && String((cfg as any).organizationId).trim()
    ? String((cfg as any).organizationId).trim()
    : undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

  printChatHeader({
    provider: providerId,
    model,
    tools: toolMap.size,
    skills: enableSkills,
    fallback: providerId === 'openai' && !!openrouterFallback,
    lazyTools,
    autoApprove: autoApproveToolCalls,
    turnApproval: turnApprovalMode,
  });

  const askPermission = async (tool: ToolInstance, args: Record<string, unknown>): Promise<boolean> => {
    if (autoApproveToolCalls) return true;
    const preview = safeJsonStringify(args, 800);
    const effectLabel = tool.hasSideEffects === true ? 'side effects' : 'read-only';
    const q = `  ${wColor(glyphs().warn)} Allow ${tColor(tool.name)} (${effectLabel})?\n${dim(preview)}\n  ${muted('[y/N]')} `;
    const answer = (await rl.question(q)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  };

  const askCheckpoint = turnApprovalMode === 'off'
    ? undefined
    : async (info: { round: number; toolCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }> }): Promise<boolean> => {
        if (autoApproveToolCalls) return true;
        const summary = info.toolCalls.map((c) => {
          const effect = c.hasSideEffects ? 'side effects' : 'read-only';
          const preview = safeJsonStringify(c.args, 600);
          return `- ${c.toolName} (${effect}): ${preview}`;
        }).join('\n');
        const q = `  ${wColor(glyphs().warn)} Checkpoint after round ${info.round}.\n${dim(summary || '(no tool calls)')}\n  ${muted('Continue? [y/N]')} `;
        const answer = (await rl.question(q)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      };

  for (;;) {
    const line = await rl.question(chatPrompt());
    const input = (line || '').trim();
    if (!input) continue;

    if (input === '/exit' || input === 'exit' || input === 'quit') break;

    if (input === '/help') {
      const cw = getChatWidth();
      const iw = cw - 2;
      const helpLines: string[] = [];
      helpLines.push('');
      helpLines.push(frameLine(`   ${chalk.hex(C.cyan)('/help')}      ${chalk.hex(C.text)('Show this help')}`, iw));
      helpLines.push(frameLine(`   ${chalk.hex(C.cyan)('/tools')}     ${chalk.hex(C.text)('List available tools')}`, iw));
      helpLines.push(frameLine(`   ${chalk.hex(C.cyan)('/discover')}  ${chalk.hex(C.text)('Show discovery stats')}`, iw));
      helpLines.push(frameLine(`   ${chalk.hex(C.cyan)('/exit')}      ${chalk.hex(C.text)('Quit')}`, iw));
      helpLines.push('');
      console.log(helpLines.join('\n'));
      continue;
    }

    if (input === '/tools') {
      const names = [...toolMap.keys()].sort();
      const cw = getChatWidth();
      const iw = cw - 2;
      const toolLines: string[] = [''];
      for (const n of names) {
        toolLines.push(frameLine(`   ${chalk.hex(C.magenta)(n)}`, iw));
      }
      toolLines.push('');
      console.log(toolLines.join('\n'));
      continue;
    }

    if (input === '/discover') {
      const dStats = discoveryManager.getStats();
      const cw = getChatWidth();
      const iw = cw - 2;
      const dLines: string[] = [''];
      dLines.push(frameLine(`   ${chalk.hex(C.brightCyan)('Discovery Stats')}`, iw));
      dLines.push(frameLine(`   Enabled:       ${dStats.enabled ? sColor('yes') : wColor('no')}`, iw));
      dLines.push(frameLine(`   Initialized:   ${dStats.initialized ? sColor('yes') : wColor('no')}`, iw));
      dLines.push(frameLine(`   Capabilities:  ${dStats.capabilityCount}`, iw));
      dLines.push(frameLine(`   Graph nodes:   ${dStats.graphNodes}`, iw));
      dLines.push(frameLine(`   Graph edges:   ${dStats.graphEdges}`, iw));
      dLines.push(frameLine(`   Preset co-occ: ${dStats.presetCoOccurrences}`, iw));
      if (dStats.manifestDirs.length > 0) {
        dLines.push(frameLine(`   Manifest dirs: ${dStats.manifestDirs.join(', ')}`, iw));
      }
      dLines.push('');
      console.log(dLines.join('\n'));
      continue;
    }

    messages.push({ role: 'user', content: input });

    // Capability discovery — inject tiered context for this turn
    try {
      const discoveryResult = await discoveryManager.discoverForTurn(input);
      if (discoveryResult) {
        for (let i = messages.length - 1; i >= 1; i--) {
          if (typeof messages[i]?.content === 'string' && String(messages[i]!.content).startsWith('[Capability Context]')) {
            messages.splice(i, 1);
          }
        }
        const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
        if (discoveryResult.tier1.length > 0) {
          ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r) => r.summaryText).join('\n'));
        }
        if (discoveryResult.tier2.length > 0) {
          ctxParts.push(discoveryResult.tier2.map((r) => r.fullText).join('\n'));
        }
        messages.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });
      }
    } catch {
      // Non-fatal
    }

    const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
      scope: {
        sessionId,
        userId: localUserId,
        personaId: seedId,
        tenantId,
      },
    });
    (toolContext as any).toolFailureMode = adaptiveDecision.toolFailureMode;
    (toolContext as any).adaptiveExecution = {
      degraded: adaptiveDecision.degraded,
      reason: adaptiveDecision.reason,
      actions: adaptiveDecision.actions,
      kpi: adaptiveDecision.kpi ?? undefined,
    };

    let reply = '';
    let turnFailed = false;
    let fallbackTriggered = false;
    let toolCallCount = 0;
    try {
      reply = await runToolCallingTurn({
        providerId,
        apiKey: llmApiKey,
        model,
        messages,
        toolMap,
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions,
        askPermission,
        askCheckpoint,
        toolFailureMode: adaptiveDecision.toolFailureMode,
        baseUrl: llmBaseUrl,
        fallback: providerId === 'openai' ? openrouterFallback : undefined,
        getApiKey: oauthGetApiKey,
        onFallback: (_err, provider) => {
          fallbackTriggered = true;
          console.log(`  ${frameBorder(chatFrameGlyphs().v)} ${wColor('!')} Primary provider failed, falling back to ${chalk.hex(C.cyan)(provider)}`);
        },
        onToolCall: (tool: ToolInstance, args: Record<string, unknown>) => {
          toolCallCount += 1;
          console.log(
            `  ${frameBorder(chatFrameGlyphs().v)} ${chalk.hex(C.magenta)('>')} ${chalk.hex(C.magenta)(tool.name)} ${chalk.hex(C.dim)(truncateString(JSON.stringify(args), 120))}`
          );
        },
      });
    } catch (error) {
      turnFailed = true;
      throw error;
    } finally {
      try {
        await adaptiveRuntime.recordTurnOutcome({
          scope: {
            sessionId,
            userId: localUserId,
            personaId: seedId,
            tenantId,
          },
          degraded: adaptiveDecision.degraded || fallbackTriggered,
          replyText: reply,
          didFail: turnFailed,
          toolCallCount,
        });
      } catch (error) {
        console.warn('[wunderland/chat] Failed to record adaptive outcome', error);
      }
    }

    if (reply) {
      printAssistantReply(reply);
    }
  }

  rl.close();
  await discoveryManager.close();
  await adaptiveRuntime.close();
  await shutdownWunderlandOtel();

  // Session ended banner
  const cw = getChatWidth();
  const iw = cw - 2;
  const endDivL = Math.max(0, Math.floor((iw - 18) / 2));
  const endDivR = Math.max(0, iw - 18 - endDivL);
  console.log('');
  const g = glyphs();
  console.log(`  ${frameBorder(g.hr.repeat(endDivL))} ${chalk.hex(C.muted)('Session ended.')} ${frameBorder(g.hr.repeat(endDivR))}`);
  console.log('');
}
