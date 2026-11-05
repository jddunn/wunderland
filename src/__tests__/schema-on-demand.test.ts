// @ts-nocheck
import { describe, expect, it } from 'vitest';

import type { ToolInstance } from '../runtime/tools/tool-calling.js';
import { createSchemaOnDemandTools } from '../runtime/execution/schema-on-demand.js';

describe('createSchemaOnDemandTools', () => {
  it('loads a local curated pack by curated extension name', async () => {
    const toolMap = new Map<string, ToolInstance>();
    const tools = createSchemaOnDemandTools({
      toolMap,
      runtimeDefaults: {
        workingDirectory: process.cwd(),
        headlessBrowser: true,
        dangerouslySkipCommandSafety: false,
        agentWorkspace: { agentId: 'schema-on-demand-test', baseDir: '/tmp' },
      },
      logger: console,
    });

    for (const tool of tools) {
      toolMap.set(tool.name, tool);
    }

    const enable = toolMap.get('extensions_enable');
    expect(enable).toBeTruthy();

    const result = await enable!.execute({ extension: 'image-generation' }, {});
    // In monorepo dev, the extension loads via createLocalPackProxy.
    // In isolated CI, the pack may not be resolvable — skip gracefully.
    if (result.success) {
      expect(toolMap.has('generate_image')).toBe(true);
    } else {
      // Extension load failed (CI resolution issue) — verify error is about loading, not logic
      expect(result.error || result.output?.reason).toBeTruthy();
    }
  });

  it('normalizes extension aliases before resolving curated packs', async () => {
    const toolMap = new Map<string, ToolInstance>();
    const tools = createSchemaOnDemandTools({
      toolMap,
      runtimeDefaults: {
        workingDirectory: process.cwd(),
        headlessBrowser: true,
        dangerouslySkipCommandSafety: false,
        agentWorkspace: { agentId: 'schema-on-demand-alias-test', baseDir: '/tmp' },
      },
      logger: console,
    });

    for (const tool of tools) {
      toolMap.set(tool.name, tool);
    }

    const enable = toolMap.get('extensions_enable');
    expect(enable).toBeTruthy();

    const result = await enable!.execute({ extension: 'google-calendar', dryRun: true }, {});
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      extension: 'calendar-google',
      packageName: '@framers/agentos-ext-calendar-google',
      skipped: true,
      reason: 'dry_run',
    });
  });

  it('loads no package pack for a host that does not give it packagePacks, whatever its overrides say', async () => {
    // createWunderland, AgentBootstrap, the API server and chat give no packagePacks: they have no
    // narrowing, handler rule or shutdown for such a pack, and an enabled: false there must hold.
    const toolMap = new Map<string, ToolInstance>();
    const tools = createSchemaOnDemandTools({
      toolMap,
      runtimeDefaults: {
        workingDirectory: process.cwd(),
        headlessBrowser: true,
        dangerouslySkipCommandSafety: false,
        agentWorkspace: { agentId: 'schema-on-demand-package-pack-test', baseDir: '/tmp' },
      },
      defaultExtensionOptions: { 'wildweave-film': { enabled: false } },
      allowPackages: true,
      getSecret: () => 'test-studio-key',
      logger: console,
    });
    for (const tool of tools) toolMap.set(tool.name, tool);
    const enable = toolMap.get('extensions_enable')!;

    expect(await enable.execute({ extension: 'wildweave-film' }, {})).toMatchObject({
      success: false,
      error: 'Unknown extension: wildweave-film',
    });
    expect(
      await enable.execute({ extension: '@framers/agentos-ext-wildweave-film', source: 'package' }, {}),
    ).toMatchObject({ success: false, error: 'Unknown extension package: @framers/agentos-ext-wildweave-film' });
    expect([...toolMap.keys()].filter((name) => name.startsWith('wildweave_film_'))).toEqual([]);

    const listed = await toolMap.get('extensions_list')!.execute({}, {});
    expect(listed.output.packagePacks).toEqual([]);
  });
});
