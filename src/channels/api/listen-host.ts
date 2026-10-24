/**
 * @fileoverview The address the agent HTTP servers listen on.
 * @module wunderland/channels/api/listen-host
 *
 * POST /chat answers without a secret unless `chat.secret` or
 * `WUNDERLAND_CHAT_SECRET` is set, so `wunderland start`, `wunderland serve`
 * and {@link createWunderlandServer} listen on the loopback address unless a
 * host is named, and refuse a host other machines can reach until a chat
 * secret is set. `0.0.0.0` accepts connections from every machine that can
 * reach the port.
 */

import { isIPv6 } from 'node:net';

/** The address the agent servers listen on when no host is named. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

/**
 * Resolves a `--host` flag.
 *
 * @param value - The parsed flag: undefined when absent, `true` when it was given with no address.
 * @returns The address to listen on: {@link DEFAULT_LISTEN_HOST} when no flag was given, and a
 *   bracketed IPv6 address (`[::1]`, URL notation) bare, the form server.listen takes.
 * @throws Error when the flag was given without an address, so a typo never widens the server.
 */
export function resolveListenHost(value: string | boolean | undefined): string {
  if (value === undefined || value === false) return DEFAULT_LISTEN_HOST;
  const host = typeof value === 'string' ? value.trim() : '';
  if (!host) {
    throw new Error('--host needs an address, for example --host 127.0.0.1 or --host 0.0.0.0');
  }
  const bracketed = /^\[(.*)\]$/.exec(host);
  return bracketed && isIPv6(bracketed[1]) ? bracketed[1] : host;
}

/**
 * Whether only this machine can reach an address.
 *
 * @param host - A listen address, with or without IPv6 brackets.
 * @returns True for `localhost`, `::1` and the 127.0.0.0/8 range.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(bare) ||
    /^::ffff:127(\.\d{1,3}){3}$/.test(bare)
  );
}

/**
 * Refuses to listen where other machines can connect while POST /chat has no secret.
 *
 * @param host - The address the server is about to listen on.
 * @param chatSecret - The secret /chat requires; empty when none is set.
 * @throws Error naming the host and how to set a secret, unless the host is loopback or a secret is set.
 */
export function assertChatSecretForHost(host: string, chatSecret: string): void {
  if (chatSecret || isLoopbackHost(host)) return;
  throw new Error(
    `Refusing to listen on ${host}: other machines could reach POST /chat, which has no secret. `
      + 'Set chat.secret in agent.config.json or WUNDERLAND_CHAT_SECRET (createWunderlandServer() also takes '
      + 'a chatSecret option), or listen on 127.0.0.1.',
  );
}

/**
 * The host to print in a URL for a listen address.
 *
 * @param host - A listen address.
 * @returns `localhost` for a wildcard address (`0.0.0.0`, `::`), IPv6 in brackets, anything else as given.
 */
export function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * The /health URL of an agent server.
 *
 * @param port - The server's port.
 * @param host - The address it listens on. Daemons recorded before `--host`
 *   existed have none; they listened on every interface and answer on localhost.
 * @returns The URL to poll.
 */
export function healthUrl(port: number, host?: string): string {
  return `http://${host ? displayHost(host) : 'localhost'}:${port}/health`;
}
