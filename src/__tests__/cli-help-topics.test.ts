// @ts-nocheck
import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';

import { printHelpTopic, printHelpTopicsList } from '../cli/help/topics.js';

function captureLogs(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('CLI help topics', () => {
  beforeAll(() => {
    // Make output stable for assertions (no ANSI color).
    chalk.level = 0;
  });

  it('prints the topics list with examples', () => {
    const out = captureLogs(() => printHelpTopicsList());
    expect(out).toContain('Topics:');
    expect(out).toContain('getting-started');
    expect(out).toContain('wunderland help getting-started');
  });

  it('prints the presets guide using built-in preset ids', () => {
    const out = captureLogs(() => printHelpTopic('presets'));
    expect(out).toContain('--preset research-assistant');
  });

  it('prints the getting started guide with quickstart, doctor, and provider default guidance', () => {
    const out = captureLogs(() => printHelpTopic('getting-started'));
    expect(out).toContain('wunderland quickstart');
    expect(out).toContain('wunderland doctor');
    expect(out).toContain('wunderland extensions configure');
    expect(out).toContain('wunderland help tui');
  });

  it('prints the TUI guide with drilldown details/help modals', () => {
    const out = captureLogs(() => printHelpTopic('tui'));
    expect(out.toLowerCase()).toContain('drilldowns');
    expect(out.toLowerCase()).toContain('details');
    expect(out).toContain('?');
  });

  it('prints the FAQ with image generation provider guidance', () => {
    const out = captureLogs(() => printHelpTopic('faq'));
    expect(out).toContain('wunderland extensions configure');
    expect(out).toContain('image generation provider');
    expect(out).toContain('wunderland extensions info image-generation');
  });

  it('prints the security guide with guardrail override guidance', () => {
    const out = captureLogs(() => printHelpTopic('security'));
    expect(out).toContain('--llm-judge');
    expect(out).toContain('--no-guardrail-override');
  });

  it('prints the workflows guide with orchestration guidance', () => {
    const out = captureLogs(() => printHelpTopic('workflows'));
    expect(out).toContain(`wunderland/workflows`);
    expect(out).toContain('app.runGraph');
    expect(out).toContain('judge');
  });

  it('prints a warning for unknown topics', () => {
    const out = captureLogs(() => printHelpTopic('does-not-exist'));
    expect(out.toLowerCase()).toContain('unknown help topic');
  });
});
