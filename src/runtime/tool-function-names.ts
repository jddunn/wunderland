/**
 * @fileoverview Tool function-name normalization and lookup helpers.
 * @module wunderland/runtime/tool-function-names
 */

export const OPENAI_TOOL_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_FALLBACK_NAME = 'tool';

type ToolLike = {
  name: string;
};

export type ToolNameRewriteReason = 'invalid_pattern' | 'empty' | 'collision';

export interface ToolNameRewrite {
  toolMapKey: string;
  sourceName: string;
  rewrittenName: string;
  reason: ToolNameRewriteReason;
}

export interface ToolFunctionNameMapping {
  functionNameByToolKey: Map<string, string>;
  toolKeyByFunctionName: Map<string, string>;
  aliasToolKeyByName: Map<string, string>;
  rewrites: ToolNameRewrite[];
}

export interface SanitizedToolDefsResult {
  toolDefs: Array<Record<string, unknown>>;
  rewrites: Array<{
    originalName: string;
    sanitizedName: string;
    reason: 'invalid_pattern' | 'collision';
  }>;
  aliasBySanitizedName: Map<string, string>;
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) return false;
  return undefined;
}

export function resolveStrictToolNames(raw: unknown, envValue = process.env['WUNDERLAND_STRICT_TOOL_NAMES']): boolean {
  const explicit = parseBoolean(raw);
  if (typeof explicit === 'boolean') return explicit;
  return parseBoolean(envValue) === true;
}

export function isValidToolFunctionName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && OPENAI_TOOL_FUNCTION_NAME_PATTERN.test(value);
}

export function trySanitizeToolFunctionName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const replaced = trimmed
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');

  if (!replaced) return null;
  if (!OPENAI_TOOL_FUNCTION_NAME_PATTERN.test(replaced)) return null;
  return replaced;
}

export function sanitizeToolFunctionName(value: unknown, fallback = DEFAULT_FALLBACK_NAME): string {
  const sanitized = trySanitizeToolFunctionName(value);
  if (sanitized) return sanitized;
  const fallbackSanitized = trySanitizeToolFunctionName(fallback);
  return fallbackSanitized || DEFAULT_FALLBACK_NAME;
}

function dedupeToolFunctionName(baseName: string, used: Set<string>): string {
  if (!used.has(baseName)) return baseName;

  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${baseName}_${i}`;
    if (!used.has(candidate) && OPENAI_TOOL_FUNCTION_NAME_PATTERN.test(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to derive unique tool function name from "${baseName}".`);
}

function collectAliasBuckets(toolMap: Map<string, ToolLike>, mapping: ToolFunctionNameMapping): Map<string, Set<string>> {
  const buckets = new Map<string, Set<string>>();
  const add = (alias: unknown, key: string) => {
    if (typeof alias !== 'string') return;
    const trimmed = alias.trim();
    if (!trimmed) return;
    const existing = buckets.get(trimmed);
    if (existing) {
      existing.add(key);
      return;
    }
    buckets.set(trimmed, new Set([key]));
  };

  for (const [toolMapKey, tool] of toolMap.entries()) {
    add(toolMapKey, toolMapKey);
    add(tool.name, toolMapKey);

    const canonical = mapping.functionNameByToolKey.get(toolMapKey);
    if (canonical) add(canonical, toolMapKey);

    const keySanitized = trySanitizeToolFunctionName(toolMapKey);
    if (keySanitized) add(keySanitized, toolMapKey);

    const displaySanitized = trySanitizeToolFunctionName(tool.name);
    if (displaySanitized) add(displaySanitized, toolMapKey);
  }

  return buckets;
}

export function buildToolFunctionNameMapping(toolMap: Map<string, ToolLike>): ToolFunctionNameMapping {
  const functionNameByToolKey = new Map<string, string>();
  const toolKeyByFunctionName = new Map<string, string>();
  const rewrites: ToolNameRewrite[] = [];

  const used = new Set<string>();
  const sortedEntries = [...toolMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [toolMapKey] of sortedEntries) {
    const sourceName = toolMapKey;
    const sanitized = sanitizeToolFunctionName(sourceName);
    let functionName = sanitized;

    if (!sourceName.trim()) {
      rewrites.push({
        toolMapKey,
        sourceName,
        rewrittenName: functionName,
        reason: 'empty',
      });
    } else if (!isValidToolFunctionName(sourceName)) {
      rewrites.push({
        toolMapKey,
        sourceName,
        rewrittenName: functionName,
        reason: 'invalid_pattern',
      });
    }

    if (used.has(functionName)) {
      const deduped = dedupeToolFunctionName(functionName, used);
      rewrites.push({
        toolMapKey,
        sourceName,
        rewrittenName: deduped,
        reason: 'collision',
      });
      functionName = deduped;
    }

    used.add(functionName);
    functionNameByToolKey.set(toolMapKey, functionName);
    toolKeyByFunctionName.set(functionName, toolMapKey);
  }

  const aliasBuckets = collectAliasBuckets(toolMap, {
    functionNameByToolKey,
    toolKeyByFunctionName,
    aliasToolKeyByName: new Map(),
    rewrites,
  });

  const aliasToolKeyByName = new Map<string, string>();
  for (const [alias, bucket] of aliasBuckets.entries()) {
    if (bucket.size !== 1) continue;
    const only = [...bucket][0];
    if (!only) continue;
    aliasToolKeyByName.set(alias, only);
  }

  return {
    functionNameByToolKey,
    toolKeyByFunctionName,
    aliasToolKeyByName,
    rewrites,
  };
}

export function buildToolDefsFromMapping<TTool extends { name: string; description: string; inputSchema: Record<string, unknown> }>(
  toolMap: Map<string, TTool>,
  mapping: ToolFunctionNameMapping,
): Array<Record<string, unknown>> {
  const entries = [...mapping.toolKeyByFunctionName.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const defs: Array<Record<string, unknown>> = [];

  for (const [functionName, toolMapKey] of entries) {
    const tool = toolMap.get(toolMapKey);
    if (!tool) continue;
    defs.push({
      type: 'function',
      function: {
        name: functionName,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    });
  }

  return defs;
}

export function sanitizeToolDefsForProvider(
  rawDefs: Array<Record<string, unknown>>,
): SanitizedToolDefsResult {
  const usedNames = new Set<string>();
  const aliasBySanitizedName = new Map<string, string>();
  const rewrites: SanitizedToolDefsResult['rewrites'] = [];
  const toolDefs: Array<Record<string, unknown>> = [];

  for (const def of rawDefs) {
    if (!def || typeof def !== 'object') continue;

    const fn = (def as any).function;
    if (!fn || typeof fn !== 'object') continue;

    const originalName = typeof fn.name === 'string' ? fn.name : '';
    if (!originalName.trim()) continue;

    let sanitizedName = originalName;
    if (!isValidToolFunctionName(originalName)) {
      sanitizedName = sanitizeToolFunctionName(originalName);
      rewrites.push({
        originalName,
        sanitizedName,
        reason: 'invalid_pattern',
      });
    }

    if (usedNames.has(sanitizedName)) {
      const deduped = dedupeToolFunctionName(sanitizedName, usedNames);
      rewrites.push({
        originalName,
        sanitizedName: deduped,
        reason: 'collision',
      });
      sanitizedName = deduped;
    }

    usedNames.add(sanitizedName);
    aliasBySanitizedName.set(sanitizedName, originalName);

    toolDefs.push({
      ...def,
      type: 'function',
      function: {
        ...fn,
        name: sanitizedName,
      },
    });
  }

  return { toolDefs, rewrites, aliasBySanitizedName };
}

export function resolveToolMapKeyFromFunctionName(opts: {
  functionName: string;
  toolMap: Map<string, ToolLike>;
  mapping: ToolFunctionNameMapping;
  sanitizedAliasByName?: Map<string, string>;
}): string | null {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    candidates.add(trimmed);
  };

  add(opts.functionName);

  const roundAlias = opts.sanitizedAliasByName?.get(opts.functionName);
  add(roundAlias);

  add(opts.mapping.toolKeyByFunctionName.get(opts.functionName));
  add(opts.mapping.aliasToolKeyByName.get(opts.functionName));

  const normalized = trySanitizeToolFunctionName(opts.functionName);
  if (normalized) {
    add(normalized);
    add(opts.mapping.toolKeyByFunctionName.get(normalized));
    add(opts.mapping.aliasToolKeyByName.get(normalized));
    const normalizedRoundAlias = opts.sanitizedAliasByName?.get(normalized);
    add(normalizedRoundAlias);
  }

  for (const candidate of candidates) {
    if (opts.toolMap.has(candidate)) return candidate;

    const mapped = opts.mapping.aliasToolKeyByName.get(candidate)
      ?? opts.mapping.toolKeyByFunctionName.get(candidate);
    if (mapped && opts.toolMap.has(mapped)) return mapped;
  }

  return null;
}

export function formatToolNameRewriteSummary(
  rewrites: ReadonlyArray<{ sourceName: string; rewrittenName: string; reason: string }>,
  maxItems = 8,
): string {
  if (!rewrites.length) return '';
  const shown = rewrites.slice(0, maxItems);
  const lines = shown.map((r) => `"${r.sourceName}" -> "${r.rewrittenName}" (${r.reason})`);
  if (rewrites.length > shown.length) {
    lines.push(`... +${rewrites.length - shown.length} more`);
  }
  return lines.join('; ');
}
