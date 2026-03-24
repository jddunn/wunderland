import { beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { printHelpTopic } from '../help/topics.js';

function captureLogs(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('CLI help topic rendering', () => {
  beforeAll(() => {
    chalk.level = 0;
  });

  it('renders the getting-started topic with quickstart and provider-default guidance', () => {
    const output = captureLogs(() => printHelpTopic('getting-started'));
    expect(output).toContain('wunderland quickstart');
    expect(output).toContain('wunderland doctor');
    expect(output).toContain('wunderland extensions configure');
    expect(output).toContain('wunderland help tui');
  });

  it('renders the FAQ topic with image-generation guidance', () => {
    const output = captureLogs(() => printHelpTopic('faq'));
    expect(output).toContain('wunderland extensions configure');
    expect(output).toContain('image generation provider');
    expect(output).toContain('wunderland extensions info image-generation');
  });

  it('renders the workflows topic with orchestration guidance', () => {
    const output = captureLogs(() => printHelpTopic('workflows'));
    expect(output).toContain(`wunderland/workflows`);
    expect(output).toContain('app.runGraph');
    expect(output).toContain('scratch.judge');
  });
});
