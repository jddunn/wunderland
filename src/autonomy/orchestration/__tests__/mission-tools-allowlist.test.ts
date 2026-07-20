import { describe, it, expect } from 'vitest';
import { parseMissionTools } from '../mission-tools.js';

describe('parseMissionTools', () => {
  it('returns the tools array when present', () => {
    const yaml = 'name: m\ngoal: x\nplanner:\n  strategy: linear\ntools:\n  - cli-executor\n  - web-search\n';
    expect(parseMissionTools(yaml)).toEqual(['cli-executor', 'web-search']);
  });

  it('returns undefined (meaning: default set) when tools is omitted', () => {
    expect(parseMissionTools('name: m\ngoal: x\nplanner:\n  strategy: linear\n')).toBeUndefined();
  });

  it('returns an empty array for an explicit empty tools list', () => {
    expect(parseMissionTools('name: m\ngoal: x\nplanner:\n  strategy: linear\ntools: []\n')).toEqual([]);
  });

  it('coerces non-string entries to strings', () => {
    expect(parseMissionTools('goal: x\nplanner:\n  strategy: linear\ntools:\n  - 123\n')).toEqual(['123']);
  });

  it('throws when tools is present but not a list', () => {
    expect(() => parseMissionTools('goal: x\nplanner:\n  strategy: linear\ntools: cli-executor\n')).toThrow(
      /must be a list/i,
    );
  });
});
