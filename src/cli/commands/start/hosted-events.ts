/**
 * @fileoverview The hosted events reporter of `wunderland start`.
 *
 * With `WUNDERLAND_EVENTS_URL` and `WUNDERLAND_EVENTS_TOKEN` set, `start` posts
 * the coarse events of what the agent does to `<url>/events`, so the control
 * plane that runs the agent can see it working: names, counts, codes and times.
 * Without them no reporter exists and nothing is posted.
 *
 * Message text never reaches this module's output. {@link createEventsReporter}
 * sends only the known kinds and the known fields, and takes `code`, `toolName`
 * and the operation id only as a single word, so a caller that passes text by
 * mistake loses the field rather than posting the text.
 *
 * @module wunderland/cli/commands/start/hosted-events
 */
import { randomUUID } from 'node:crypto';

import { resolveOperationIdHeader } from '../../../platform/config/operation-id.js';
import type { GuardEventKind, GuardStage } from './guardrail-packs.js';

/** The environment variable that names the control plane's agent API root. */
export const EVENTS_URL_ENV = 'WUNDERLAND_EVENTS_URL';
/** The environment variable that holds the agent's bearer token for that API. */
export const EVENTS_TOKEN_ENV = 'WUNDERLAND_EVENTS_TOKEN';

/** How often the reporter posts what waits. */
export const EVENTS_FLUSH_INTERVAL_MS = 5_000;
/** The most events the reporter holds; past this it drops the oldest. */
export const EVENTS_QUEUE_LIMIT = 1_000;
/** The most events one post carries; the events route refuses a larger batch. */
export const EVENTS_BATCH_LIMIT = 200;

/** How long one post may take before its batch waits for the next try. */
const POST_TIMEOUT_MS = 10_000;
/** How long `stop` waits for the last post. A container's stop grace is short. */
const STOP_WAIT_MS = 2_000;
/** At most one warning line per this many milliseconds. */
const WARN_INTERVAL_MS = 60_000;

const CODE_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 128;
/** A single word: a status code, a platform, a tool's name, an operation id. */
const WORD = /^[A-Za-z0-9_.:-]+$/;

/** The kinds of event the reporter sends. */
export const HOSTED_EVENT_KINDS = [
  'turn_started',
  'turn_finished',
  'tool_called',
  'approval_requested',
  'provider_error',
  'channel_auth_failed',
  'referral_sent',
] as const;

/** One of {@link HOSTED_EVENT_KINDS}. */
export type HostedEventKind = (typeof HOSTED_EVENT_KINDS)[number];

const KNOWN_KINDS: ReadonlySet<string> = new Set(HOSTED_EVENT_KINDS);

/** The fields a caller may set on an event. */
export interface HostedEventFields {
  /** A status code or a platform name. */
  code?: string | number;
  /** How many times this happened; the server counts one when absent. */
  count?: number;
  /** Prompt tokens of a finished turn. */
  promptTokens?: number;
  /** Completion tokens of a finished turn. */
  completionTokens?: number;
  /** The name of the tool a `tool_called` event reports. */
  toolName?: string;
}

/** An event as it goes out. */
export interface HostedEvent {
  kind: HostedEventKind;
  /** When it happened, in milliseconds since the epoch. */
  at: number;
  code?: string;
  count?: number;
  promptTokens?: number;
  completionTokens?: number;
  toolName?: string;
}

/** Posts events to the control plane in the background. */
export interface EventsReporter {
  /**
   * Queues one event for the next post. Never throws, never waits. After
   * {@link EventsReporter.stop} it does nothing.
   *
   * @param kind - The event's kind; any other value is ignored.
   * @param fields - Its fields; a field that does not hold what it should is left out.
   * @param operationId - The turn it belongs to, sent in the header
   *   `AGENTOS_OPERATION_ID_HEADER` names. Events of different turns go in
   *   different posts.
   */
  report(kind: HostedEventKind, fields?: HostedEventFields, operationId?: string): void;
  /** Posts what waits now. Never rejects; a batch the server could not take stays queued. */
  flush(): Promise<void>;
  /** Ends the interval and posts what waits, waiting briefly for the answer. */
  stop(): Promise<void>;
}

interface QueuedEvent {
  event: HostedEvent;
  operationId?: string;
}

function asWord(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && text.length <= maxLength && WORD.test(text) ? text : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Builds the outgoing event from the known fields, each only if it holds what it should. */
function buildEvent(kind: HostedEventKind, fields: HostedEventFields = {}): HostedEvent {
  const event: HostedEvent = { kind, at: Date.now() };
  const code = asWord(fields.code, CODE_MAX_LENGTH);
  if (code !== undefined) event.code = code;
  const toolName = asWord(fields.toolName, NAME_MAX_LENGTH);
  if (toolName !== undefined) event.toolName = toolName;
  const count = asCount(fields.count);
  if (count !== undefined) event.count = count;
  const promptTokens = asCount(fields.promptTokens);
  if (promptTokens !== undefined) event.promptTokens = promptTokens;
  const completionTokens = asCount(fields.completionTokens);
  if (completionTokens !== undefined) event.completionTokens = completionTokens;
  return event;
}

/**
 * Creates a reporter that posts `{ events: [...] }` to `<url>/events` every
 * {@link EVENTS_FLUSH_INTERVAL_MS}, with `Authorization: Bearer <token>`.
 *
 * A post that gets no answer, a 429 or a 5xx leaves its batch queued for the
 * next try; any other refusal drops the batch. Either way the reason goes to
 * `console.warn`, one line a minute at most and never the token.
 *
 * @param options.url - The API root, without `/events`.
 * @param options.token - The bearer token.
 * @returns The reporter. Its interval does not keep the process alive.
 */
export function createEventsReporter(options: { url: string; token: string }): EventsReporter {
  const endpoint = `${options.url.trim().replace(/\/+$/, '')}/events`;
  const token = options.token.trim();

  let lastWarnAt: number | undefined;
  const warn = (line: string): void => {
    const now = Date.now();
    if (lastWarnAt !== undefined && now - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = now;
    console.warn(`[hosted-events] ${line}`);
  };

  let operationHeader: string | undefined;
  try {
    operationHeader = resolveOperationIdHeader();
  } catch (err) {
    warn(`${err instanceof Error ? err.message : String(err)} Posting events without an operation id.`);
  }

  let queue: QueuedEvent[] = [];
  let dropped = 0;
  let stopped = false;
  let running: Promise<void> | null = null;

  /** Posts one batch. Returns whether the batch has left the queue's care. */
  const post = async (batch: QueuedEvent[], operationId: string | undefined): Promise<boolean> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (operationHeader && operationId) headers[operationHeader] = operationId;

    let status: number;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: batch.map((item) => item.event) }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      status = res.status;
      await res.text();
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'error';
      warn(`The events server did not answer (${reason}); keeping ${batch.length} events for the next try.`);
      return false;
    }
    if (status >= 200 && status < 300) return true;
    if (status === 429 || status >= 500) {
      warn(`The events server answered ${status}; keeping ${batch.length} events for the next try.`);
      return false;
    }
    warn(`The events server refused ${batch.length} events (${status}); dropping them.`);
    return true;
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      // The next post: the oldest waiting turn's events, up to the batch limit.
      const operationId = queue[0]!.operationId;
      const batch: QueuedEvent[] = [];
      for (const item of queue) {
        if (item.operationId !== operationId) continue;
        batch.push(item);
        if (batch.length === EVENTS_BATCH_LIMIT) break;
      }
      if (!(await post(batch, operationId))) break;
      const sent = new Set(batch);
      queue = queue.filter((item) => !sent.has(item));
    }
    if (dropped > 0) {
      warn(`Dropped ${dropped} events: more than ${EVENTS_QUEUE_LIMIT} were waiting.`);
      dropped = 0;
    }
  };

  const flush = (): Promise<void> => {
    if (!running) {
      running = drain().finally(() => {
        running = null;
      });
    }
    return running;
  };

  const timer = setInterval(() => {
    void flush();
  }, EVENTS_FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    report(kind, fields, operationId) {
      if (stopped || !KNOWN_KINDS.has(kind)) return;
      if (queue.length >= EVENTS_QUEUE_LIMIT) {
        queue.shift();
        dropped += 1;
      }
      queue.push({ event: buildEvent(kind, fields), operationId: asWord(operationId, NAME_MAX_LENGTH) });
    },
    flush,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => {
          waited = setTimeout(resolve, STOP_WAIT_MS);
          waited.unref?.();
        }),
      ]);
      if (waited) clearTimeout(waited);
    },
  };
}

/**
 * The reporter the environment asks for: one when `WUNDERLAND_EVENTS_URL` and
 * `WUNDERLAND_EVENTS_TOKEN` both hold a value, none otherwise. A URL that does
 * not parse makes none, with one warning line.
 *
 * @param env - The environment to read; `process.env` by default.
 * @returns The reporter, or `undefined`.
 */
export function createEventsReporterFromEnv(
  env: Record<string, string | undefined> = process.env,
): EventsReporter | undefined {
  const url = env[EVENTS_URL_ENV]?.trim();
  const token = env[EVENTS_TOKEN_ENV]?.trim();
  if (!url || !token) return undefined;
  try {
    new URL(url);
  } catch {
    console.warn(`[hosted-events] ${EVENTS_URL_ENV} is not a URL; no events are posted.`);
    return undefined;
  }
  return createEventsReporter({ url, token });
}

/** One turn's events, with its counts and its operation id kept in one place. */
export interface ReportedTurn {
  /** The id the turn's events go out with; none when there is no reporter. */
  readonly operationId?: string;
  /** The model called a tool the agent has; this comes before the call's approval. */
  toolCalled(toolName: unknown): void;
  /** One provider response's usage; the turn adds them up. */
  usage(usage: { prompt_tokens?: number; completion_tokens?: number }): void;
  /** A provider request failed; its status code goes out, never its message. */
  providerError(error: unknown): void;
  /** The turn is waiting on a person: a tool's approval or a checkpoint. */
  approvalRequested(): void;
  /**
   * A guardrail pack's verdict on the person's message (`input`) or the reply
   * (`output`) carried an event, such as `referral_sent`. The stage goes out as
   * the event's `code`; nothing the person or the model wrote does.
   */
  guardEvent(kind: GuardEventKind, stage: GuardStage): void;
  /** The turn ended, however it ended. Later calls do nothing. */
  finished(): void;
}

const UNREPORTED_TURN: ReportedTurn = Object.freeze({
  toolCalled() {},
  usage() {},
  providerError() {},
  approvalRequested() {},
  guardEvent() {},
  finished() {},
});

/**
 * Starts one turn's reporting: posts `turn_started`, and returns the calls the
 * turn makes as it goes.
 *
 * @param reporter - The reporter, or `undefined`, which makes every call do nothing.
 * @returns The turn's reporting calls, safe to pass as bare callbacks.
 */
export function startReportedTurn(reporter?: EventsReporter): ReportedTurn {
  if (!reporter) return UNREPORTED_TURN;
  const operationId = randomUUID();
  let promptTokens = 0;
  let completionTokens = 0;
  let done = false;
  reporter.report('turn_started', undefined, operationId);
  return {
    operationId,
    toolCalled(toolName) {
      reporter.report('tool_called', { toolName: toolName as string }, operationId);
    },
    usage(usage) {
      promptTokens += asCount(usage?.prompt_tokens) ?? 0;
      completionTokens += asCount(usage?.completion_tokens) ?? 0;
    },
    providerError(error) {
      const status = (error as { status?: unknown } | null | undefined)?.status;
      reporter.report('provider_error', typeof status === 'number' ? { code: status } : undefined, operationId);
    },
    approvalRequested() {
      reporter.report('approval_requested', undefined, operationId);
    },
    guardEvent(kind, stage) {
      reporter.report(kind, { code: stage }, operationId);
    },
    finished() {
      if (done) return;
      done = true;
      reporter.report('turn_finished', { promptTokens, completionTokens }, operationId);
    },
  };
}

/** The `code` a channel pack's `error` event carries when the platform rejected its token. */
export const CHANNEL_AUTH_FAILED_CODE = 'auth_failed';

/**
 * Whether a channel event says the platform rejected the channel's token: an
 * `error` event whose data carries `code: 'auth_failed'`.
 *
 * @param event - The channel event.
 */
export function isChannelAuthFailure(event: { type?: unknown; data?: unknown } | null | undefined): boolean {
  return event?.type === 'error'
    && (event.data as { code?: unknown } | null | undefined)?.code === CHANNEL_AUTH_FAILED_CODE;
}
