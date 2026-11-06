// @ts-nocheck
/**
 * The place a turn names for the guards, read from what the turn carries:
 * `channelGuardPlace` reads the locale the Telegram and Discord packs pass in a
 * message's raw event, and `chatGuardPlace` reads `country` and `locale` from
 * `POST /chat`'s body. A value of any other shape is dropped, so a guard is
 * never handed a place the turn did not name.
 *
 * `guard-place.integration.test.ts` runs both through start's turn paths with
 * the published self-harm referral pack.
 */
import { describe, it, expect } from 'vitest';

import { channelGuardPlace, chatGuardPlace } from '../guard-place.js';

/** A grammY context reads `from` through a getter on its prototype. */
class TelegramContextLike {
  constructor(private readonly update: { message: { from?: Record<string, unknown> } }) {}

  get from() {
    return this.update.message.from;
  }
}

/** A raw event whose getter throws: the place is dropped and the turn goes on. */
const throwingEvent = Object.defineProperty({}, 'from', {
  get() {
    throw new Error('not readable');
  },
});

describe('channelGuardPlace', () => {
  it.each([
    ['a Telegram update (the grammY context)', 'telegram', { from: { id: 1, language_code: 'en-AU' } }, { locale: 'en-AU' }],
    ['a Telegram context read through its getter', 'telegram', new TelegramContextLike({ message: { from: { language_code: 'pt-br' } } }), { locale: 'pt-br' }],
    ['a Telegram command (the context wrapped for an explicit invocation)', 'telegram', { ctx: { from: { language_code: 'en-GB' } }, explicitInvocation: true, explain: false }, { locale: 'en-GB' }],
    ['a Discord slash command (the interaction wrapped)', 'discord', { interaction: { locale: 'en-CA', guildLocale: 'en-GB' }, explicitInvocation: true }, { locale: 'en-CA' }],
    ['a platform name in another case', 'Telegram', { from: { language_code: 'en' } }, { locale: 'en' }],
    ['a language tag of 35 characters, the longest kept', 'telegram', { from: { language_code: `en-${'a'.repeat(32)}` } }, { locale: `en-${'a'.repeat(32)}` }],
  ])('reads %s', (_what, platform, rawEvent, expected) => {
    expect(channelGuardPlace({ platform, rawEvent })).toEqual(expected);
  });

  it.each([
    ['a Telegram user with no language_code', 'telegram', { from: { id: 1 } }],
    ['a Telegram update with no sender', 'telegram', { message: { text: 'hi' } }],
    ['a language_code that is a number', 'telegram', { from: { language_code: 42 } }],
    ['a language_code that is an object', 'telegram', { from: { language_code: { tag: 'en-AU' } } }],
    ['an empty language_code', 'telegram', { from: { language_code: '' } }],
    ['a one-letter language_code', 'telegram', { from: { language_code: 'e' } }],
    ['a language_code of 36 characters', 'telegram', { from: { language_code: `en-${'a'.repeat(33)}` } }],
    ['a language_code with a space', 'telegram', { from: { language_code: 'en AU' } }],
    ['a language_code with markup', 'telegram', { from: { language_code: 'en-AU<b>' } }],
    ['a getter that throws', 'telegram', throwingEvent],
    // A plain discord.js message carries no locale of its sender's; the server's is not the person's.
    ['a plain Discord message', 'discord', { id: 'm1', content: 'hi', interaction: null, guild: { preferredLocale: 'en-AU' } }],
    ["a Discord interaction with the server's locale alone", 'discord', { interaction: { guildLocale: 'en-AU', guild_locale: 'en-AU' } }],
    // Each platform's field is read on that platform alone.
    ["Telegram's field on a Discord message", 'discord', { from: { language_code: 'en-AU' } }],
    ["Discord's field on a Telegram message", 'telegram', { interaction: { locale: 'en-AU' } }],
    ['a platform that reports no locale', 'slack', { from: { language_code: 'en-AU' }, interaction: { locale: 'en-AU' } }],
    ['no raw event', 'telegram', undefined],
    ['a raw event that is a string', 'telegram', 'en-AU'],
  ])('drops %s', (_what, platform, rawEvent) => {
    expect(channelGuardPlace({ platform, rawEvent })).toEqual({});
  });

  it('answers nothing for a message that is not an object', () => {
    expect(channelGuardPlace(undefined)).toEqual({});
    expect(channelGuardPlace(null)).toEqual({});
  });
});

describe('chatGuardPlace', () => {
  it.each([
    ['a country', { message: 'hi', country: 'NZ' }, { country: 'NZ' }],
    ['a country in lower case, upper-cased', { country: 'nz' }, { country: 'NZ' }],
    ['a locale', { locale: 'en_GB' }, { locale: 'en_GB' }],
    ['both', { country: 'AU', locale: 'en-AU' }, { country: 'AU', locale: 'en-AU' }],
    ['a locale beside a country that is dropped', { country: 'Germany', locale: 'de-DE' }, { locale: 'de-DE' }],
    ['a country beside a locale that is dropped', { country: 'IE', locale: 'en IE' }, { country: 'IE' }],
    ['only country and locale, whatever else the body holds', { country: 'GB', channel: 'telegram', platform: 'discord', metadata: { country: 'US' } }, { country: 'GB' }],
  ])('reads %s', (_what, body, expected) => {
    expect(chatGuardPlace(body)).toEqual(expected);
  });

  it.each([
    ['a country name', { country: 'Germany' }],
    ['a three-letter code', { country: 'NZL' }],
    ['one letter', { country: 'N' }],
    ['a code with a space around it', { country: ' NZ' }],
    ['a code with digits', { country: '64' }],
    ['a number', { country: 64 }],
    ['null', { country: null }],
    ['a list', { country: ['NZ'] }],
    ['a locale of 36 characters', { locale: `en-${'a'.repeat(33)}` }],
    ['a locale with a semicolon', { locale: 'en-GB;q=0.9' }],
    ['a locale that is a number', { locale: 7 }],
  ])('drops %s', (_what, body) => {
    expect(chatGuardPlace(body)).toEqual({});
  });

  it('answers nothing for a body that is not an object', () => {
    for (const body of [undefined, null, 'NZ', 7, ['NZ']]) expect(chatGuardPlace(body)).toEqual({});
  });
});
