// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { describeCreateConfidence } from '../commands/create.js';

describe('describeCreateConfidence', () => {
  it('returns null when confidence is missing', () => {
    expect(describeCreateConfidence(undefined)).toBeNull();
  });

  it('classifies high confidence values', () => {
    expect(describeCreateConfidence(0.91)).toEqual({ level: 'high', percent: 91 });
  });

  it('classifies medium confidence values', () => {
    expect(describeCreateConfidence(0.65)).toEqual({ level: 'medium', percent: 65 });
  });

  it('classifies low confidence values', () => {
    expect(describeCreateConfidence(0.42)).toEqual({ level: 'low', percent: 42 });
  });

  it('clamps confidence percentages into a display-safe range', () => {
    expect(describeCreateConfidence(1.5)).toEqual({ level: 'high', percent: 100 });
    expect(describeCreateConfidence(-0.2)).toEqual({ level: 'low', percent: 0 });
  });
});
