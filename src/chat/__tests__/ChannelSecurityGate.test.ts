// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { checkSecurity } from '../ChannelSecurityGate.js';

describe('ChannelSecurityGate', () => {
  it('allows all users when allowedUsers is empty', () => {
    expect(checkSecurity('anyone', []).allowed).toBe(true);
  });

  it('allows listed user', () => {
    expect(checkSecurity('123', ['123', '456']).allowed).toBe(true);
  });

  it('blocks unlisted user', () => {
    const result = checkSecurity('789', ['123', '456']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('authorized');
  });

  it('allows user by phone number format', () => {
    expect(checkSecurity('+15551234567', ['+15551234567']).allowed).toBe(true);
  });
});
