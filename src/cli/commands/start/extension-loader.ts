/**
 * @fileoverview Extension packs, tools, channels, wallet, console capture.
 * Extracted from start.ts lines 486-829.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fmt from '../../ui/format.js';
import { type ToolInstance, getGuardrailsInstance } from '../../openai/tool-calling.js';
import { createSchemaOnDemandTools } from '../../openai/schema-on-demand.js';
import { filterToolMapByPolicy } from '../../security/runtime-policy.js';
import { createEnvSecretResolver } from '../../security/env-secrets.js';
import { createConfiguredRagTools } from '../../../rag/runtime-tools.js';
import { createLocalMemoryReadTool } from './local-memory-tool.js';
import { createRequestFolderAccessTool } from '../../../tools/RequestFolderAccessTool.js';
import { HumanInteractionManager, type IChannelAdapter } from '@framers/agentos';
import {
  createSpeechExtensionEnvOverrides,
  getDefaultVoiceExtensions,
} from '../../../voice/speech-catalog.js';

type ExtensionHttpHandler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => Promise<boolean> | boolean;

function toToolInstance(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  category?: string;
  requiredCapabilities?: string[];
  execute: (...args: any[]) => any;
}): ToolInstance {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as any,
    hasSideEffects: tool.hasSideEffects === true,
    category: typeof tool.category === 'string' && tool.category.trim() ? tool.category : 'productivity',
    requiredCapabilities: tool.requiredCapabilities,
    execute: tool.execute as any,
  };
}

export async function loadExtensions(ctx: any): Promise<void> {
  const {
    cfg,
    permissions,
    policy,
    dangerouslySkipCommandSafety,
    workspaceAgentId,
    workspaceBaseDir,
    lazyTools,
    LOCAL_ONLY_CHANNELS,
    CLI_REQUIRED_CHANNELS,
  } = ctx;

  const preloadedPackages: string[] = [];
  let activePacks: any[] = [];
  let allTools: ToolInstance[] = [];
  const loadedChannelAdapters: IChannelAdapter[] = [];
  const loadedHttpHandlers: ExtensionHttpHandler[] = [];
  const hitlSecret = (() => {
    const fromCfg = (cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl))
      ? String((cfg.hitl as any).secret || '').trim()
      : '';
    const fromEnv = String(process.env['WUNDERLAND_HITL_SECRET'] || '').trim();
    return fromCfg || fromEnv || randomUUID();
  })();
  const chatSecret = (() => {
    const fromCfg = (cfg?.chat && typeof cfg.chat === 'object' && !Array.isArray(cfg.chat))
      ? String((cfg.chat as any).secret || '').trim()
      : '';
    const fromEnv = String(process.env['WUNDERLAND_CHAT_SECRET'] || '').trim();
    return fromCfg || fromEnv || '';
  })();
  const feedSecret = (() => {
    const fromEnv = String(process.env['WUNDERLAND_FEED_SECRET'] || '').trim();
    return fromEnv || chatSecret; // fall back to chat secret if no feed secret
  })();
  const sseClients = new Set<import('node:http').ServerResponse>();

  async function broadcastHitlUpdate(payload: Record<string, unknown>): Promise<void> {
    const data = JSON.stringify(payload);
    for (const client of Array.from(sseClients)) {
      try {
        client.write(`event: hitl\ndata: ${data}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }
  const hitlManager = new HumanInteractionManager({
    defaultTimeoutMs: 5 * 60_000,
    autoRejectOnTimeout: true,
    notificationHandler: async (notification) => {
      await broadcastHitlUpdate({ type: 'notification', notification });
    },
  });

  // ── Capture startup output into a bordered panel ──────────────────────────
  const startupLines: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const captureLog = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    startupLines.push(line);
  };
  const origWarn = console.warn;
  console.log = captureLog as typeof console.log;
  console.info = captureLog as typeof console.info;
  console.warn = captureLog as typeof console.warn;

  if (!lazyTools) {
    // Load extensions dynamically from agent.config.json or use defaults
    const extensionsFromConfig = cfg.extensions;
    let toolExtensions: string[] = [];
    let voiceExtensions: string[] = [];
    let productivityExtensions: string[] = [];

    if (extensionsFromConfig) {
      // Load from config if present
      toolExtensions = extensionsFromConfig.tools || [];
      voiceExtensions = extensionsFromConfig.voice || [];
      productivityExtensions = extensionsFromConfig.productivity || [];
      fmt.note(`Loading ${toolExtensions.length + voiceExtensions.length + productivityExtensions.length} extensions from config...`);
    } else {
      // Fall back to hardcoded defaults if no extensions field
      toolExtensions = ['cli-executor', 'web-search', 'web-browser', 'browser-automation', 'content-extraction', 'credential-vault', 'giphy', 'image-search', 'news-search', 'weather', 'skills', 'deep-research', 'github'];
      voiceExtensions = getDefaultVoiceExtensions();
      productivityExtensions = [];
      fmt.note('No extensions configured, using defaults...');
    }

    // Resolve extensions to manifests using PresetExtensionResolver
    try {
      const { resolveExtensionsByNames } = await import('../../../core/PresetExtensionResolver.js');
      const configOverrides = (cfg?.extensionOverrides && typeof cfg.extensionOverrides === 'object')
        ? (cfg.extensionOverrides as Record<string, any>)
        : {};

      // Build filesystem roots: agent workspace + user's home directory + cwd.
      // Without explicit roots, the cli-executor defaults to [workspaceDir] only,
      // which locks the agent out of the rest of the user's filesystem.
      const homeDir = (await import('node:os')).homedir();
      const workspaceDir = path.resolve(workspaceBaseDir, workspaceAgentId);
      const cwd = process.cwd();
      const readRoots = [workspaceDir, homeDir, cwd, '/tmp'];
      const writeRoots = [workspaceDir, homeDir, cwd, '/tmp'];

      const runtimeOverrides: Record<string, any> = {
        'cli-executor': {
          options: {
            workingDirectory: cwd,
            filesystem: {
              allowRead: permissions.filesystem.read,
              allowWrite: permissions.filesystem.write,
              readRoots: permissions.filesystem.read ? readRoots : undefined,
              writeRoots: permissions.filesystem.write ? writeRoots : undefined,
            },
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
        ...createSpeechExtensionEnvOverrides(),
        'news-search': { options: { newsApiKey: process.env['NEWSAPI_API_KEY'] } },
        'browser-automation': {
          options: {
            headless: true,
            userDataDir: workspaceBaseDir ? `${workspaceBaseDir}/${workspaceAgentId}/browser-data` : undefined,
          },
        },
        'content-extraction': { options: {} },
        'credential-vault': { options: {} },
        'email-gmail': {
          options: {
            clientId: process.env['GOOGLE_CLIENT_ID'],
            clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
            refreshToken: process.env['GOOGLE_REFRESH_TOKEN'],
          },
        },
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

      const cfgSecrets = (cfg?.secrets && typeof cfg.secrets === 'object' && !Array.isArray(cfg.secrets))
        ? (cfg.secrets as Record<string, string>)
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

      const blockedChannels: Array<{ platform: string; reason: string }> = [];

      const allowedChannels = channelsToLoad.filter((platform) => {
        if (LOCAL_ONLY_CHANNELS.has(platform)) return true;
        if (permissions.network.externalApis !== true) {
          blockedChannels.push({ platform, reason: 'blocked_by_permission_set:network.externalApis=false' });
          return false;
        }
        if (CLI_REQUIRED_CHANNELS.has(platform) && permissions.system.cliExecution !== true) {
          blockedChannels.push({ platform, reason: 'blocked_by_permission_set:system.cliExecution=false' });
          return false;
        }
        return true;
      });

      if (blockedChannels.length > 0) {
        const list = blockedChannels.map((c) => c.platform).join(', ');
        fmt.warning(`Permission set blocks some configured channels - skipping: ${list}`);
      }

      const resolved = await resolveExtensionsByNames(
        toolExtensions,
        voiceExtensions,
        productivityExtensions,
        mergedOverrides,
        { secrets: secrets as any, channels: allowedChannels.length > 0 ? allowedChannels : 'none' }
      );

      const packs: any[] = [];

      for (const packEntry of resolved.manifest.packs) {
        if ((packEntry as any)?.enabled === false) continue;

        try {
          if (typeof (packEntry as any)?.factory === 'function') {
            const pack = await (packEntry as any).factory();
            if (pack) {
              packs.push(pack);
              if (typeof pack?.name === 'string') preloadedPackages.push(pack.name);
            }
            continue;
          }

          // Back-compat for manifests that still emit {package}/{module} resolvers.
          let packageName: string | undefined;
          if ('package' in (packEntry as any)) packageName = (packEntry as any).package as string;
          else if ('module' in (packEntry as any)) packageName = (packEntry as any).module as string;
          if (!packageName) continue;

          const extModule = await import(packageName);
          const factory = extModule.createExtensionPack ?? extModule.default?.createExtensionPack ?? extModule.default;
          if (typeof factory !== 'function') {
            fmt.warning(`Extension ${packageName} does not export createExtensionPack`);
            continue;
          }
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

      // Activate all packs (graceful — don't let one bad extension crash everything)
      const activationResults = await Promise.allSettled(
        packs
          .map((p: any) =>
            typeof p?.onActivate === 'function'
              ? p.onActivate({ logger: console, getSecret })
              : null
          )
          .filter(Boolean),
      );
      for (const result of activationResults) {
        if (result.status === 'rejected') {
          const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          fmt.warning(`Extension activation failed: ${msg}`);
        }
      }

      activePacks = packs;

      // Extract messaging-channel adapters (if any) for inbound/outbound channel runtime.
      const adapters = packs
        .flatMap((p: any) => (p?.descriptors || []))
        .filter((d: { kind?: string; payload?: unknown }) => d?.kind === 'messaging-channel')
        .map((d: { payload: unknown }) => d.payload)
        .filter(Boolean) as IChannelAdapter[];
      loadedChannelAdapters.push(...adapters);

      // Extract HTTP handlers from packs (e.g., webhook endpoints).
      const httpHandlers = packs
        .flatMap((p: any) => (p?.descriptors || []))
        .filter((d: { kind?: string; payload?: unknown }) => d?.kind === 'http-handler')
        .map((d: { payload: unknown }) => d.payload)
        .filter(Boolean) as ExtensionHttpHandler[];
      loadedHttpHandlers.push(...httpHandlers);

      // Extract tools from packs
      allTools = packs
        .flatMap((p: any) => (p?.descriptors || []).filter((d: { kind: string }) => d?.kind === 'tool').map((d: { payload: unknown }) => d.payload))
        .filter(Boolean) as ToolInstance[];

      fmt.ok(`Loaded ${allTools.length} tools from ${packs.length} extensions`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fmt.warning(`Extension loading failed, using empty toolset: ${msg}`);
    }
  }

  const toolMap = new Map<string, ToolInstance>();
  for (const tool of allTools) {
    if (!tool?.name) continue;
    toolMap.set(tool.name, tool);
  }
  // Schema-on-demand meta tools (always available; policy-filtered below).
  for (const meta of createSchemaOnDemandTools({
    toolMap,
    runtimeDefaults: {
      workingDirectory: process.cwd(),
      headlessBrowser: true,
      dangerouslySkipCommandSafety,
      agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
    },
    initialEnabledPackages: preloadedPackages,
    allowPackages: true,
    logger: console,
  })) {
    toolMap.set(meta.name, meta);
  }

  const ragTools = createConfiguredRagTools(cfg ?? {});
  for (const ragTool of ragTools) {
    if (!ragTool?.name) continue;
    toolMap.set(ragTool.name, toToolInstance(ragTool as any));
  }

  // Fallback: if no HTTP RAG backend configured, create a local vector store memory_read tool
  if (ragTools.length === 0 && ctx.agentStorageManager) {
    const openaiKey = process.env['OPENAI_API_KEY'];
    if (openaiKey) {
      try {
        const vectorStore = ctx.agentStorageManager.getVectorStore();
        const localMemoryTool = createLocalMemoryReadTool({
          vectorStore,
          openaiApiKey: openaiKey,
          embeddingModel: cfg?.discovery?.embeddingModel || 'text-embedding-3-small',
        });
        toolMap.set(localMemoryTool.name, toToolInstance(localMemoryTool as any));
        fmt.ok('Local memory_read tool enabled (SqlVectorStore)');
      } catch {
        // Storage not ready — skip silently
      }
    }
  }

  // Enforce tool access profile + permission set so the model only sees allowed tools.
  const filtered = filterToolMapByPolicy({
    toolMap,
    toolAccessProfile: policy.toolAccessProfile,
    permissions,
  });
  toolMap.clear();
  for (const [k, v] of filtered.toolMap.entries()) toolMap.set(k, v);

  // ── Agent wallet extension (opt-in via agent.config.json wallet.enabled) ──
  if (cfg?.wallet?.enabled) {
    try {
      const { createExtensionPack: createWalletPack } = await import(
        '@framers/agentos-ext-wallet' as string
      );
      const walletPack = createWalletPack({
        options: cfg.wallet,
        secrets: cfg.secrets,
        getSecret: (k: string) => process.env[k],
        logger: { info: (m: string) => console.log(`[Server] ${m}`) },
      });
      for (const desc of walletPack.descriptors) {
        if (desc.kind === 'tool' && desc.payload) {
          const t = desc.payload as any;
          toolMap.set(t.name, t);
        }
      }
      await walletPack.onActivate?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Server] Wallet extension failed to load: ${msg}`);
    }
  }

  // ── Runtime folder access request tool ──
  if (!ctx.dangerouslySkipPermissions) {
    // Extract ShellService from a CLI executor tool so we can propagate folder grants
    const cliTool = toolMap.get('list_directory') || toolMap.get('file_read') || toolMap.get('file_write');
    const cliShellService: any = cliTool ? (cliTool as any).shellService : undefined;

    const folderAccessTool = createRequestFolderAccessTool({
      guardrails: getGuardrailsInstance(),
      agentId: ctx.seedId ?? workspaceAgentId,
      onFolderGranted: (resolvedPath, operation) => {
        if (cliShellService && typeof cliShellService.addReadRoot === 'function') {
          cliShellService.addReadRoot(resolvedPath);
          if (operation === 'write' && typeof cliShellService.addWriteRoot === 'function') {
            cliShellService.addWriteRoot(resolvedPath);
          }
        }
      },
      requestPermission: async (req) => {
        const actionId = `folder-access-${randomUUID()}`;
        const decision = await hitlManager.requestApproval({
          actionId,
          description: `Grant ${req.operation.toUpperCase()} access to ${req.path}${req.recursive ? '/**' : ''}?\nReason: ${req.reason}`,
          severity: req.operation === 'write' ? 'high' : 'medium',
          category: 'folder-permission',
          agentId: ctx.seedId ?? workspaceAgentId,
          context: { path: req.path, operation: req.operation, reason: req.reason },
          reversible: true,
          requestedAt: new Date(),
          timeoutMs: 5 * 60_000,
        } as any);
        return (decision as any)?.approved === true;
      },
    });
    toolMap.set('request_folder_access', folderAccessTool as any);
  }

  ctx.toolMap = toolMap;
  ctx.activePacks = activePacks;
  ctx.loadedChannelAdapters = loadedChannelAdapters;
  ctx.loadedHttpHandlers = loadedHttpHandlers;
  ctx.hitlSecret = hitlSecret;
  ctx.chatSecret = chatSecret;
  ctx.feedSecret = feedSecret;
  ctx.sseClients = sseClients;
  ctx.broadcastHitlUpdate = broadcastHitlUpdate;
  ctx.hitlManager = hitlManager;
  ctx.startupLines = startupLines;
  ctx.origLog = origLog;
  ctx.origInfo = origInfo;
  ctx.origWarn = origWarn;
}
