import { describe, expect, it } from 'vitest';

import { getImageGenerationProviderDefaultChoices } from '../commands/extensions.js';

describe('image generation provider defaults', () => {
  it('offers all supported provider choices', () => {
    const options = getImageGenerationProviderDefaultChoices();
    expect(options.map((option) => option.value)).toEqual([
      'openai',
      'openrouter',
      'stability',
      'replicate',
      '_none',
    ]);
  });

  it('marks the current provider in the prompt choices', () => {
    const options = getImageGenerationProviderDefaultChoices('replicate');
    expect(options.find((option) => option.value === 'replicate')?.hint).toBe('current');
    expect(options.find((option) => option.value === 'openai')?.hint).toBeUndefined();
  });
});
