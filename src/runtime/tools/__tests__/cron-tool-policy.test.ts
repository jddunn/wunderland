import { describe, it, expect } from 'vitest';
import { filterToolMapByPolicy, getPermissionsForSet } from '../policy.js';
import type { ToolInstance } from '../tool-calling.js';

function schedulingTool(): ToolInstance {
  return {
    name: 'cron_manage',
    description: 'Manage scheduled jobs',
    category: 'scheduling',
    hasSideEffects: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({}),
  } as unknown as ToolInstance;
}

function filterUnder(profile: string) {
  const toolMap = new Map<string, ToolInstance>([['cron_manage', schedulingTool()]]);
  return filterToolMapByPolicy({
    toolMap,
    toolAccessProfile: profile,
    permissions: getPermissionsForSet('supervised'),
  } as never);
}

describe('cron_manage survives the default tool policy (finding #2)', () => {
  it('the assistant (default) profile keeps cron_manage', () => {
    const { toolMap } = filterUnder('assistant');
    expect(toolMap.has('cron_manage')).toBe(true);
  });

  it('developer and unrestricted keep it too', () => {
    expect(filterUnder('developer').toolMap.has('cron_manage')).toBe(true);
    expect(filterUnder('unrestricted').toolMap.has('cron_manage')).toBe(true);
  });

  it('a read-only social-observer profile drops it', () => {
    const { toolMap, dropped } = filterUnder('social-observer');
    expect(toolMap.has('cron_manage')).toBe(false);
    expect(dropped.some((d) => d.tool === 'cron_manage')).toBe(true);
  });
});
