// @ts-nocheck
/**
 * @fileoverview Safe API key resolution for static, lazy, and async key sources.
 * @module wunderland/runtime/api-key-resolver
 */

export type ApiKeyInput =
  | string
  | Promise<string>
  | (() => string | Promise<string>);

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as any).then === 'function';
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'function') return 'function';
  if (isPromiseLike(value)) return 'promise-like';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export async function resolveApiKeyInput(
  input: unknown,
  opts: { source: string; allowEmpty?: boolean } = { source: 'api-key' },
): Promise<string> {
  let value = input;

  if (typeof value === 'function') {
    value = (value as (() => unknown))();
  }

  if (isPromiseLike(value)) {
    value = await value;
  }

  if (typeof value !== 'string') {
    throw new Error(`[${opts.source}] expected API key string, got ${describeValue(value)}.`);
  }

  const resolved = value.trim();
  if (!opts.allowEmpty && resolved.length === 0) {
    throw new Error(`[${opts.source}] API key is missing or empty.`);
  }

  return resolved;
}
