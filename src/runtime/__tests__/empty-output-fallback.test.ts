// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { synthesizeEmptyOutputFallback } from '../empty-output-fallback.js';

describe('synthesizeEmptyOutputFallback', () => {
  it('returns an empty string when no tool activity happened', () => {
    const out = synthesizeEmptyOutputFallback({ results: [], errors: [], iterationsExhausted: false });
    expect(out).toBe('');
  });

  it('includes successful tool results with their names and content', () => {
    const out = synthesizeEmptyOutputFallback({
      results: [
        { name: 'web_search', content: 'Two relevant URLs about meme research.' },
        { name: 'web_scrape', content: 'Scraped trending memes 2026' },
      ],
      errors: [],
      iterationsExhausted: false,
    });
    expect(out).toContain('Tool: web_search');
    expect(out).toContain('Two relevant URLs');
    expect(out).toContain('Tool: web_scrape');
    expect(out).toContain('Scraped trending memes');
  });

  it('uses the iterations-exhausted header when the loop hit max iterations', () => {
    const out = synthesizeEmptyOutputFallback({
      results: [{ name: 'web_search', content: 'data' }],
      errors: [],
      iterationsExhausted: true,
    });
    expect(out).toMatch(/max[_-]?iterations[_-]?reached/i);
  });

  it('uses the no-text header when iterations did not exhaust', () => {
    const out = synthesizeEmptyOutputFallback({
      results: [{ name: 'web_search', content: 'data' }],
      errors: [],
      iterationsExhausted: false,
    });
    expect(out).toMatch(/no text response/i);
  });

  it('surfaces tool errors when no successful results were captured', () => {
    const out = synthesizeEmptyOutputFallback({
      results: [],
      errors: [
        { name: 'web_search', error: 'rate limit exceeded' },
        { name: 'image_search', error: 'auth failed' },
      ],
      iterationsExhausted: true,
    });
    expect(out).toContain('Tool: web_search');
    expect(out).toContain('rate limit exceeded');
    expect(out).toContain('Tool: image_search');
    expect(out).toContain('auth failed');
  });

  it('sanitises tool names with newlines and backticks before interpolation', () => {
    const out = synthesizeEmptyOutputFallback({
      results: [{ name: 'evil`tool\n# fake-heading', content: 'data' }],
      errors: [],
      iterationsExhausted: false,
    });
    const toolLines = out.split('\n').filter((l) => l.startsWith('Tool: '));
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).not.toContain('`');
    // Markdown headings only fire at line start — the fragment in the
    // middle of a line is harmless, but a newline-promoted heading is not.
    expect(out.match(/^# fake-heading/m)).toBeNull();
  });

  it('caps total output size with a [fallback truncated] marker', () => {
    const big = 'x'.repeat(4000);
    const results = Array.from({ length: 10 }, (_, i) => ({ name: `tool_${i}`, content: big }));
    const out = synthesizeEmptyOutputFallback({
      results,
      errors: [],
      iterationsExhausted: true,
    });
    // Generous slack; default total cap is 16000 chars.
    expect(out.length).toBeLessThan(20000);
    expect(out).toContain('[fallback truncated]');
  });

  it('treats unnamed tools (empty/whitespace name) gracefully', () => {
    const out = synthesizeEmptyOutputFallback({
      results: [{ name: '', content: 'data' }],
      errors: [],
      iterationsExhausted: false,
    });
    expect(out).toContain('Tool: unnamed-tool');
    expect(out).toContain('data');
  });
});
