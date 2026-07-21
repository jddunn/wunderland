import { describe, it, expect } from 'vitest';
import {
  buildPdfArgs,
  csvField,
  htmlEscape,
  toCsv,
  toHtml,
  toInteractiveHtml,
  type ReportDataset,
} from '../report-export.js';

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

describe('toInteractiveHtml', () => {
  it('is a self-contained document with no external resources', () => {
    const html = toInteractiveHtml(ds, { stats: [{ label: 'rows', value: '2' }] });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js|woff2?)/);
    expect(html).not.toContain('<link rel="stylesheet" href="http');
  });
  it('embeds the row data and column metadata for client-side rendering', () => {
    const html = toInteractiveHtml(ds, { columns: [{ key: 'rate', numeric: true, heat: 'lower-better' }] });
    expect(html).toContain('const DATA =');
    expect(html).toContain('"numeric":true');
    expect(html).toContain('"heat":"lower-better"');
  });
  it('ships sort, search, theme-toggle, and CSV-export controls', () => {
    const html = toInteractiveHtml(ds);
    expect(html).toContain('id="q"'); // search box
    expect(html).toContain('id="themeBtn"'); // theme toggle
    expect(html).toContain('id="csvBtn"'); // client CSV export
    expect(html).toContain('.onclick'); // sortable headers wired
  });
  it('escapes </script> in embedded data to prevent breakout', () => {
    const evil: ReportDataset = { title: 't', columns: ['x'], rows: [{ x: '</script><img>' }] };
    const html = toInteractiveHtml(evil);
    expect(html).not.toContain('</script><img>');
    expect(html).toContain('\\u003c/script>');
  });
  it('honors an explicit theme', () => {
    expect(toInteractiveHtml(ds, { theme: 'dark' })).toContain("setAttribute('data-theme', \"dark\")");
    expect(toInteractiveHtml(ds, { theme: 'auto' })).not.toContain("setAttribute('data-theme', \"auto\")");
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
