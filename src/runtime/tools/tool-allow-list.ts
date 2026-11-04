/**
 * @fileoverview The `tools.allow` list of an agent config: the extension packs
 * `wunderland start` may load and the tools it may offer the model and run.
 *
 * ```json
 * { "tools": { "allow": { "packs": ["web-search"], "tools": ["web_search"] } } }
 * ```
 *
 * With no `tools.allow`, nothing here applies and `start` behaves as before.
 * With one, the list is a ceiling over every other setting: the permission set,
 * the tool access profile and the execution mode can only narrow it.
 *
 * @module wunderland/runtime/tools/tool-allow-list
 */

import { normalizeExtensionName } from '../../cli/extensions/aliases.js';

/** The error a refused tool call or pack load answers with. */
export const TOOL_NOT_ALLOWED = 'tool_not_allowed';

/** A resolved `tools.allow`: curated pack names and tool names, each list without duplicates. */
export interface ToolAllowList {
  /** Curated extension pack names (`web-search`), with aliases resolved. */
  readonly packs: readonly string[];
  /** Tool names as the packs register them (`web_search`). */
  readonly tools: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The names `value` lists, trimmed and without duplicates. Anything but an
 * array of non-empty strings gives none: one entry that is not a name (a
 * number, `null`, an empty string) voids the whole list, so a mistake in it
 * never grants the entries beside it.
 */
function namesOf(value: unknown, normalize: (name: string) => string = (name) => name): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return [];
    const name = normalize(entry.trim());
    if (name.length === 0) return [];
    names.push(name);
  }
  return [...new Set(names)];
}

/**
 * Reads `tools.allow` from an agent config.
 *
 * Returns `undefined` when the config has no `tools.allow` (no restriction).
 * When it has one, the restriction holds even if the value is malformed: a
 * `packs` or `tools` that is not an array of names, or holds any entry that
 * is not a non-empty name, allows none, so a mistake in the list never widens
 * it.
 *
 * @param agentConfig - The agent config `start` runs with (`agent.config.json`).
 */
export function resolveToolAllowList(agentConfig: unknown): ToolAllowList | undefined {
  if (!isPlainObject(agentConfig)) return undefined;
  const tools = agentConfig['tools'];
  if (!isPlainObject(tools) || !('allow' in tools)) return undefined;
  const allow = tools['allow'];
  if (allow === undefined) return undefined;
  if (!isPlainObject(allow)) return { packs: [], tools: [] };
  return {
    packs: namesOf(allow['packs'], normalizeExtensionName),
    tools: namesOf(allow['tools']),
  };
}

/**
 * Drops every tool whose name is not in `allowedToolNames` from `toolMap`, in
 * place, and returns the names it dropped (sorted).
 *
 * @param toolMap - The tool map to confine.
 * @param allowedToolNames - The tool names the list allows.
 */
export function confineToolMap<T>(
  toolMap: Map<string, T>,
  allowedToolNames: Iterable<string>,
): string[] {
  const allowed = new Set<string>(allowedToolNames);
  const dropped: string[] = [];
  for (const name of [...toolMap.keys()]) {
    if (!allowed.has(name)) {
      toolMap.delete(name);
      dropped.push(name);
    }
  }
  return dropped.sort();
}

/**
 * The tool names a turn of this agent may offer and run, for
 * `runToolCallingTurn`'s `allowedToolNames`: `tools.allow.tools`, or
 * `undefined` when the config has no `tools.allow`.
 *
 * @param agentConfig - The agent config `start` runs with.
 */
export function allowedToolNamesFor(agentConfig: unknown): readonly string[] | undefined {
  return resolveToolAllowList(agentConfig)?.tools;
}
