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

// ---------------------------------------------------------------------------
// Untrusted data: the module is a public entry (wunderland/report), so row
// values, column metadata and the basename can come from scraped pages.
// ---------------------------------------------------------------------------

/** Minimal DOM stand-in that records every innerHTML write. */
function fakeDom() {
  const htmlWrites: string[] = [];
  const downloads: string[] = [];
  const all: any[] = [];
  const make = (tag: string): any => {
    const e: any = {
      tag,
      children: [] as any[],
      attrs: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      style: { cssText: '' },
      className: '',
      text: '',
      onclick: null,
      set innerHTML(v: string) {
        htmlWrites.push(String(v));
        e.children = [];
      },
      get innerHTML() {
        return '';
      },
      set textContent(v: string) {
        e.text = String(v);
        e.children = [];
      },
      get textContent() {
        return e.text + e.children.map((c: any) => c.textContent).join('');
      },
      appendChild(c: any) {
        e.children.push(c);
        return c;
      },
      append(...cs: any[]) {
        for (const c of cs) e.children.push(typeof c === 'string' ? { tag: '#text', textContent: c } : c);
      },
      replaceChildren(...cs: any[]) {
        e.children = [];
        e.append(...cs);
      },
      setAttribute(k: string, v: string) {
        e.attrs[k] = String(v);
      },
      getAttribute(k: string) {
        return e.attrs[k] ?? null;
      },
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      click() {},
    };
    all.push(e);
    return e;
  };
  const byId = new Map<string, any>();
  const document = {
    documentElement: make('html'),
    getElementById(id: string) {
      if (!byId.has(id)) byId.set(id, make(id));
      return byId.get(id);
    },
    createElement: make,
    createTextNode: (t: string) => ({ tag: '#text', textContent: String(t) }),
  };
  class FakeBlob {
    constructor(parts: string[]) {
      downloads.push(parts.join(''));
    }
  }
  const sandbox = {
    document,
    matchMedia: () => ({ matches: false }),
    URL: { createObjectURL: () => 'blob:x' },
    Blob: FakeBlob,
  };
  return { sandbox, htmlWrites, downloads, all, byId };
}

async function runInteractive(html: string) {
  const { runInNewContext } = await import('node:vm');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const dom = fakeDom();
  runInNewContext(script, dom.sandbox);
  return dom;
}

describe('toInteractiveHtml with untrusted values', () => {
  const evil: ReportDataset = {
    title: 't',
    columns: ['<img src=x onerror=alert(1)>', 'k" onmouseover="alert(2)'],
    rows: [{ '<img src=x onerror=alert(1)>': '<svg onload=alert(3)>', 'k" onmouseover="alert(2)': '=1+1' }],
  };

  it('never turns a column key, label or row value into markup', async () => {
    const html = toInteractiveHtml(evil, {
      columns: [
        { key: '<img src=x onerror=alert(1)>', label: '<b onclick=alert(4)>label</b>' },
        { key: 'k" onmouseover="alert(2)' },
      ],
    });
    const dom = await runInteractive(html);
    const written = dom.htmlWrites.join('\n');
    expect(written).not.toMatch(/<img|<svg|<b |onmouseover|onerror|onclick/);
    // The values still reach the page, as text.
    const text = dom.byId.get('thead').textContent + dom.byId.get('tbody').textContent;
    expect(text).toContain('<b onclick=alert(4)>label</b>');
    expect(text).toContain('<svg onload=alert(3)>');
  });

  it('neutralizes formula cells in the CSV the page downloads', async () => {
    const dom = await runInteractive(toInteractiveHtml(evil));
    dom.byId.get('csvBtn').onclick();
    expect(dom.downloads).toHaveLength(1);
    expect(dom.downloads[0]).toContain("'=1+1");
    expect(dom.downloads[0]).not.toMatch(/(^|,)=1\+1/m);
  });
});

describe('CSV formula cells', () => {
  it('prefixes cells that a spreadsheet would read as a formula', () => {
    for (const v of ['=HYPERLINK("http://x","y")', '+1+1', '-1+cmd', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(csvField(v).replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });
  it('leaves numbers and plain text alone', () => {
    expect(csvField(-5)).toBe('-5');
    expect(csvField('-5.25')).toBe('-5.25');
    expect(csvField('+44')).toBe('+44');
    expect(csvField('1e-3')).toBe('1e-3');
    expect(csvField('a=b')).toBe('a=b');
  });
  it('applies to header and body cells in toCsv', () => {
    const csv = toCsv({ title: 't', columns: ['=cmd'], rows: [{ '=cmd': '@x' }] });
    expect(csv).toBe("'=cmd\n'@x\n");
  });
});

describe('exportReport basename', () => {
  it('refuses a basename that leaves the output directory', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const mod: any = await import('../report-export.js');
    const work = mkdtempSync(join(tmpdir(), 'wl-report-test-'));
    const outDir = join(work, 'out');
    for (const basename of ['../escape', 'a/b', 'a\\b', '..', '.', '']) {
      await expect(mod.exportReport(ds, outDir, { basename, pdf: false })).rejects.toThrow(/basename/);
    }
    expect(existsSync(join(work, 'escape.csv'))).toBe(false);
    expect(existsSync(join(work, 'escape.html'))).toBe(false);
  });
  it('still writes a plain basename inside the output directory', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const mod: any = await import('../report-export.js');
    const outDir = join(mkdtempSync(join(tmpdir(), 'wl-report-test-')), 'out');
    const res = await mod.exportReport(ds, outDir, { basename: 'hotels', pdf: false });
    expect(res.csv).toBe(join(outDir, 'hotels.csv'));
    expect(existsSync(res.csv)).toBe(true);
  });
});

describe('PDF rendering of untrusted HTML', () => {
  it('blocks scripts and every outside fetch in the rendering browser', () => {
    const args = buildPdfArgs('/tmp/w/report.html', '/tmp/w/out.pdf', '/tmp/w/chrome-profile');
    expect(args).toContain('--blink-settings=scriptEnabled=false');
    expect(args).toContain('--proxy-server=127.0.0.1:9');
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
  });
  it('puts a no-fetch content security policy ahead of the caller HTML', async () => {
    const mod: any = await import('../report-export.js');
    const out: string = mod.preparePdfHtml('<!DOCTYPE html><html><head></head><body><iframe src="file:///etc/passwd"></iframe></body></html>');
    const csp = out.indexOf('Content-Security-Policy');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(out.indexOf('<iframe'));
    expect(out).toContain("default-src 'none'");
    expect(out.match(/<!DOCTYPE/gi)).toHaveLength(1);
  });
});
