/**
 * @fileoverview Guardrail packs in `wunderland start`: which packs an agent
 * config names, how `start` loads them, and the check every turn path runs on
 * the person's message and on the reply.
 *
 * ```json
 * {
 *   "extensions": { "guardrails": ["self-harm-referral"] },
 *   "extensionOverrides": {
 *     "self-harm-referral": { "options": { "judgeModel": { "provider": "openai", "model": "gpt-4o-mini" } } }
 *   }
 * }
 * ```
 *
 * A pack's `guardrail` descriptors are kept whichever list loaded the pack, and
 * {@link createTurnGuardrails} runs them through AgentOS's own dispatcher
 * (`evaluateInputGuardrails` on the message before any model sees it,
 * `wrapOutputGuardrails` on the reply before the person does). A block answers
 * the person with the guard's message. A guard's event (`referral_sent`) is
 * reported on the turn, with none of the person's words.
 *
 * @module wunderland/cli/commands/start/guardrail-packs
 */
import { randomUUID } from 'node:crypto';

import {
  GuardrailAction,
  evaluateInputGuardrails,
  wrapOutputGuardrails,
  type GuardrailContext,
  type GuardrailEvaluationResult,
  type IGuardrailService,
} from '@framers/agentos/safety/guardrails';

import { normalizeExtensionName } from '../../extensions/aliases.js';
import { agentosBaseUrlFor } from '../../../platform/config/provider-base-urls.js';

/** A guardrail pack `start` loads itself: the extensions registry does not list it. */
interface GuardrailPackEntry {
  /** The npm package the pack is published as. */
  readonly packageName: string;
  /** Imports the package. */
  readonly load: () => Promise<unknown>;
}

/**
 * The guardrail packs `extensions.guardrails` takes, by curated name. Each is
 * an optional peer dependency: install the package beside `wunderland`.
 */
export const GUARDRAIL_PACKS: Readonly<Record<string, GuardrailPackEntry>> = Object.freeze({
  'self-harm-referral': {
    packageName: '@framers/agentos-ext-self-harm-referral',
    // @ts-ignore optional peer dependency; not installed in every environment
    load: () => import('@framers/agentos-ext-self-harm-referral'),
  },
});

/** The line a block answers with when its guard gives no message of its own. */
export const GUARDRAIL_BLOCKED_LINE = "I can't help with that.";

/** The events a guard may report on a turn, by the name its verdict's `metadata.event` carries. */
export const GUARD_EVENT_KINDS = ['referral_sent'] as const;

/** One of {@link GUARD_EVENT_KINDS}. */
export type GuardEventKind = (typeof GUARD_EVENT_KINDS)[number];

/** Where in the turn a guard judged: the person's message or the reply. */
export type GuardStage = 'input' | 'output';

/** An event a guard's verdict carried, as the turn reports it. */
export interface GuardEvent {
  kind: GuardEventKind;
  stage: GuardStage;
}

const KNOWN_GUARD_EVENTS: ReadonlySet<string> = new Set(GUARD_EVENT_KINDS);

/** The ids of the turn the guards judge. */
export type TurnGuardContext = GuardrailContext;

/** The verdict on a person's message. */
export interface InputVerdict {
  /** True when a guard blocked the message: it goes to no model. */
  blocked: boolean;
  /** The guard's message when blocked; otherwise the message as the guards left it (a sanitizer may change it). */
  text: string;
  /** The events the guards' verdicts carried. */
  events: GuardEvent[];
}

/** The verdict on a reply. */
export interface OutputVerdict {
  /** True when a guard blocked the reply: none of it reaches the person. */
  blocked: boolean;
  /** What the person receives: the reply, a sanitized reply, or the guard's message after a block. */
  text: string;
  /** The events the guards' verdicts carried. */
  events: GuardEvent[];
}

/** The guards of one agent, run on each turn. */
export interface TurnGuardrails {
  /** The guards' ids, in the order they run. */
  readonly ids: readonly string[];
  /**
   * Judges a person's message before any model sees it. Never rejects: a check
   * that fails blocks, so the message reaches no model.
   */
  checkInput(text: string, context: TurnGuardContext): Promise<InputVerdict>;
  /**
   * Judges a reply before the person receives it. Never rejects: a check that
   * fails blocks, so none of the reply reaches the person.
   */
  checkOutput(text: string, context: TurnGuardContext): Promise<OutputVerdict>;
}

/** The turn reporting a path hands guard events to: `ReportedTurn` of `hosted-events.ts`. */
export interface GuardEventSink {
  guardEvent(kind: GuardEventKind, stage: GuardStage): void;
}

/** Hands each event to the turn's reporter. */
export function reportGuardEvents(turn: GuardEventSink, events: readonly GuardEvent[]): void {
  for (const event of events) turn.guardEvent(event.kind, event.stage);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `name` is a guardrail pack `start` loads itself. */
export function isGuardrailPackName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GUARDRAIL_PACKS, normalizeExtensionName(name));
}

/**
 * Takes the guardrail packs `start` loads itself out of an extension list, so
 * the registry is not asked for them.
 *
 * @returns The list's guardrail packs and the rest, each in the list's order.
 */
export function takeGuardrailPacks(names: readonly string[]): { guardrails: string[]; rest: string[] } {
  const guardrails: string[] = [];
  const rest: string[] = [];
  for (const name of names) (isGuardrailPackName(name) ? guardrails : rest).push(normalizeExtensionName(name));
  return { guardrails, rest };
}

/**
 * The guardrail packs an agent runs, in the order their guards run: the
 * `extensions.guardrails` list of the agent config (else of the global
 * config), then the guardrail packs `tools.allow.packs` names, then those an
 * `extensions` tool, voice or productivity list names. A guard adds no tool, so
 * `tools.allow` never holds one back.
 *
 * @throws Error when `extensions.guardrails` names a pack `start` does not
 *   load, or is not a list of names: an agent that asks for a guard never runs
 *   without it.
 */
export function guardrailPackNamesFor(opts: {
  cfg: unknown;
  globalConfig?: unknown;
  allowedPacks?: readonly string[];
  extensionLists?: readonly string[];
}): string[] {
  const listed = (config: unknown): unknown => {
    const extensions = isPlainObject(config) ? config['extensions'] : undefined;
    return isPlainObject(extensions) ? extensions['guardrails'] : undefined;
  };
  const configured = listed(opts.cfg) ?? listed(opts.globalConfig);

  const names: string[] = [];
  if (configured !== undefined) {
    if (!Array.isArray(configured) || configured.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error('extensions.guardrails must be a list of guardrail pack names.');
    }
    for (const raw of configured as string[]) {
      const name = normalizeExtensionName(raw);
      if (!isGuardrailPackName(name)) {
        throw new Error(
          `extensions.guardrails names "${name}", which is not a guardrail pack start loads (${Object.keys(GUARDRAIL_PACKS).join(', ')}).`,
        );
      }
      names.push(name);
    }
  }
  for (const name of [...(opts.allowedPacks ?? []), ...(opts.extensionLists ?? [])]) {
    if (isGuardrailPackName(name)) names.push(normalizeExtensionName(name));
  }
  return [...new Set(names)];
}

/** What a guardrail pack's options can take from the host. */
export interface GuardrailHost {
  /** The agent's primary provider. */
  providerId?: string;
  /** The agent's key for that provider. */
  llmApiKey?: string;
  /** Reads a secret by id (`openai.apiKey`), from the config's secrets or the environment. */
  getSecret: (secretId: string) => string | undefined;
}

/**
 * A pack's options as the agent config gives them, with what a JSON config
 * cannot or should not carry filled in from the host: a `judgeModel` that names
 * a provider and no `apiKey` gets the host's key for that provider (the
 * `<provider>.apiKey` secret, else the agent's own key when the provider is the
 * agent's), and one with no `baseUrl` gets the provider's base-URL variable, so
 * the judge's calls go where the agent's calls go.
 */
export function guardrailPackOptions(options: unknown, host: GuardrailHost): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(options) ? { ...options } : {};
  const judgeModel = out['judgeModel'];
  if (!isPlainObject(judgeModel)) return out;

  const judge: Record<string, unknown> = { ...judgeModel };
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const provider = text(judge['provider']).toLowerCase();
  if (provider) {
    if (!text(judge['apiKey'])) {
      const key = host.getSecret(`${provider}.apiKey`) || (provider === host.providerId ? host.llmApiKey : undefined);
      if (key) judge['apiKey'] = key;
    }
    if (!text(judge['baseUrl'])) {
      const baseUrl = agentosBaseUrlFor(provider);
      if (baseUrl) judge['baseUrl'] = baseUrl;
    }
  }
  out['judgeModel'] = judge;
  return out;
}

/** The shape of an extension pack this module reads. */
export interface GuardrailPackLike {
  name?: string;
  descriptors?: Array<{ id?: string; kind?: string; payload?: unknown }>;
  onActivate?: (context: unknown) => unknown;
}

/**
 * Loads the named guardrail packs with their options from the overrides.
 *
 * @param opts.names - Names from {@link guardrailPackNamesFor}.
 * @param opts.overrides - `extensionOverrides`, global then agent merged; `enabled: false` skips a pack.
 * @param opts.host - What the packs' options take from the host.
 * @param opts.logger - The logger each pack writes through.
 * @returns The packs, in the order named.
 * @throws Error naming the package when a pack does not load: an agent that
 *   asks for a guard never runs without it.
 */
export async function loadGuardrailPacks(opts: {
  names: readonly string[];
  overrides: Record<string, { enabled?: boolean; options?: unknown } | undefined>;
  host: GuardrailHost;
  logger: unknown;
}): Promise<GuardrailPackLike[]> {
  const packs: GuardrailPackLike[] = [];
  for (const name of opts.names) {
    const entry = GUARDRAIL_PACKS[name];
    if (!entry) continue;
    const override = opts.overrides[name];
    if (override?.enabled === false) continue;
    try {
      const mod = (await entry.load()) as Record<string, any>;
      const factory = mod['createExtensionPack'] ?? mod['default']?.createExtensionPack ?? mod['default'];
      if (typeof factory !== 'function') throw new Error('it exports no createExtensionPack');
      const pack = (await factory({
        options: guardrailPackOptions(override?.options, opts.host),
        logger: opts.logger,
        getSecret: opts.host.getSecret,
      })) as GuardrailPackLike;
      if (typeof pack?.onActivate === 'function') {
        await pack.onActivate({ logger: opts.logger, getSecret: opts.host.getSecret });
      }
      packs.push(pack);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The guardrail pack "${name}" did not load (${entry.packageName}: ${reason}). Install it beside wunderland, or remove it from the agent config.`,
      );
    }
  }
  return packs;
}

/** Every `guardrail` descriptor's guard across the packs, in pack and descriptor order. */
export function guardrailServicesOf(packs: readonly unknown[]): IGuardrailService[] {
  const services: IGuardrailService[] = [];
  for (const pack of packs) {
    const descriptors = (pack as GuardrailPackLike | null | undefined)?.descriptors;
    if (!Array.isArray(descriptors)) continue;
    for (const descriptor of descriptors) {
      if (descriptor?.kind !== 'guardrail') continue;
      const service = descriptor.payload as IGuardrailService | undefined;
      if (service && (typeof service.evaluateInput === 'function' || typeof service.evaluateOutput === 'function')) {
        services.push(service);
      }
    }
  }
  return services;
}

/** The events the verdicts carried, by their `metadata.event`. */
function guardEventsOf(metadataList: ReadonlyArray<unknown>, stage: GuardStage): GuardEvent[] {
  const events: GuardEvent[] = [];
  for (const metadata of metadataList) {
    const kind = isPlainObject(metadata) ? metadata['event'] : undefined;
    if (typeof kind === 'string' && KNOWN_GUARD_EVENTS.has(kind)) events.push({ kind: kind as GuardEventKind, stage });
  }
  return events;
}

/**
 * What a block answers with: the guard's own message (`replacementText`), else
 * {@link GUARDRAIL_BLOCKED_LINE}. A block's `reason` is for the operator, not
 * the person, so it is never sent.
 */
function blockedText(evaluation: Pick<GuardrailEvaluationResult, 'replacementText'> | null | undefined): string {
  const text = evaluation?.replacementText;
  return typeof text === 'string' && text.trim() ? text : GUARDRAIL_BLOCKED_LINE;
}

/** One line for a check that failed: the error's name, never its message, which can repeat the text. */
function warnCheckFailed(stage: GuardStage, err: unknown): void {
  console.warn(`[guardrails] the ${stage} check failed (${err instanceof Error ? err.name : 'error'}); the turn answers ${JSON.stringify(GUARDRAIL_BLOCKED_LINE)}.`);
}

/**
 * The guards one agent runs on each turn, or `undefined` when it has none, so
 * a path without guards runs as it did before.
 *
 * @param services - The guards, in the order they run (a guard that blocks first wins).
 */
export function createTurnGuardrails(services: readonly IGuardrailService[]): TurnGuardrails | undefined {
  if (services.length === 0) return undefined;
  const guards = [...services];
  const ids = guards.map((guard, index) => (typeof guard.id === 'string' && guard.id ? guard.id : `guardrail-${index + 1}`));

  return {
    ids,

    async checkInput(text, context) {
      let outcome: Awaited<ReturnType<typeof evaluateInputGuardrails>>;
      try {
        outcome = await evaluateInputGuardrails(
          guards,
          { userId: context.userId, sessionId: context.sessionId, textInput: text } as any,
          context,
        );
      } catch (err) {
        warnCheckFailed('input', err);
        return { blocked: true, text: GUARDRAIL_BLOCKED_LINE, events: [] };
      }
      const evaluations = outcome.evaluations ?? (outcome.evaluation ? [outcome.evaluation] : []);
      const events = guardEventsOf(evaluations.map((evaluation) => evaluation.metadata), 'input');
      if (outcome.evaluation?.action === GuardrailAction.BLOCK) {
        return { blocked: true, text: blockedText(outcome.evaluation), events };
      }
      const sanitized = outcome.sanitizedInput?.textInput;
      return { blocked: false, text: typeof sanitized === 'string' ? sanitized : text, events };
    },

    async checkOutput(text, context) {
      const streamId = randomUUID();
      const personaId = context.personaId ?? 'wunderland';
      async function* reply(): AsyncGenerator<any, void, undefined> {
        yield {
          type: 'final_response',
          streamId,
          gmiInstanceId: 'wunderland',
          personaId,
          isFinal: true,
          timestamp: new Date().toISOString(),
          finalResponseText: text,
        };
      }

      let blocked = false;
      let delivered: string | undefined;
      const metadataList: unknown[] = [];
      const wrapped = wrapOutputGuardrails(guards, context, reply(), {
        streamId,
        personaId,
        onVerdict: (verdict) => {
          if (verdict.action === GuardrailAction.BLOCK) blocked = true;
        },
      });
      try {
        for await (const chunk of wrapped as AsyncGenerator<any, void, undefined>) {
          if (chunk?.type === 'final_response') {
            if (typeof chunk.finalResponseText === 'string') delivered = chunk.finalResponseText;
            const output = chunk.metadata?.guardrail?.output;
            for (const entry of Array.isArray(output) ? output : output ? [output] : []) metadataList.push(entry?.metadata);
          } else if (chunk?.type === 'error') {
            // A block whose guard gave no message of its own.
            blocked = true;
            delivered = undefined;
            metadataList.push(chunk.details?.metadata);
          }
        }
      } catch (err) {
        warnCheckFailed('output', err);
        return { blocked: true, text: GUARDRAIL_BLOCKED_LINE, events: [] };
      }

      const events = guardEventsOf(metadataList, 'output');
      if (blocked) {
        return { blocked: true, text: delivered && delivered.trim() ? delivered : GUARDRAIL_BLOCKED_LINE, events };
      }
      return { blocked: false, text: delivered ?? text, events };
    },
  };
}

/**
 * Puts what the person received in place of the reply in a turn's history: the
 * last assistant message, so the next turn's model sees what was sent and none
 * of a reply the guards refused.
 */
export function replaceReplyInHistory(messages: Array<{ role?: string; content?: unknown }> | undefined, text: string): void {
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'assistant') {
      messages[i] = { ...message, content: text };
      return;
    }
  }
}

/** A reply with the `<think>` blocks some models emit removed: the text a person would receive. */
export function visibleReplyText(reply: string): string {
  return reply
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '')
    .trim();
}
