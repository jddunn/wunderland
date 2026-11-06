/**
 * @fileoverview Where the person on a turn is, as far as the turn says, for the
 * guardrail packs `wunderland start` runs. The place goes into the guard
 * context's `metadata` on the person's message and on the reply alike:
 *
 * ```ts
 * metadata: { platform: 'telegram', conversationType: 'direct', locale: 'en-AU' } // a Telegram message
 * metadata: { channel: 'http', country: 'NZ' }                                     // POST /chat with "country": "NZ"
 * ```
 *
 * | Turn | Read | Source |
 * |---|---|---|
 * | A Telegram message | the sender's `from.language_code` on the context the Telegram pack passes, or on `ctx` when the pack wrapped it for a command | [Telegram Bot API, `User`](https://core.telegram.org/bots/api#user): "IETF language tag of the user's language", optional |
 * | A Discord slash command | `interaction.locale` | [Discord, interaction object](https://docs.discord.com/developers/interactions/receiving-and-responding): "Selected language of the invoking user" |
 * | `POST /chat` | `country` and `locale` in the JSON body, named by the host | |
 *
 * A plain Discord message carries no locale of its sender's, and an
 * interaction's `guild_locale` is the server's, not the person's, so neither is
 * read. A webhook's or a scheduled turn has no person to place.
 *
 * The self-harm referral pack (`@framers/agentos-ext-self-harm-referral`)
 * reads `metadata.country`, then the region of `metadata.locale`, and leads its
 * referral with that country's crisis lines and emergency number.
 *
 * @module wunderland/cli/commands/start/guard-place
 */

/** The place a turn names. A key is absent when the turn names none. */
export interface GuardPlace {
  /** An ISO 3166-1 alpha-2 country code in upper case, such as `NZ`. */
  country?: string;
  /** A language tag as the channel or the host gave it, such as `en-AU` or `pt-br`. */
  locale?: string;
}

/** A country is two letters. */
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

/** A locale is 2 to 35 letters, digits, hyphens or underscores: a BCP 47 tag in the forms channels send. */
const LOCALE_PATTERN = /^[A-Za-z0-9_-]{2,35}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The value at `keys` under `source`, or undefined when a step is missing or a getter throws. */
function readPath(source: unknown, keys: readonly string[]): unknown {
  let value: unknown = source;
  for (const key of keys) {
    if (!isObject(value)) return undefined;
    try {
      value = value[key];
    } catch {
      return undefined;
    }
  }
  return value;
}

function countryOf(value: unknown): string | undefined {
  return typeof value === 'string' && COUNTRY_PATTERN.test(value) ? value.toUpperCase() : undefined;
}

function localeOf(value: unknown): string | undefined {
  return typeof value === 'string' && LOCALE_PATTERN.test(value) ? value : undefined;
}

/**
 * The locale a channel message's raw event reports for its sender, as the
 * published channel packs pass it: on `telegram`, `from.language_code` of
 * grammY's context, or of `ctx` when the pack wrapped the context for a
 * command; on `discord`, `interaction.locale` of a slash command. Any other
 * platform, a plain Discord message, and a value that is not a language tag
 * give no place.
 *
 * @param message - The inbound channel message (`platform`, `rawEvent`).
 * @returns `{ locale }`, or `{}` when the message names none.
 */
export function channelGuardPlace(message: { platform?: unknown; rawEvent?: unknown } | null | undefined): GuardPlace {
  if (!isObject(message)) return {};
  const platform = typeof message.platform === 'string' ? message.platform.trim().toLowerCase() : '';
  const raw = message.rawEvent;
  let reported: unknown;
  if (platform === 'telegram') {
    reported = readPath(raw, ['from', 'language_code']) ?? readPath(raw, ['ctx', 'from', 'language_code']);
  } else if (platform === 'discord') {
    reported = readPath(raw, ['interaction', 'locale']);
  }
  const locale = localeOf(reported);
  return locale ? { locale } : {};
}

/**
 * The place a host names on `POST /chat`: `country`, two letters (returned in
 * upper case), and `locale`, a language tag. Each is dropped on its own when
 * it is not of that shape, so `"country": "Germany"` names no country.
 *
 * @param body - The parsed JSON body.
 * @returns `{ country?, locale? }`, with only the fields the body names well.
 */
export function chatGuardPlace(body: unknown): GuardPlace {
  if (!isObject(body)) return {};
  const place: GuardPlace = {};
  const country = countryOf(readPath(body, ['country']));
  if (country) place.country = country;
  const locale = localeOf(readPath(body, ['locale']));
  if (locale) place.locale = locale;
  return place;
}
