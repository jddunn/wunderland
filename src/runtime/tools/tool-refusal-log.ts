/**
 * @fileoverview The log line a `tools.allow` refusal writes.
 *
 * Each call refused at dispatch and each pack `extensions_enable` refuses writes
 * one warn line through AgentOS's logger, whose default root is pino writing JSON
 * lines to standard output, so a host reads refusals from its process log with
 * OTEL off:
 *
 * ```json
 * {"level":40,"name":"agentos","component":"wunderland.tools","tool":"shell_execute","msg":"tool_not_allowed"}
 * ```
 *
 * The line holds the word, the tool or pack name and how many lines the burst
 * bound left out, and never the call's arguments. The names come from the model,
 * so a name that is not shaped like one is written as `invalid`.
 *
 * @module wunderland/runtime/tools/tool-refusal-log
 */
import { createLogger } from '@framers/agentos';

import { TOOL_NOT_ALLOWED } from './tool-allow-list.js';

/** How long one burst window lasts. */
const WINDOW_MS = 60_000;
/** The most lines one name writes in a window. */
const MAX_LINES_PER_NAME = 5;
/** The most lines all names write in a window; a model can make up names without end. */
const MAX_LINES_PER_WINDOW = 50;
/** The longest name written; npm allows 214 characters and no curated pack comes near. */
const MAX_NAME_LENGTH = 128;
/** A tool or pack name, including an npm package name such as `@framers/agentos-ext-web-search`. */
const NAME_SHAPE = /^[A-Za-z0-9@/_.:-]+$/;
/** What the line says for a name that is not shaped like one. */
const INVALID_NAME = 'invalid';

/** One refusal: a tool call refused at dispatch, or a pack `extensions_enable` refused. */
export interface ToolRefusal {
  /** `tool` for a call refused at dispatch, `pack` for a refused `extensions_enable`. */
  kind: 'tool' | 'pack';
  /** The tool or pack name as requested. */
  name: string;
}

let windowStart = 0;
let linesInWindow = 0;
let linesPerName = new Map<string, number>();
let suppressed = 0;

/**
 * Writes the line for one refusal, unless the burst bound leaves it out: at most
 * {@link MAX_LINES_PER_NAME} lines a name and {@link MAX_LINES_PER_WINDOW} lines
 * in all each minute. The first line of a later window carries `suppressed`, the
 * number left out before it.
 *
 * @param refusal - What was refused.
 */
export function logToolRefusal(refusal: ToolRefusal): void {
  const now = Date.now();
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    linesInWindow = 0;
    linesPerName = new Map();
  }

  const name =
    refusal.name.length <= MAX_NAME_LENGTH && NAME_SHAPE.test(refusal.name) ? refusal.name : INVALID_NAME;
  const key = `${refusal.kind}:${name}`;
  const linesForName = linesPerName.get(key) ?? 0;
  if (linesForName >= MAX_LINES_PER_NAME || linesInWindow >= MAX_LINES_PER_WINDOW) {
    suppressed += 1;
    return;
  }
  linesPerName.set(key, linesForName + 1);
  linesInWindow += 1;

  const fields: Record<string, unknown> = { [refusal.kind]: name };
  if (suppressed > 0) {
    fields.suppressed = suppressed;
    suppressed = 0;
  }
  createLogger('wunderland.tools').warn(TOOL_NOT_ALLOWED, fields);
}

/** Forgets the current burst window. For tests. */
export function resetToolRefusalLog(): void {
  windowStart = 0;
  linesInWindow = 0;
  linesPerName = new Map();
  suppressed = 0;
}
