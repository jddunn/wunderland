/**
 * @fileoverview Tests for the NL intent classifier.
 *
 * Verifies that free-form user input is classified into the correct routing
 * intent (create, agency, mission, help, chat) using deterministic keyword
 * heuristics with no LLM dependency.
 *
 * @module wunderland/__tests__/nl-intent-classifier.test
 */

import { describe, it, expect } from 'vitest';
import { classifyIntent, INTENT_LABELS } from '../cli/nl-intent-classifier.js';

// ── Agent creation intents ─────────────────────────────────────────────────

describe('NL Intent Classifier', () => {
  describe('agent creation intents', () => {
    it('classifies "Build me a research agent" as create', () => {
      expect(classifyIntent('Build me a research agent')).toBe('create');
    });

    it('classifies "Create an AI assistant for customer support" as create', () => {
      expect(classifyIntent('Create an AI assistant for customer support')).toBe('create');
    });

    it('classifies "Make a bot that monitors HN" as create', () => {
      expect(classifyIntent('Make a bot that monitors HN')).toBe('create');
    });

    it('classifies "Deploy an agent for my SaaS" as create', () => {
      expect(classifyIntent('Deploy an agent for my SaaS')).toBe('create');
    });

    it('classifies "Generate a wunderbot for social media" as create', () => {
      expect(classifyIntent('Generate a wunderbot for social media')).toBe('create');
    });

    it('classifies "Scaffold a coding assistant" as create', () => {
      expect(classifyIntent('Scaffold a coding assistant')).toBe('create');
    });
  });

  // ── Team / agency creation intents ─────────────────────────────────────

  describe('team/agency intents', () => {
    it('classifies "Create a team: researcher, analyst, writer" as agency', () => {
      expect(classifyIntent('Create a team: researcher, analyst, writer')).toBe('agency');
    });

    it('classifies "Build a crew of agents for content creation" as agency', () => {
      expect(classifyIntent('Build a crew of agents for content creation')).toBe('agency');
    });

    it('classifies "Make a squad for DevOps monitoring" as agency', () => {
      expect(classifyIntent('Make a squad for DevOps monitoring')).toBe('agency');
    });

    it('classifies "Assemble a collective for research tasks" as agency', () => {
      expect(classifyIntent('Assemble a collective for research tasks')).toBe('agency');
    });

    it('classifies "Set up a group of agents for customer support" as agency', () => {
      expect(classifyIntent('Set up a group of agents for customer support')).toBe('agency');
    });

    it('prioritizes agency over create when team nouns are present', () => {
      // "Create a team" could match create (has "create") but team noun takes priority
      expect(classifyIntent('Create a team of agents for research')).toBe('agency');
    });
  });

  // ── Mission intents ────────────────────────────────────────────────────

  describe('mission intents', () => {
    it('classifies long research requests as mission', () => {
      expect(
        classifyIntent(
          'Research the top 5 AI frameworks and generate a comprehensive PDF report comparing their features'
        )
      ).toBe('mission');
    });

    it('classifies multi-step investigation requests as mission', () => {
      expect(
        classifyIntent(
          'Investigate the latest trends in machine learning and compile a detailed analysis of each approach'
        )
      ).toBe('mission');
    });

    it('classifies complex analysis requests as mission', () => {
      expect(
        classifyIntent(
          'Analyze the competitive landscape of AI coding assistants and compare their pricing models'
        )
      ).toBe('mission');
    });

    it('classifies "find and summarize" compound tasks as mission', () => {
      expect(
        classifyIntent(
          'Find and summarize the best practices for deploying large language models in production environments'
        )
      ).toBe('mission');
    });

    it('does not classify short research phrases as mission', () => {
      // Short inputs (under 50 chars) should not be classified as mission
      // even if they contain research verbs
      expect(classifyIntent('Research AI')).not.toBe('mission');
    });
  });

  // ── Help / question intents ────────────────────────────────────────────

  describe('help/question intents', () => {
    it('classifies "What models do you support?" as help', () => {
      expect(classifyIntent('What models do you support?')).toBe('help');
    });

    it('classifies "How do I add voice to my agent?" as help', () => {
      expect(classifyIntent('How do I add voice to my agent?')).toBe('help');
    });

    it('classifies "Can you explain the security tiers?" as help', () => {
      expect(classifyIntent('Can you explain the security tiers?')).toBe('help');
    });

    it('classifies "Where do I find the API docs?" as help', () => {
      expect(classifyIntent('Where do I find the API docs?')).toBe('help');
    });

    it('classifies "Is there a free tier?" as help', () => {
      expect(classifyIntent('Is there a free tier?')).toBe('help');
    });

    it('requires a question mark for help classification', () => {
      // Same words but no question mark -> defaults to chat
      expect(classifyIntent('What models do you support')).toBe('chat');
    });
  });

  // ── Chat / fallback intents ────────────────────────────────────────────

  describe('chat fallback intents', () => {
    it('defaults "Tell me about quantum computing" to chat', () => {
      expect(classifyIntent('Tell me about quantum computing')).toBe('chat');
    });

    it('defaults "Hello world" to chat', () => {
      expect(classifyIntent('Hello world')).toBe('chat');
    });

    it('defaults "Good morning" to chat', () => {
      expect(classifyIntent('Good morning')).toBe('chat');
    });

    it('defaults empty-ish input to chat', () => {
      expect(classifyIntent('hey')).toBe('chat');
    });

    it('defaults general statements to chat', () => {
      expect(classifyIntent('I really like this product')).toBe('chat');
    });
  });

  // ── INTENT_LABELS ──────────────────────────────────────────────────────

  describe('INTENT_LABELS', () => {
    it('maps all five intents to labels and commands', () => {
      expect(Object.keys(INTENT_LABELS)).toEqual(
        expect.arrayContaining(['create', 'agency', 'mission', 'chat', 'help'])
      );
    });

    it('each label has a non-empty label and command', () => {
      for (const intent of Object.values(INTENT_LABELS)) {
        expect(intent.label).toBeTruthy();
        expect(intent.command).toBeTruthy();
        expect(intent.command).toMatch(/^wunderland /);
      }
    });
  });
});
