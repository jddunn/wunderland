/**
 * @fileoverview The remote approval handler of `wunderland start`.
 *
 * With `hitl.mode: "remote"` in the agent config, an outward tool asks a server
 * before it runs: `POST <url>/approvals` makes the request, `GET
 * <url>/approvals/:id` reads the answer, on the URL and the token of
 * `WUNDERLAND_EVENTS_URL` and `WUNDERLAND_EVENTS_TOKEN`. A person's yes on that
 * server runs the tool. A no, an expiry or a lost server ends the turn with the
 * word, and the tool never runs.
 *
 * It fails closed. With either variable missing, every outward tool is refused
 * {@link APPROVAL_UNAVAILABLE}, so an agent that lost its token never acts
 * unasked. Only the literal state `approved` ever counts as a yes.
 *
 * Without `hitl.mode: "remote"` no handler exists and nothing here applies.
 *
 * The action's text reaches the approvals route alone: never a log line, and
 * never the events of `hosted-events.ts`.
 *
 * @module wunderland/cli/commands/start/remote-approvals
 */
import { randomUUID } from 'node:crypto';

import { resolveOperationIdHeader } from '../../../platform/config/operation-id.js';
import { APPROVAL_UNAVAILABLE, safeJsonStringify } from '../../../runtime/tools/tool-helpers.js';
import { EVENTS_TOKEN_ENV, EVENTS_URL_ENV, type ReportedTurn } from './hosted-events.js';

export { APPROVAL_UNAVAILABLE };

/** The `hitl.mode` that chooses this handler. */
export const HITL_MODE_REMOTE = 'remote';

/** How long an outward tool waits for its answer. */
export const REMOTE_APPROVAL_WAIT_MS = 10 * 60_000;
/** How long the handler waits between one poll's answer and the next poll. */
export const REMOTE_APPROVAL_POLL_MS = 5_000;
/** The most characters of a tool's arguments a request carries. */
export const REMOTE_APPROVAL_TEXT_LIMIT = 1_800;

/** How long the request may take before the tool is refused. */
const REQUEST_TIMEOUT_MS = 10_000;
/** How long one poll may take: a server may hold it open until the answer comes. */
const POLL_TIMEOUT_MS = 35_000;
/** At most one warning line per this many milliseconds. */
const WARN_INTERVAL_MS = 60_000;

const SUMMARY_MAX_LENGTH = 200;
const MASK_MAX_DEPTH = 8;
const MASKED = '[REDACTED]';
const SECRET_ARG = /api[-_]?key|token|secret|password|passwd|authorization|credential|cookie/i;

/** Why a tool did not run: the server's word, or {@link APPROVAL_UNAVAILABLE}. */
export type RemoteApprovalWord = 'declined' | 'expired' | 'withdrawn' | typeof APPROVAL_UNAVAILABLE;

/** What a person is asked to approve. */
export interface RemoteApprovalAction {
  /** One line: the tool and, when it names one, its target. */
  summary: string;
  /** The tool's arguments, with secrets masked, up to {@link REMOTE_APPROVAL_TEXT_LIMIT} characters. */
  text: string;
}

/** The body of `POST <url>/approvals`. */
export interface RemoteApprovalRequest {
  toolName: string;
  action: RemoteApprovalAction;
  /** The turn's operation id; it also goes in the header `AGENTOS_OPERATION_ID_HEADER` names. */
  operationId: string;
}

/** The handler's answer: `approve` runs the tool, `abort` ends the turn with the word. */
export type RemoteApprovalDecision =
  | { decision: 'approve'; approved: true }
  | { decision: 'abort'; approved: false; reason: RemoteApprovalWord };

/** Asks the server and waits for its answer. Never rejects. */
export type RemoteApprovalHandler = (
  request: RemoteApprovalRequest,
  hooks?: {
    /** Called once the server holds the request, before the first poll. */
    onWaiting?: () => void;
  },
) => Promise<RemoteApprovalDecision>;

/** Options for {@link createRemoteApprovalHandler}. */
export interface RemoteApprovalHandlerOptions {
  /** The API root, without `/approvals`. */
  url: string;
  /** The bearer token. */
  token: string;
  /** How long to wait for the answer; {@link REMOTE_APPROVAL_WAIT_MS} by default. */
  waitMs?: number;
  /** The pause between polls; {@link REMOTE_APPROVAL_POLL_MS} by default. */
  pollMs?: number;
}

const APPROVE: RemoteApprovalDecision = Object.freeze({ decision: 'approve', approved: true });

function abort(reason: RemoteApprovalWord): RemoteApprovalDecision {
  return { decision: 'abort', approved: false, reason };
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** The server's words that end the wait with no. */
const ABORT_STATES: ReadonlySet<string> = new Set(['declined', 'expired', 'withdrawn']);

/** What a poll may tell: a state word, or that the token or the request is gone. */
const GONE = Symbol('gone');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function readJson(res: FetchResponse): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return undefined;
  }
}

function fieldOf(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

/**
 * Creates the handler for one server.
 *
 * It posts `{ toolName, action, operationId }` to `<url>/approvals` with
 * `Authorization: Bearer <token>`, then reads `{ state }` from `GET
 * <url>/approvals/:id` until the state is `approved`, `declined`, `expired` or
 * `withdrawn`, or `waitMs` has passed since the server took the request. A last
 * poll at the deadline reads a yes that came just before it.
 *
 * A request the server does not take answers {@link APPROVAL_UNAVAILABLE}, and
 * so does a poll answered with any 4xx but 408, 425 or 429: the token or the row
 * is gone. A poll with no answer, a 408, 425, 429 or 5xx, or a state this module
 * does not know keeps waiting.
 *
 * Warnings go to `console.warn`, one line a minute at most, and hold a status or
 * an error's name, never the token and never the action.
 *
 * @param options - The server, the token and the timings.
 * @returns The handler.
 */
export function createRemoteApprovalHandler(options: RemoteApprovalHandlerOptions): RemoteApprovalHandler {
  const endpoint = `${options.url.trim().replace(/\/+$/, '')}/approvals`;
  const token = options.token.trim();
  const waitMs = options.waitMs ?? REMOTE_APPROVAL_WAIT_MS;
  const pollMs = options.pollMs ?? REMOTE_APPROVAL_POLL_MS;

  let lastWarnAt: number | undefined;
  const warn = (line: string): void => {
    const now = Date.now();
    if (lastWarnAt !== undefined && now - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = now;
    console.warn(`[remote-approvals] ${line}`);
  };

  let operationHeader: string | undefined;
  try {
    operationHeader = resolveOperationIdHeader();
  } catch (err) {
    warn(`${err instanceof Error ? err.message : String(err)} Asking without an operation id header.`);
  }

  const headersFor = (operationId: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    ...(operationHeader ? { [operationHeader]: operationId } : {}),
  });

  /** Makes the request. Returns the server's id for it, or nothing when it did not take it. */
  const open = async (request: RemoteApprovalRequest): Promise<string | undefined> => {
    let res: FetchResponse;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headersFor(request.operationId) },
        body: JSON.stringify({
          toolName: request.toolName,
          action: request.action,
          operationId: request.operationId,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      warn(`The approvals server did not answer (${err instanceof Error ? err.name : 'error'}); refusing the tool.`);
      return undefined;
    }
    const body = await readJson(res);
    if (!res.ok) {
      warn(`The approvals server refused the request (${res.status}); refusing the tool.`);
      return undefined;
    }
    const id = fieldOf(body, 'id');
    if (typeof id !== 'string' || id === '') {
      warn('The approvals server took the request and gave no id; refusing the tool.');
      return undefined;
    }
    return id;
  };

  /** Reads the request's state once: its word, {@link GONE}, or nothing to go on. */
  const poll = async (id: string, operationId: string, timeoutMs: number): Promise<unknown> => {
    let res: FetchResponse;
    try {
      res = await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: headersFor(operationId),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      warn(`The approvals server did not answer a poll (${err instanceof Error ? err.name : 'error'}); still waiting.`);
      return undefined;
    }
    const body = await readJson(res);
    if (res.ok) return fieldOf(body, 'state');
    if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
      warn(`The approvals server answered a poll with ${res.status}; still waiting.`);
      return undefined;
    }
    warn(`The approvals server answered a poll with ${res.status}; refusing the tool.`);
    return GONE;
  };

  return async (request, hooks) => {
    const id = await open(request);
    if (id === undefined) return abort(APPROVAL_UNAVAILABLE);
    hooks?.onWaiting?.();

    // Counted from the server's answer, so its own deadline, which starts when
    // it takes the request, comes first and its word is the one that is read.
    const deadline = Date.now() + waitMs;
    for (;;) {
      const timeoutMs = Math.min(POLL_TIMEOUT_MS, Math.max(deadline - Date.now(), pollMs));
      const state = await poll(id, request.operationId, timeoutMs);
      if (state === GONE) return abort(APPROVAL_UNAVAILABLE);
      if (state === 'approved') return APPROVE;
      if (typeof state === 'string' && ABORT_STATES.has(state)) return abort(state as RemoteApprovalWord);

      const left = deadline - Date.now();
      if (left <= 0) return abort('expired');
      await sleep(Math.min(pollMs, left));
    }
  };
}

/** Refuses every request without asking anyone: the handler of an agent with no server to ask. */
const refuseEveryRequest: RemoteApprovalHandler = async () => abort(APPROVAL_UNAVAILABLE);

/**
 * The handler an agent's `hitl.mode` asks for. Any mode but `remote` gets none.
 * `remote` gets a handler on `WUNDERLAND_EVENTS_URL` and
 * `WUNDERLAND_EVENTS_TOKEN`; with either unset, blank or not a URL it gets one
 * that refuses every request, with one warning line.
 *
 * @param mode - `hitl.mode` from the agent config.
 * @param env - The environment to read; `process.env` by default.
 * @returns The handler, or `undefined` when the mode is not `remote`.
 */
export function remoteApprovalHandlerForMode(
  mode: unknown,
  env: Record<string, string | undefined> = process.env,
): RemoteApprovalHandler | undefined {
  if (typeof mode !== 'string' || mode.trim().toLowerCase() !== HITL_MODE_REMOTE) return undefined;
  const url = env[EVENTS_URL_ENV]?.trim();
  const token = env[EVENTS_TOKEN_ENV]?.trim();
  if (!url || !token) {
    console.warn(
      `[remote-approvals] hitl.mode is "remote" and ${EVENTS_URL_ENV} or ${EVENTS_TOKEN_ENV} is not set; every outward tool is refused ${APPROVAL_UNAVAILABLE}.`,
    );
    return refuseEveryRequest;
  }
  try {
    new URL(url);
  } catch {
    console.warn(
      `[remote-approvals] hitl.mode is "remote" and ${EVENTS_URL_ENV} is not a URL; every outward tool is refused ${APPROVAL_UNAVAILABLE}.`,
    );
    return refuseEveryRequest;
  }
  return createRemoteApprovalHandler({ url, token });
}

/** A tool as the marking reads it. */
export interface MarkedTool {
  name?: string;
  category?: string;
  hasSideEffects?: boolean;
}

/** The conversation a turn answers. A turn with none (`POST /chat`, a webhook) has no channel of its own. */
export interface TurnConversation {
  platform: string;
  conversationId: string;
}

/** The categories whose tools with a write verb ask even if they declare no side effects. */
const OUTWARD_CATEGORIES: ReadonlySet<string> = new Set([
  'channel',
  'channels',
  'communication',
  'communications',
  'social',
  'tools',
]);

/** The words in a tool's name that make it an outward action: a send, a post, a publish, a purchase, a bulk send, a webhook. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'send',
  'post',
  'publish',
  'purchase',
  'buy',
  'pay',
  'broadcast',
  'bulk',
  'webhook',
]);

/** A word in a tool's name that, coming first, makes the rest of the name its object: `getPost`. */
const READ_VERBS: ReadonlySet<string> = new Set([
  'get',
  'list',
  'read',
  'search',
  'find',
  'fetch',
  'lookup',
  'query',
  'check',
  'view',
  'show',
  'describe',
  'count',
]);

/** The arguments that name where a tool's action goes, across the channel packs. */
const TARGET_ARGS = [
  'channelId',
  'channel_id',
  'channel',
  'chatId',
  'chat_id',
  'conversationId',
  'conversation_id',
  'roomId',
  'room_id',
  'jid',
  'recipient',
  'recipientId',
  'recipient_id',
  'to',
  'target',
  'targetChannel',
  'target_channel',
] as const;

/** The first read or write verb in a tool's name decides: `sendMessage` writes, `getSendStatus` reads. */
function hasWriteVerb(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const word of words) {
    if (WRITE_VERBS.has(word)) return true;
    if (READ_VERBS.has(word)) return false;
  }
  return false;
}

/** The targets a tool's arguments name, as trimmed strings. */
function targetsOf(args: Record<string, unknown>): string[] {
  const targets: string[] = [];
  for (const key of TARGET_ARGS) {
    const value = args?.[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'number') targets.push(String(item));
      else if (typeof item === 'string' && item.trim()) targets.push(item.trim());
    }
  }
  return targets;
}

/** Whether a tool's arguments aim at a channel other than the turn's own. */
function aimsElsewhere(args: Record<string, unknown>, conversation?: TurnConversation): boolean {
  const platform = args?.['platform'];
  const namesPlatform = typeof platform === 'string' && platform.trim() !== '';
  const targets = targetsOf(args);
  if (!conversation) return namesPlatform || targets.length > 0;
  if (namesPlatform && (platform as string).trim().toLowerCase() !== conversation.platform.toLowerCase()) return true;
  return targets.some((target) => target !== conversation.conversationId);
}

/**
 * Whether a tool call is an outward action that asks first.
 *
 * It is when the tool's name has a write verb and the tool either sits in an
 * outward category or does not declare itself free of side effects; and when a
 * tool that declares side effects aims at a channel other than the
 * conversation's own. A send to the conversation's own channel through a
 * channel tool still asks, by its category and verb: the plain reply of a turn
 * reaches the channel without a tool.
 *
 * @param tool - The tool's name, category and side-effect flag.
 * @param args - The call's arguments.
 * @param conversation - The conversation the turn answers, if it answers one.
 * @returns Whether the call asks.
 */
export function isOutwardAction(
  tool: MarkedTool,
  args: Record<string, unknown>,
  conversation?: TurnConversation,
): boolean {
  if (hasWriteVerb(tool?.name)) {
    const category = typeof tool?.category === 'string' ? tool.category.trim().toLowerCase() : '';
    if (OUTWARD_CATEGORIES.has(category) || tool?.hasSideEffects !== false) return true;
  }
  return tool?.hasSideEffects === true && aimsElsewhere(args, conversation);
}

/** A copy of `value` with the fields named like a secret masked. */
function maskSecrets(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth <= 0) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, depth - 1));
  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    masked[key] = SECRET_ARG.test(key) ? MASKED : maskSecrets(item, depth - 1);
  }
  return masked;
}

/**
 * What a person reads before answering: the tool and its target in one line, and
 * its arguments, with any field named like a secret masked.
 *
 * @param tool - The tool.
 * @param args - The call's arguments.
 * @returns The action a request carries.
 */
export function describeAction(tool: MarkedTool, args: Record<string, unknown>): RemoteApprovalAction {
  const name = String(tool?.name ?? 'unknown');
  const [target] = targetsOf(args);
  const summary = target ? `${name} to ${target}` : name;
  return {
    summary: summary.slice(0, SUMMARY_MAX_LENGTH),
    text: safeJsonStringify(maskSecrets(args, MASK_MAX_DEPTH), REMOTE_APPROVAL_TEXT_LIMIT),
  };
}

/**
 * The line a turn ends with when a tool's approval came back anything but yes.
 *
 * @param word - Why the tool did not run.
 * @param toolName - The tool.
 * @returns The line, which holds the word.
 */
export function remoteApprovalLine(word: RemoteApprovalWord, toolName: string): string {
  switch (word) {
    case 'declined':
      return `The request to run ${toolName} was declined, so it did not run.`;
    case 'expired':
      return `The request to run ${toolName} expired with no answer, so it did not run. Ask again to try it again.`;
    case 'withdrawn':
      return `The request to run ${toolName} was withdrawn, so it did not run.`;
    default:
      return `Approvals are not available (${APPROVAL_UNAVAILABLE}), so ${toolName} did not run.`;
  }
}

/** What a turn hands the asking functions. */
export interface ApprovingTurn {
  /** The conversation the turn answers, if it answers one. */
  conversation?: TurnConversation;
  /** The turn's reporting: its operation id, and the `approval_requested` event. */
  reportedTurn?: ReportedTurn;
}

/**
 * Asks the handler about one tool call and waits for the answer.
 *
 * @param handler - The handler.
 * @param tool - The tool.
 * @param args - The call's arguments.
 * @param turn - The turn asking.
 * @returns The decision. A handler that throws counts as {@link APPROVAL_UNAVAILABLE}.
 */
export async function askRemoteApproval(
  handler: RemoteApprovalHandler,
  tool: MarkedTool,
  args: Record<string, unknown>,
  turn: ApprovingTurn = {},
): Promise<RemoteApprovalDecision> {
  try {
    return await handler(
      {
        toolName: String(tool?.name ?? 'unknown'),
        action: describeAction(tool, args),
        operationId: turn.reportedTurn?.operationId ?? randomUUID(),
      },
      { onWaiting: () => turn.reportedTurn?.approvalRequested() },
    );
  } catch {
    return abort(APPROVAL_UNAVAILABLE);
  }
}

/** The answer of the hook {@link outwardApprovalFor} builds, as `runToolCallingTurn` reads it. */
export type OutwardApprovalVerdict =
  | { approved: true }
  | { approved: false; reason: RemoteApprovalWord; line: string };

/**
 * The `outwardApproval` hook of `runToolCallingTurn` for one turn: outward calls
 * ask the handler, every other call passes through it unasked.
 *
 * @param handler - The agent's handler, if it has one.
 * @param turn - The turn.
 * @returns The hook, or `undefined` when the agent has no handler.
 */
export function outwardApprovalFor(
  handler: RemoteApprovalHandler | undefined,
  turn: ApprovingTurn,
):
  | ((tool: MarkedTool, args: Record<string, unknown>) => Promise<OutwardApprovalVerdict | undefined>)
  | undefined {
  if (!handler) return undefined;
  return async (tool, args) => {
    if (!isOutwardAction(tool, args, turn.conversation)) return undefined;
    const decision = await askRemoteApproval(handler, tool, args, turn);
    if (decision.approved) return { approved: true };
    return {
      approved: false,
      reason: decision.reason,
      line: remoteApprovalLine(decision.reason, String(tool?.name ?? 'unknown')),
    };
  };
}
