// @ts-nocheck
/** Startup and lazy loading through the real bundled web-search pack. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as webSearchPack from '@framers/agentos-ext-web-search';

import { loadExtensions } from '../extension-loader.js';
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';

const LOAD_TIMEOUT_MS = 120_000;
const SEARCH_TOOLS = ['fact_check', 'research_aggregate', 'web_search'];
let workspaceBaseDir = '';

/** Run start's extension phase, with optional lazy loading and config overrides. */
async function loadWebSearch(
  extra: Record<string, unknown> = {},
  { lazyTools = false }: { lazyTools?: boolean } = {},
): Promise<any> {
  const cfg = {
    seedId: 'bundled_pack_test',
    permissionSet: 'unrestricted',
    toolAccessProfile: 'unrestricted',
    executionMode: 'autonomous',
    extensions: { tools: ['web-search'], voice: [], productivity: [] },
    ...extra,
  };
  const policy = normalizeRuntimePolicy(cfg);
  const ctx: any = {
    cfg,
    globalConfig: {},
    policy,
    permissions: getPermissionsForSet(policy.permissionSet),
    dangerouslySkipCommandSafety: false,
    workspaceAgentId: cfg.seedId,
    workspaceBaseDir,
    lazyTools,
    LOCAL_ONLY_CHANNELS: new Set(['webchat']),
    CLI_REQUIRED_CHANNELS: new Set(['signal', 'zalouser']),
  };
  const log = console.log;
  const info = console.info;
  const warn = console.warn;
  try {
    await loadExtensions(ctx);
  } finally {
    // loadExtensions captures the console for the startup panel; put it back.
    console.log = log;
    console.info = info;
    console.warn = warn;
  }
  return ctx;
}

beforeEach(async () => {
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-bundled-pack-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

/** Release packs activated during startup. */
async function deactivateAll(ctx: any): Promise<void> {
  await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.()));
}

describe('wunderland start with a bundled pack', () => {
  it('loads the configured pack and keeps only the allowed tools', async () => {
    const ctx = await loadWebSearch({
      tools: { allow: { packs: ['web-search'], tools: ['web_search'] } },
    });
    try {
      expect(ctx.activePacks.map((pack: any) => pack.name)).toEqual(['@framers/agentos-ext-web-search']);
      expect([...ctx.toolMap.keys()]).toEqual(['web_search']);
      const tool = ctx.toolMap.get('web_search');
      expect(typeof tool.execute).toBe('function');
      expect(tool.inputSchema.type).toBe('object');
    } finally {
      await deactivateAll(ctx);
    }
  }, LOAD_TIMEOUT_MS);

  it.each([
    { extension: 'web-search' },
    { extension: '@framers/agentos-ext-web-search', source: 'package' },
  ])('loads on demand with %j and skips a second enable', async (args) => {
    const ctx = await loadWebSearch({}, { lazyTools: true });
    const packs: any[] = [];
    const activations: ReturnType<typeof vi.spyOn>[] = [];
    const activationCount = () => activations.reduce((count, hook) => count + hook.mock.calls.length, 0);
    try {
      // Curated lazy loads do not enter ctx.activePacks; observe their real activation hooks.
      const createPack = webSearchPack.createExtensionPack;
      vi.spyOn(webSearchPack, 'createExtensionPack').mockImplementation((...factoryArgs) => {
        const pack = createPack(...factoryArgs);
        packs.push(pack);
        activations.push(vi.spyOn(pack, 'onActivate'));
        return pack;
      });
      for (const name of SEARCH_TOOLS) expect(ctx.toolMap.has(name)).toBe(false);
      const enable = ctx.toolMap.get('extensions_enable');
      const result = await enable.execute(args, {});
      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ packageName: '@framers/agentos-ext-web-search', loaded: true });
      expect(result.output.toolsAdded).toEqual(expect.arrayContaining(SEARCH_TOOLS));
      for (const name of SEARCH_TOOLS) expect(ctx.toolMap.has(name)).toBe(true);
      const activationsBeforeSecondEnable = activationCount();
      expect(activationsBeforeSecondEnable).toBe(1);
      expect((await enable.execute(args, {})).output).toMatchObject({ skipped: true, reason: 'already_loaded' });
      expect(activationCount()).toBe(activationsBeforeSecondEnable);
    } finally {
      await Promise.allSettled(packs.map((pack) => pack.onDeactivate?.({ logger: console })));
      await deactivateAll(ctx);
    }
  }, LOAD_TIMEOUT_MS);

  it('refuses lazy loading of packs outside tools.allow', async () => {
    const ctx = await loadWebSearch({
      tools: { allow: { packs: ['web-search'], tools: ['extensions_enable', ...SEARCH_TOOLS] } },
    }, { lazyTools: true });
    try {
      const enable = ctx.toolMap.get('extensions_enable');
      expect(ctx.toolMap.has('web_search')).toBe(false);
      const result = await enable.execute({ extension: 'web-search' }, {});
      expect(result.success).toBe(true);
      expect([...ctx.toolMap.keys()].sort()).toEqual(['extensions_enable', ...SEARCH_TOOLS]);
      expect(await enable.execute({ extension: 'cli-executor' }, {})).toMatchObject({ success: false, error: 'tool_not_allowed' });
      expect(await enable.execute({ extension: '@framers/agentos-ext-cli-executor', source: 'package' }, {}))
        .toMatchObject({ success: false, error: 'tool_not_allowed' });
    } finally {
      await deactivateAll(ctx);
    }
  }, LOAD_TIMEOUT_MS);
});
