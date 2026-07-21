import { describe, it, expect } from 'vitest';
import { attachOptionsFromEnv } from '../attach-env.js';

describe('attachOptionsFromEnv', () => {
  it('returns {} (attach off) when no identity is set', () => {
    expect(attachOptionsFromEnv({})).toEqual({});
    expect(attachOptionsFromEnv({ WUNDERLAND_ATTACH_TRANSPORT: 'cdp' })).toEqual({});
  });

  it('enables attach with just the identity', () => {
    expect(attachOptionsFromEnv({ WUNDERLAND_ATTACH_IDENTITY: 'you@gmail.com' })).toEqual({
      attach: { expectedIdentity: 'you@gmail.com' },
    });
  });

  it('parses transport, host allowlist, and paths', () => {
    const out = attachOptionsFromEnv({
      WUNDERLAND_ATTACH_IDENTITY: 'you@gmail.com',
      WUNDERLAND_ATTACH_TRANSPORT: 'cdp',
      WUNDERLAND_ATTACH_HOSTS: 'founderscard.com, hotels.com , ',
      WUNDERLAND_ATTACH_LEASE: '/tmp/x.lease',
      WUNDERLAND_ATTACH_PROFILE_ROOT: '/root',
    });
    expect(out.attach).toMatchObject({
      expectedIdentity: 'you@gmail.com',
      transport: 'cdp',
      allowHosts: ['founderscard.com', 'hotels.com'],
      leaseFile: '/tmp/x.lease',
      profileRoot: '/root',
    });
  });

  it('ignores an unknown transport value', () => {
    expect(attachOptionsFromEnv({ WUNDERLAND_ATTACH_IDENTITY: 'x', WUNDERLAND_ATTACH_TRANSPORT: 'bogus' }).attach)
      .toEqual({ expectedIdentity: 'x' });
  });

  it('parses dry-run and deadline knobs', () => {
    const a = attachOptionsFromEnv({
      WUNDERLAND_ATTACH_IDENTITY: 'x',
      WUNDERLAND_ATTACH_DRYRUN: 'true',
      WUNDERLAND_ATTACH_DEADLINE_MS: '20000',
    }).attach;
    expect(a).toMatchObject({ dryRun: true, deadlineMs: 20000 });
  });

  it('ignores a non-positive or non-numeric deadline', () => {
    expect(attachOptionsFromEnv({ WUNDERLAND_ATTACH_IDENTITY: 'x', WUNDERLAND_ATTACH_DEADLINE_MS: 'nope' }).attach)
      .toEqual({ expectedIdentity: 'x' });
    expect(attachOptionsFromEnv({ WUNDERLAND_ATTACH_IDENTITY: 'x', WUNDERLAND_ATTACH_DEADLINE_MS: '0' }).attach)
      .toEqual({ expectedIdentity: 'x' });
  });
});
