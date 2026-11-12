import { describe, expect, it } from 'vitest';

import type { ToolInstance } from '../../tools/tool-calling.js';
import { createSchemaOnDemandTools } from '../schema-on-demand.js';

describe('extensions_enable and the package packs', () => {
  it.each([undefined, {}])('lists no bundled package packs and refuses unknown names with host %j', async (packagePacks) => {
    // Cover both start (a package-pack host) and hosts without package-pack support.
    const toolMap = new Map<string, ToolInstance>();
    const tools = createSchemaOnDemandTools({
      toolMap,
      packagePacks,
      runtimeDefaults: {
        workingDirectory: process.cwd(),
        headlessBrowser: true,
        dangerouslySkipCommandSafety: false,
        agentWorkspace: { agentId: 'schema-on-demand-package-pack-test', baseDir: '/tmp' },
      },
      defaultExtensionOptions: { 'unknown-pack': { enabled: false } },
      allowPackages: true,
      getSecret: () => 'test-key',
      logger: console,
    });
    for (const tool of tools) toolMap.set(tool.name, tool);
    const enable = toolMap.get('extensions_enable')!;

    expect(await enable.execute({ extension: 'unknown-pack' }, {})).toMatchObject({
      success: false,
      error: 'Unknown extension: unknown-pack',
    });
    expect(
      await enable.execute({ extension: '@example/unknown-pack', source: 'package' }, {}),
    ).toMatchObject({ success: false, error: 'Unknown extension package: @example/unknown-pack' });
    expect([...toolMap.keys()]).toEqual(tools.map((tool) => tool.name));

    const listed = await toolMap.get('extensions_list')!.execute({}, {});
    expect((listed.output as { packagePacks: unknown[] }).packagePacks).toEqual([]);
  });
});
