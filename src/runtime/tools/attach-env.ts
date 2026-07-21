/**
 * @fileoverview Build browser-automation attach options from the environment.
 *
 * The attach tool family (`browser_attach_*`) is off unless the pack is
 * constructed with `attach.expectedIdentity`. A normal `wunderland mission run`
 * never passes that, so without this the tools would never load from the CLI.
 * This sources the attach config from env vars (mirroring how voice-synthesis
 * pulls its provider keys) so setting `WUNDERLAND_ATTACH_IDENTITY` is all it
 * takes to make the capability reachable.
 *
 * @module wunderland/runtime/tools/attach-env
 */

/** Attach options shape consumed by the browser-automation pack. */
export interface AttachOptions {
  expectedIdentity: string;
  transport?: 'jxa' | 'cdp';
  allowHosts?: string[];
  leaseFile?: string;
  profileRoot?: string;
  identityProbeUrl?: string;
  dryRun?: boolean;
  deadlineMs?: number;
}

/**
 * Read attach options from an environment map.
 *
 * @returns `{ attach }` when `WUNDERLAND_ATTACH_IDENTITY` is set, else `{}`
 *   (attach stays off).
 */
export function attachOptionsFromEnv(env: Record<string, string | undefined>): { attach?: AttachOptions } {
  const expectedIdentity = env.WUNDERLAND_ATTACH_IDENTITY?.trim();
  if (!expectedIdentity) return {};
  const attach: AttachOptions = { expectedIdentity };
  if (env.WUNDERLAND_ATTACH_TRANSPORT === 'cdp') attach.transport = 'cdp';
  else if (env.WUNDERLAND_ATTACH_TRANSPORT === 'jxa') attach.transport = 'jxa';
  const hosts = env.WUNDERLAND_ATTACH_HOSTS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (hosts && hosts.length) attach.allowHosts = hosts;
  if (env.WUNDERLAND_ATTACH_LEASE?.trim()) attach.leaseFile = env.WUNDERLAND_ATTACH_LEASE.trim();
  if (env.WUNDERLAND_ATTACH_PROFILE_ROOT?.trim()) attach.profileRoot = env.WUNDERLAND_ATTACH_PROFILE_ROOT.trim();
  if (env.WUNDERLAND_ATTACH_PROBE_URL?.trim()) attach.identityProbeUrl = env.WUNDERLAND_ATTACH_PROBE_URL.trim();
  if (env.WUNDERLAND_ATTACH_DRYRUN === '1' || env.WUNDERLAND_ATTACH_DRYRUN === 'true') attach.dryRun = true;
  const deadline = Number(env.WUNDERLAND_ATTACH_DEADLINE_MS);
  if (Number.isFinite(deadline) && deadline > 0) attach.deadlineMs = deadline;
  return { attach };
}
