/**
 * @fileoverview Unit tests for NaturalLanguageAgentBuilder
 * @module wunderland/ai/__tests__/NaturalLanguageAgentBuilder
 */

import { describe, it, expect, vi } from 'vitest';
import { extractAgentConfig, validateApiKeySetup } from '../NaturalLanguageAgentBuilder.js';

describe('NaturalLanguageAgentBuilder', () => {
  describe('validateApiKeySetup', () => {
    it('should validate OpenAI API key format', () => {
      expect(validateApiKeySetup('openai', 'sk-proj-1234567890')).toBe(true);
      expect(validateApiKeySetup('openai', 'sk-1234567890')).toBe(true);
      expect(validateApiKeySetup('openai', 'invalid-key')).toBe(false);
      expect(validateApiKeySetup('openai', '')).toBe(false);
    });

    it('should validate Anthropic API key format', () => {
      expect(validateApiKeySetup('anthropic', 'sk-ant-1234567890')).toBe(true);
      expect(validateApiKeySetup('anthropic', 'sk-1234567890')).toBe(false);
      expect(validateApiKeySetup('anthropic', '')).toBe(false);
    });

    it('should validate Groq API key format', () => {
      expect(validateApiKeySetup('groq', 'gsk_1234567890')).toBe(true);
      expect(validateApiKeySetup('groq', 'invalid')).toBe(false);
    });

    it('should always return true for Ollama (no key needed)', () => {
      expect(validateApiKeySetup('ollama', '')).toBe(false); // Still needs non-empty
      expect(validateApiKeySetup('ollama', 'any-string')).toBe(true);
    });

    it('should handle unknown providers with generic check', () => {
      expect(validateApiKeySetup('unknown-provider', 'some-long-key')).toBe(true);
      expect(validateApiKeySetup('unknown-provider', 'short')).toBe(false); // < 10 chars
    });
  });

  describe('extractAgentConfig', () => {
    it('should extract basic agent configuration', async () => {
      const mockLLM = vi.fn(async () =>
        JSON.stringify({
          displayName: 'Research Bot',
          bio: 'Helps with research tasks',
          preset: 'research-assistant',
          skills: ['web-search', 'summarize'],
          extensions: {
            tools: ['web-search', 'web-browser'],
            voice: [],
            productivity: [],
          },
          securityTier: 'balanced',
          permissionSet: 'supervised',
          toolAccessProfile: 'assistant',
          executionMode: 'human-dangerous',
          confidence: {
            displayName: 0.95,
            preset: 0.9,
            skills: 0.85,
          },
        })
      );

      const result = await extractAgentConfig(
        'I need a research bot that searches the web and summarizes articles',
        mockLLM
      );

      expect(result.displayName).toBe('Research Bot');
      expect(result.preset).toBe('research-assistant');
      expect(result.skills).toContain('web-search');
      expect(result.extensions?.tools).toContain('web-search');
      expect(result.confidence?.displayName).toBe(0.95);
    });

    it('should throw error for empty description', async () => {
      const mockLLM = vi.fn();

      await expect(extractAgentConfig('', mockLLM)).rejects.toThrow('Description cannot be empty');
      expect(mockLLM).not.toHaveBeenCalled();
    });

    it('should validate preset names', async () => {
      const mockLLM = vi.fn(async () =>
        JSON.stringify({
          displayName: 'Test Bot',
          preset: 'invalid-preset-name',
          securityTier: 'balanced',
        })
      );

      const result = await extractAgentConfig('Test bot', mockLLM);

      // Invalid preset should be removed
      expect(result.preset).toBeUndefined();
    });

    it('should validate security tiers', async () => {
      const mockLLM = vi.fn(async () =>
        JSON.stringify({
          displayName: 'Test Bot',
          securityTier: 'invalid-tier',
        })
      );

      const result = await extractAgentConfig('Test bot', mockLLM);

      // Should default to balanced for invalid tier
      expect(result.securityTier).toBe('balanced');
    });

    it('should auto-generate seedId from displayName', async () => {
      const mockLLM = vi.fn(async () =>
        JSON.stringify({
          displayName: 'My Research Assistant',
        })
      );

      const result = await extractAgentConfig('Test bot', mockLLM);

      expect(result.seedId).toBe('seed_my_research_assistant');
    });

    it('should handle hosted mode restrictions', async () => {
      const mockLLM = vi.fn(async (prompt: string) => {
        // Verify prompt includes hosted mode restrictions
        expect(prompt).toContain('managed runtime');
        expect(prompt).toContain('cli-executor');

        return JSON.stringify({
          displayName: 'Managed Bot',
          extensions: {
            tools: ['web-search'], // Should not suggest cli-executor
            voice: [],
            productivity: [],
          },
        });
      });

      const result = await extractAgentConfig('Test bot', mockLLM, undefined, 'managed');

      expect(mockLLM).toHaveBeenCalled();
      expect(result.displayName).toBe('Managed Bot');
    });

    it('should merge with existing config in update mode', async () => {
      const existingConfig = {
        displayName: 'Existing Bot',
        bio: 'Old bio',
        securityTier: 'strict' as const,
      };

      const mockLLM = vi.fn(async (prompt: string) => {
        // Verify prompt includes existing config
        expect(prompt).toContain('Existing Bot');
        expect(prompt).toContain('strict');

        return JSON.stringify({
          bio: 'Updated bio',
          skills: ['new-skill'],
        });
      });

      await extractAgentConfig('Update bio', mockLLM, existingConfig);

      expect(mockLLM).toHaveBeenCalled();
      const promptArg = mockLLM.mock.calls[0][0];
      expect(promptArg).toContain('Existing config');
    });

    it('should handle LLM errors gracefully', async () => {
      const mockLLM = vi.fn(async () => {
        throw new Error('LLM service timeout');
      });

      await expect(extractAgentConfig('Test bot', mockLLM)).rejects.toThrow('Failed to extract config');
    });

    it('should handle invalid JSON responses', async () => {
      const mockLLM = vi.fn(async () => 'not valid json');

      await expect(extractAgentConfig('Test bot', mockLLM)).rejects.toThrow();
    });

    it('should set default values for missing critical fields', async () => {
      const mockLLM = vi.fn(async () =>
        JSON.stringify({
          displayName: 'Minimal Bot',
          // No security/permission fields
        })
      );

      const result = await extractAgentConfig('Test bot', mockLLM);

      expect(result.securityTier).toBe('balanced');
      expect(result.permissionSet).toBe('supervised');
      expect(result.toolAccessProfile).toBe('assistant');
      expect(result.executionMode).toBe('human-dangerous');
    });

    it('should validate tool access profiles', async () => {
      const mockLLM = vi.fn(async () =>
        JSON.stringify({
          displayName: 'Test Bot',
          toolAccessProfile: 'invalid-profile',
        })
      );

      const result = await extractAgentConfig('Test bot', mockLLM);

      // Should default to assistant for invalid profile
      expect(result.toolAccessProfile).toBe('assistant');
    });

    it('should extract personality traits', async () => {
      const mockLLM = vi.fn(async () =>
        JSON.stringify({
          displayName: 'Personality Bot',
          personality: {
            honesty: 0.8,
            emotionality: 0.6,
            extraversion: 0.75,
            agreeableness: 0.85,
            conscientiousness: 0.9,
            openness: 0.7,
          },
        })
      );

      const result = await extractAgentConfig('Bot with personality', mockLLM);

      expect(result.personality).toBeDefined();
      expect(result.personality?.honesty).toBe(0.8);
      expect(result.personality?.openness).toBe(0.7);
    });
  });
});
