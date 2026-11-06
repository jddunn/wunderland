import { describe, expect, it } from 'vitest';

import type { ToolInstance } from '../../tools/tool-calling.js';
import { createSchemaOnDemandTools } from '../schema-on-demand.js';

describe('extensions_enable and the package packs', () => {
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
    expect((listed.output as { packagePacks: unknown[] }).packagePacks).toEqual([]);
  });
});
