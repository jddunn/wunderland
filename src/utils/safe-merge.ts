/**
 * @fileoverview Safe deep merge utility — prototype pollution prevention
 * @module wunderland/utils/safe-merge
 *
 * Provides safe object merging that rejects prototype-polluting keys
 * (__proto__, constructor, prototype) to prevent prototype pollution attacks.
 *
 * Ported from OpenClaw upstream security fix (openclaw#20853).
 */

/**
 * Set of keys that must never be merged into objects.
 * These keys could be used for prototype pollution attacks.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Checks whether a key is safe to merge (not a prototype-polluting key).
 */
export function isSafeKey(key: string): boolean {
  return !DANGEROUS_KEYS.has(key);
}

/**
 * Returns true if the value is a plain object (not an array, Date, RegExp, etc.).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Safely deep-merges `source` into `target`, returning a new object.
 *
 * - Rejects keys in {@link DANGEROUS_KEYS} at every nesting level.
 * - Only recurses into plain objects (arrays, Dates, etc. are replaced wholesale).
 * - Immutable: returns a new object tree; neither `target` nor `source` is mutated.
 *
 * @param target - Base object
 * @param source - Object to merge on top
 * @returns New merged object
 * @throws {Error} If a prototype-polluting key is detected
 *
 * @example
 * ```typescript
 * const base = { a: 1, nested: { b: 2 } };
 * const overlay = { nested: { c: 3 }, d: 4 };
 * const result = safeDeepMerge(base, overlay);
 * // → { a: 1, nested: { b: 2, c: 3 }, d: 4 }
 *
 * // Throws on dangerous keys:
 * safeDeepMerge({}, { __proto__: { admin: true } }); // Error!
 * ```
 */
export function safeDeepMerge<
  T extends Record<string, unknown>,
  S extends Record<string, unknown>,
>(target: T, source: S): T & S {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    if (!isSafeKey(key)) {
      throw new Error(
        `safeDeepMerge: rejecting prototype-polluting key "${key}"`
      );
    }

    const sourceVal = source[key];
    const targetVal = result[key];

    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      result[key] = safeDeepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }

  return result as T & S;
}

/**
 * Like {@link safeDeepMerge} but silently drops dangerous keys instead of throwing.
 *
 * Useful for sanitising untrusted input before further processing.
 */
export function safeDeepMergeSilent<
  T extends Record<string, unknown>,
  S extends Record<string, unknown>,
>(target: T, source: S): T & S {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    if (!isSafeKey(key)) continue; // silently skip

    const sourceVal = source[key];
    const targetVal = result[key];

    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      result[key] = safeDeepMergeSilent(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }

  return result as T & S;
}

/**
 * Recursively strips prototype-polluting keys from an object tree.
 *
 * Returns a new object; the original is not mutated.
 */
export function stripDangerousKeys<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    if (!isSafeKey(key)) continue;

    const val = obj[key];
    if (isPlainObject(val)) {
      result[key] = stripDangerousKeys(val);
    } else {
      result[key] = val;
    }
  }

  return result as T;
}
