/**
 * @fileoverview Mission `tools:` allowlist parsing.
 *
 * Kept in its own module (no `@framers/agentos` imports) so the CLI can scope a
 * mission's tool set without pulling in the full compiler — and so the logic is
 * unit-testable in isolation.
 *
 * `mission run` previously ignored a mission's `tools:` field, loading every
 * curated tool with blanket auto-approval (Codex spec review F1). This is the
 * surgical parse the CLI uses to scope the runtime before graph execution.
 *
 * @module wunderland/autonomy/orchestration/mission-tools
 */
import yaml from 'yaml';

/**
 * Parse ONLY the `tools:` allowlist from a mission YAML.
 *
 * @param content Raw YAML mission document.
 * @returns The pack-id list, `undefined` when omitted (meaning "use the default
 *   curated set"), or `[]` for an explicit empty list.
 * @throws If `tools:` is present but is not a list.
 */
export function parseMissionTools(content: string): string[] | undefined {
  const doc = yaml.parse(content) as { tools?: unknown } | null;
  if (!doc || !('tools' in doc) || doc.tools == null) return undefined;
  if (!Array.isArray(doc.tools)) {
    throw new Error('mission `tools:` must be a list of curated tool/pack ids');
  }
  return doc.tools.map((t: unknown) => String(t));
}
