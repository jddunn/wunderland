/**
 * @fileoverview Tests for CitizenModeGuardrail
 * @module wunderland/__tests__/CitizenModeGuardrail.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CitizenModeGuardrail } from '../guardrails/CitizenModeGuardrail.js';
import { ContextFirewall } from '../social/ContextFirewall.js';

describe('CitizenModeGuardrail', () => {
  describe('Public mode (Citizen)', () => {
    let guardrail: CitizenModeGuardrail;

    beforeEach(() => {
      const firewall = new ContextFirewall('seed-123', { mode: 'public' });
      guardrail = new CitizenModeGuardrail(firewall);
    });

    it('should block user prompts', () => {
      const result = guardrail.checkInput('Hello, post about AI', true);
      expect(result.action).toBe('BLOCK');
      expect(result.reason).toContain('blocked');
    });

    it('should block user prompts by default (isUserPrompt defaults to true)', () => {
      const result = guardrail.checkInput('Any text');
      expect(result.action).toBe('BLOCK');
    });

    it('should allow non-user-prompt input (system stimulus)', () => {
      const result = guardrail.checkInput('Stimulus data', false);
      expect(result.action).toBe('ALLOW');
    });

    it('should include metadata in block result', () => {
      const result = guardrail.checkInput('Hello', true);
      expect(result.metadata?.mode).toBe('public');
      expect(result.metadata?.guardrail).toBe('CitizenModeGuardrail');
    });

    it('should allow social_post tool', () => {
      const result = guardrail.checkToolCall('social_post');
      expect(result.action).toBe('ALLOW');
    });

    it('should block private tools', () => {
      const result = guardrail.checkToolCall('calendar');
      expect(result.action).toBe('BLOCK');
      expect(result.metadata?.toolId).toBe('calendar');
    });

    it('should allow stimulus processing', () => {
      const result = guardrail.checkStimulus();
      expect(result.action).toBe('ALLOW');
    });
  });

  describe('Private mode (Assistant)', () => {
    let guardrail: CitizenModeGuardrail;

    beforeEach(() => {
      const firewall = new ContextFirewall('seed-123', { mode: 'private' });
      guardrail = new CitizenModeGuardrail(firewall);
    });

    it('should allow user prompts', () => {
      const result = guardrail.checkInput('Hello, help me with code', true);
      expect(result.action).toBe('ALLOW');
    });

    it('should block stimulus processing', () => {
      const result = guardrail.checkStimulus();
      expect(result.action).toBe('BLOCK');
    });

    it('should allow private tools', () => {
      const result = guardrail.checkToolCall('calendar');
      expect(result.action).toBe('ALLOW');
    });

    it('should block social_post tool', () => {
      const result = guardrail.checkToolCall('social_post');
      expect(result.action).toBe('BLOCK');
    });
  });

  describe('Output checks', () => {
    let guardrail: CitizenModeGuardrail;

    beforeEach(() => {
      const firewall = new ContextFirewall('seed-123', { mode: 'public' });
      guardrail = new CitizenModeGuardrail(firewall);
    });

    it('should block empty output', () => {
      const result = guardrail.checkOutput('');
      expect(result.action).toBe('BLOCK');
    });

    it('should allow normal output', () => {
      const result = guardrail.checkOutput('This is a valid post.');
      expect(result.action).toBe('ALLOW');
    });

    it('should warn about very long output', () => {
      const longOutput = 'a'.repeat(15000);
      const result = guardrail.checkOutput(longOutput);
      expect(result.action).toBe('WARN');
      expect(result.reason).toContain('long');
    });
  });
});
