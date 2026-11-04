/**
 * @fileoverview The operation id wunderland sends with each provider request
 * it makes itself, in a header the host names.
 *
 * A server in front of the provider (a gateway or a metering proxy) reads the
 * id to tell a retry of one call from a new call. A call makes one id before
 * its first attempt and sends that value on every attempt of the call: the
 * primary request and, when it fails, the request to the fallback candidate.
 * The next call gets a new id.
 *
 * The header's name comes from `AGENTOS_OPERATION_ID_HEADER`, the variable
 * AgentOS's providers read for the same purpose. With it unset or blank, no
 * header is sent and every request is what it was without this module.
 *
 * @module wunderland/platform/config/operation-id
 */
import { randomUUID } from 'node:crypto';

/** The environment variable that names the operation id header. */
export const OPERATION_ID_HEADER_ENV = 'AGENTOS_OPERATION_ID_HEADER';

/** An HTTP field name: a token of RFC 9110, section 5.6.2. */
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Headers the request helpers or the transport set themselves, which an
 * operation id may not replace (compared lowercased).
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'content-type',
  'content-length',
  'host',
  'connection',
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'openai-organization',
  'http-referer',
  'x-title',
]);

/**
 * The name of the header an operation id goes in: `AGENTOS_OPERATION_ID_HEADER`,
 * trimmed, or none when it is unset or blank.
 *
 * @param env - The environment to read; `process.env` by default.
 * @returns The header name, or `undefined` when the variable names none.
 * @throws {RangeError} When the name is not an HTTP field name, or names a
 *   header the request helpers set (`Authorization`, `x-api-key`,
 *   `Content-Type`, ...).
 */
export function resolveOperationIdHeader(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const name = env[OPERATION_ID_HEADER_ENV]?.trim();
  if (!name) return undefined;
  if (!FIELD_NAME.test(name)) {
    throw new RangeError(`${OPERATION_ID_HEADER_ENV} "${name}" is not an HTTP header name.`);
  }
  if (RESERVED_HEADERS.has(name.toLowerCase())) {
    throw new RangeError(`${OPERATION_ID_HEADER_ENV} may not be "${name}", a header the request sets itself.`);
  }
  return name;
}

/**
 * The header one call sends on each of its attempts: the resolved name with a
 * new UUID, or no header when the variable names none. Call it once per call,
 * before the first attempt, and send the same object on every attempt.
 *
 * @param env - The environment to read; `process.env` by default.
 * @returns `{ [name]: uuid }`, or `{}`.
 * @throws {RangeError} As {@link resolveOperationIdHeader}.
 */
export function operationIdHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const name = resolveOperationIdHeader(env);
  return name ? { [name]: randomUUID() } : {};
}
