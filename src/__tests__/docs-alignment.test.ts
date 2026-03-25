import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function read(relativeToThisFile: string): string {
  return readFileSync(new URL(relativeToThisFile, import.meta.url), 'utf8');
}

describe('Wunderland docs alignment', () => {
  it('keeps the package README aligned with first-run and image-generation guidance', () => {
    const readme = read('../../README.md');
    expect(readme).toContain('wunderland quickstart');
    expect(readme).toContain('wunderland help getting-started');
    expect(readme).toContain('wunderland help workflows');
    expect(readme).toContain('wunderland extensions configure');
    expect(readme).toContain('examples/library-chat-image-generation.mjs');
    expect(readme).toContain('examples/workflow-orchestration.mjs');
    expect(readme).toContain('./logs/YYYY-MM-DD/*.log');
  });

  it('keeps the CLI/TUI guide aligned with help topics and provider-default commands', () => {
    const guide = read('../../docs/CLI_TUI_GUIDE.md');
    expect(guide).toContain('wunderland help tui');
    expect(guide).toContain('wunderland help workflows');
    expect(guide).toContain('wunderland extensions configure');
    expect(guide).toContain('wunderland extensions info image-generation');
    expect(guide).toContain('replicate');
    expect(guide).toContain('./logs/YYYY-MM-DD/*.log');
  });

  it('keeps the live docs quickstart and operator guides aligned with the current CLI surface', () => {
    const quickstart = read('../../../../apps/wunderland-live-docs/docs/getting-started/quickstart.md');
    const cliGuide = read('../../../../apps/wunderland-live-docs/docs/guides/cli-reference.md');
    const cliReference = read('../../../../apps/wunderland-live-docs/docs/api/cli-reference.md');

    expect(quickstart).toContain('wunderland quickstart');
    expect(quickstart).toContain('./logs/YYYY-MM-DD/*.log');
    expect(quickstart).toContain('wunderland extensions configure');
    expect(cliGuide).toContain('wunderland extensions info image-generation');
    expect(cliGuide).toContain('wunderland quickstart');
    expect(cliReference).toContain('wunderland extensions enable web-search');
    expect(cliReference).toContain('wunderland skills enable summarize');
    expect(cliReference).toContain('wunderland workflows examples');
    expect(cliReference).toContain('./logs/YYYY-MM-DD/*.log');
  });

  it('keeps troubleshooting and the docs homepage aligned with image-generation onboarding', () => {
    const troubleshooting = read('../../../../apps/wunderland-live-docs/docs/guides/troubleshooting.md');
    const homepage = read('../../../../apps/wunderland-live-docs/src/pages/index.tsx');
    const scheduling = read('../../../../apps/wunderland-live-docs/docs/guides/scheduling.md');

    expect(troubleshooting).toContain('REPLICATE_API_TOKEN');
    expect(troubleshooting).toContain('wunderland extensions configure');
    expect(homepage).toContain('Start Here');
    expect(homepage).toContain('wunderland/workflows');
    expect(homepage).toContain('/guides/image-generation');
    expect(scheduling).toContain('app.runGraph');
    expect(scheduling).toContain('LLM-as-Judge');
  });
});
