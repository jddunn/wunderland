import { describe, expect, it } from 'vitest';

import type { ToolInstance } from '../cli/openai/tool-calling.js';
import { createSchemaOnDemandTools } from '../cli/openai/schema-on-demand.js';

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
    expect(result.success).toBe(true);
    expect(toolMap.has('generate_image')).toBe(true);
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
});
