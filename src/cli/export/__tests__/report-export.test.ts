import { describe, it, expect } from 'vitest';
import { buildPdfArgs, csvField, htmlEscape, toCsv, toHtml, type ReportDataset } from '../report-export.js';

const ds: ReportDataset = {
  title: 'LA Hotels',
  summary: 'Member rates, both windows',
  columns: ['hotel', 'rate', 'note'],
  rows: [
    { hotel: "L'Ermitage", rate: '$395', note: 'save up to 60%' },
    { hotel: 'The "LINE"', rate: '$126', note: 'a, b\nc' },
  ],
};

describe('csvField', () => {
  it('leaves simple values bare', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
  });
  it('quotes and escapes commas, quotes, and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });
});

describe('toCsv', () => {
  it('emits a header row plus one row per record with escaping', () => {
    const csv = toCsv(ds);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('hotel,rate,note');
    expect(lines[1]).toBe("L'Ermitage,$395,save up to 60%");
    expect(csv).toContain('"The ""LINE"""');
    expect(csv).toContain('"a, b\nc"');
  });
  it('emits just the header for an empty dataset', () => {
    expect(toCsv({ title: 't', columns: ['a', 'b'], rows: [] })).toBe('a,b\n');
  });
});

describe('htmlEscape + toHtml', () => {
  it('escapes angle brackets and ampersands', () => {
    expect(htmlEscape('<b> & </b>')).toBe('&lt;b&gt; &amp; &lt;/b&gt;');
  });
  it('produces a print-safe self-contained document', () => {
    const html = toHtml(ds);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('box-shadow:none');
    expect(html).toContain('<th>hotel</th>');
    expect(html).toContain('Member rates, both windows');
    // no external resources
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js|woff)/);
  });
});

describe('buildPdfArgs', () => {
  it('targets an isolated throwaway profile dir, never the live profile', () => {
    const args = buildPdfArgs('/tmp/w/report.html', '/tmp/w/out.pdf', '/tmp/w/chrome-profile');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--user-data-dir=/tmp/w/chrome-profile');
    expect(args).toContain('--print-to-pdf=/tmp/w/out.pdf');
    expect(args[args.length - 1]).toBe('file:///tmp/w/report.html');
    // must never point Chrome at the user's real profile
    expect(args.join(' ')).not.toContain('Library/Application Support/Google/Chrome');
  });
});
