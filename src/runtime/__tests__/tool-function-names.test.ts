// @ts-nocheck
import { describe, expect, it } from 'vitest';

import { buildToolDefs, type ToolInstance } from '../tool-calling.js';
import {
  buildToolFunctionNameMapping,
  resolveToolMapKeyFromFunctionName,
  sanitizeToolDefsForProvider,
  sanitizeToolFunctionName,
  trySanitizeToolFunctionName,
} from '../tool-function-names.js';

function makeTool(name: string): ToolInstance {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    execute: async () => ({ success: true, output: { ok: true } }),
  };
}

describe('tool-function-names', () => {
  it('sanitizes non-compliant names', () => {
    expect(sanitizeToolFunctionName('Social Post')).toBe('Social_Post');
    expect(trySanitizeToolFunctionName('***')).toBeNull();
    expect(sanitizeToolFunctionName('***')).toBe('tool');
  });

  it('buildToolDefs uses tool map keys for canonical function names', () => {
    const toolMap = new Map<string, ToolInstance>([
      ['social_post', makeTool('Social Post')],
      ['news_search', makeTool('News Search')],
    ]);

    const defs = buildToolDefs(toolMap);
    const names = defs.map((d: any) => d?.function?.name).filter(Boolean).sort();

    expect(names).toEqual(['news_search', 'social_post']);
  });

  it('throws in strict mode when tool map keys need rewriting', () => {
    const toolMap = new Map<string, ToolInstance>([
      ['Social Post', makeTool('Social Post')],
    ]);

    expect(() => buildToolDefs(toolMap, { strictToolNames: true })).toThrow(
      /Invalid tool function names detected while strict mode is enabled/i,
    );
  });

  it('resolves sanitized function names back to map keys via alias mapping', () => {
    const toolMap = new Map<string, ToolInstance>([
      ['social_post', makeTool('Social Post')],
    ]);
    const mapping = buildToolFunctionNameMapping(toolMap);

    const outbound = sanitizeToolDefsForProvider([
      {
        type: 'function',
        function: {
          name: 'Social Post',
          description: 'post socially',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);

    expect(outbound.toolDefs[0]).toMatchObject({ function: { name: 'Social_Post' } });

    const resolved = resolveToolMapKeyFromFunctionName({
      functionName: 'Social_Post',
      toolMap,
      mapping,
      sanitizedAliasByName: outbound.aliasBySanitizedName,
    });

    expect(resolved).toBe('social_post');
  });
});
