/**
 * @fileoverview Sandboxed CSV / HTML / PDF report export for assistant missions.
 *
 * `wunderland mission run` emits CSV natively but not HTML or PDF; an assistant
 * mission that researches (hotels, listings, prices) wants a shareable report.
 * This renders a row dataset to all three, deterministically and offline.
 *
 * PDF is produced by a SEPARATE headless Chrome invocation with its OWN
 * throwaway `--user-data-dir` — NEVER the user's live profile (Codex spec
 * review F15). Print-safe CSS mirrors the pitch-deck hard-won rules
 * (`box-shadow: none`, no blur) so macOS Preview renders cleanly.
 *
 * @module wunderland/cli/export/report-export
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/** A report dataset: ordered columns + rows keyed by column. */
export interface ReportDataset {
  title: string;
  columns: string[];
  rows: Array<Record<string, string | number>>;
  /** Optional lead paragraph rendered above the table in HTML/PDF. */
  summary?: string;
}

/** Escape one CSV field per RFC 4180 (quote when it holds `," \n \r`). */
export function csvField(value: string | number): string {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render a dataset to CSV text (header row + one row per record). */
export function toCsv(ds: ReportDataset): string {
  const head = ds.columns.map(csvField).join(',');
  const body = ds.rows.map((r) => ds.columns.map((c) => csvField(r[c] ?? '')).join(',')).join('\n');
  return body ? `${head}\n${body}\n` : `${head}\n`;
}

/** Minimal HTML escaping for text nodes / attribute-free content. */
export function htmlEscape(value: string | number): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render a dataset to a self-contained, print-safe HTML document. */
export function toHtml(ds: ReportDataset): string {
  const head = ds.columns.map((c) => `<th>${htmlEscape(c)}</th>`).join('');
  const rows = ds.rows
    .map((r) => `<tr>${ds.columns.map((c) => `<td>${htmlEscape(r[c] ?? '')}</td>`).join('')}</tr>`)
    .join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${htmlEscape(ds.title)}</title>
<style>
  *{box-sizing:border-box;box-shadow:none!important}
  body{font-family:Inter,-apple-system,'Helvetica Neue',Arial,sans-serif;color:#16181d;margin:0;padding:28px 34px;font-size:13px;line-height:1.45}
  h1{font-size:22px;margin:0 0 6px}
  .summary{color:#444;margin:0 0 14px}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #c9ccd3;padding:5px 7px;text-align:left;vertical-align:top;font-size:11px}
  th{background:#eef0f4;text-transform:uppercase;letter-spacing:.04em;font-size:10.5px}
  tr{page-break-inside:avoid}
  @page{margin:14mm 11mm}
</style></head><body>
<h1>${htmlEscape(ds.title)}</h1>
${ds.summary ? `<p class="summary">${htmlEscape(ds.summary)}</p>` : ''}
<table><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table>
</body></html>`;
}

/**
 * Column render hints for the interactive report — let a caller mark which
 * columns are numeric (right-aligned, numeric sort), which carries the primary
 * value metric (highlighted), and human labels.
 */
export interface ColumnSpec {
  key: string;
  label?: string;
  numeric?: boolean;
  /** When set, rows are heat-shaded by this column's numeric value. */
  heat?: 'higher-better' | 'lower-better';
}

/** Options for {@link toInteractiveHtml}. */
export interface InteractiveOptions {
  columns?: ColumnSpec[];
  /** Stat cards shown above the table: label + value. */
  stats?: Array<{ label: string; value: string }>;
  /** Default theme; the viewer can toggle. */
  theme?: 'light' | 'dark' | 'auto';
}

/**
 * Render a dataset to a SELF-CONTAINED interactive HTML report: client-side
 * column sort, a live search box, per-column filters, stat cards, optional
 * value heat-shading, and a light/dark toggle. No external resources — all CSS
 * and JS are inlined, so it opens offline and is safe to share as one file.
 */
export function toInteractiveHtml(ds: ReportDataset, opts: InteractiveOptions = {}): string {
  const specs: ColumnSpec[] = opts.columns ?? ds.columns.map((k) => ({ key: k }));
  const colMeta = specs.map((s) => ({
    key: s.key,
    label: s.label ?? s.key,
    numeric: !!s.numeric,
    heat: s.heat ?? null,
  }));
  const stats = opts.stats ?? [];
  // Data goes to the client as JSON (htmlEscape not needed — JSON.stringify in a
  // script context; we defend against </script> injection by escaping '<').
  const dataJson = JSON.stringify({ rows: ds.rows, cols: colMeta }).replace(/</g, '\\u003c');
  const statsHtml = stats
    .map((s) => `<div class="stat"><b>${htmlEscape(s.value)}</b><span>${htmlEscape(s.label)}</span></div>`)
    .join('');
  const theme = opts.theme ?? 'auto';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(ds.title)}</title>
<style>
  :root{--bg:#fff;--fg:#16181d;--muted:#5b616e;--line:#d8dbe2;--head:#f0f2f6;--accent:#2f6df6;--heat:#2f6df6}
  :root[data-theme=dark]{--bg:#14161b;--fg:#e8eaf0;--muted:#9aa2b1;--line:#2a2e37;--head:#1c1f27;--accent:#6ea8ff;--heat:#6ea8ff}
  @media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14161b;--fg:#e8eaf0;--muted:#9aa2b1;--line:#2a2e37;--head:#1c1f27;--accent:#6ea8ff;--heat:#6ea8ff}}
  *{box-sizing:border-box}
  body{font-family:Inter,-apple-system,'Helvetica Neue',Arial,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 28px;font-size:13px;line-height:1.45}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
  h1{font-size:21px;margin:0}
  .summary{color:var(--muted);margin:4px 0 0}
  .toolbar{display:flex;gap:10px;align-items:center;margin:16px 0 10px;flex-wrap:wrap}
  input[type=search]{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px}
  .btn{padding:6px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);cursor:pointer;font-size:12px}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
  .stat{border:1px solid var(--line);border-radius:10px;padding:8px 13px;min-width:96px}
  .stat b{display:block;font-size:17px}
  .stat span{color:var(--muted);font-size:11px}
  .wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
  table{border-collapse:collapse;width:100%;min-width:520px}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis}
  td.wrapcell{white-space:normal}
  th{background:var(--head);position:sticky;top:0;cursor:pointer;user-select:none;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  th .ar{opacity:.4;font-size:10px;margin-left:4px}
  th.sorted .ar{opacity:1;color:var(--accent)}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  tbody tr:hover{background:var(--head)}
  .count{color:var(--muted);font-size:12px}
  .empty{padding:20px;text-align:center;color:var(--muted)}
</style></head><body>
<header>
  <div><h1>${htmlEscape(ds.title)}</h1>${ds.summary ? `<p class="summary">${htmlEscape(ds.summary)}</p>` : ''}</div>
  <button class="btn" id="themeBtn" type="button">◐ theme</button>
</header>
<div class="stats">${statsHtml}</div>
<div class="toolbar">
  <input type="search" id="q" placeholder="Search all columns…" autocomplete="off">
  <button class="btn" id="csvBtn" type="button">⬇ CSV</button>
  <span class="count" id="count"></span>
</div>
<div class="wrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
<script>
const DATA = ${dataJson};
const state = { sortKey: null, dir: 1, q: '' };
const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\\-]/g,'')); return isNaN(n) ? null : n; };
function heatRange(key){ let lo=Infinity, hi=-Infinity; for(const r of DATA.rows){ const n=num(r[key]); if(n==null)continue; lo=Math.min(lo,n); hi=Math.max(hi,n);} return {lo,hi}; }
const heats = {}; for(const c of DATA.cols) if(c.heat) heats[c.key]=heatRange(c.key);
function shade(c, v){ const h=heats[c.key]; if(!h)return ''; const n=num(v); if(n==null||h.hi===h.lo)return ''; let t=(n-h.lo)/(h.hi-h.lo); if(c.heat==='lower-better')t=1-t; const a=(0.06+0.20*t).toFixed(3); return 'background:color-mix(in srgb, var(--heat) '+(a*100).toFixed(1)+'%, transparent)'; }
function rows(){ let rs=DATA.rows; if(state.q){ const q=state.q.toLowerCase(); rs=rs.filter(r=>DATA.cols.some(c=>String(r[c.key]??'').toLowerCase().includes(q))); }
  if(state.sortKey){ const c=DATA.cols.find(x=>x.key===state.sortKey); rs=rs.slice().sort((a,b)=>{ let av=a[state.sortKey], bv=b[state.sortKey]; if(c&&c.numeric){ av=num(av)??-Infinity; bv=num(bv)??-Infinity; return (av-bv)*state.dir;} return String(av??'').localeCompare(String(bv??''))*state.dir; }); }
  return rs; }
function render(){ const th=document.getElementById('thead'), tb=document.getElementById('tbody');
  th.innerHTML='<tr>'+DATA.cols.map(c=>'<th class="'+(c.numeric?'num ':'')+(state.sortKey===c.key?'sorted':'')+'" data-k="'+c.key+'">'+c.label+'<span class="ar">'+(state.sortKey===c.key?(state.dir>0?'▲':'▼'):'⇅')+'</span></th>').join('')+'</tr>';
  const rs=rows(); tb.innerHTML = rs.length? rs.map(r=>'<tr>'+DATA.cols.map(c=>{const v=r[c.key]??''; return '<td class="'+(c.numeric?'num':'wrapcell')+'" style="'+shade(c,v)+'">'+String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</td>';}).join('')+'</tr>').join('') : '<tr><td class="empty" colspan="'+DATA.cols.length+'">No matching rows</td></tr>';
  document.getElementById('count').textContent=rs.length+' / '+DATA.rows.length+' rows';
  th.querySelectorAll('th').forEach(h=>h.onclick=()=>{ const k=h.dataset.k; if(state.sortKey===k)state.dir*=-1; else {state.sortKey=k;state.dir=1;} render(); }); }
document.getElementById('q').addEventListener('input', e=>{ state.q=e.target.value; render(); });
document.getElementById('themeBtn').onclick=()=>{ const r=document.documentElement; const cur=r.getAttribute('data-theme')|| (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'); r.setAttribute('data-theme', cur==='dark'?'light':'dark'); };
document.getElementById('csvBtn').onclick=()=>{ const esc=v=>{const s=String(v??'');return /[",\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}; const cols=DATA.cols.map(c=>c.key); const csv=[cols.map(esc).join(',')].concat(rows().map(r=>cols.map(c=>esc(r[c])).join(','))).join('\\n'); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='report.csv'; a.click(); };
${theme !== 'auto' ? `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});` : ''}
render();
</script>
</body></html>`;
}

/** Options controlling PDF rendering. */
export interface PdfOptions {
  /** Path to the Chrome/Chromium binary. */
  chromeBinary?: string;
  /** Per-render timeout ms (default 90s). */
  timeoutMs?: number;
}

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Build the headless-Chrome argv for PDF rendering. Pure + exported for tests.
 * The `--user-data-dir` MUST be an isolated throwaway directory, never the
 * user's live profile.
 */
export function buildPdfArgs(htmlPath: string, pdfPath: string, userDataDir: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--print-to-pdf=${pdfPath}`,
    '--no-pdf-header-footer',
    `file://${htmlPath}`,
  ];
}

/**
 * Render `html` to a PDF at `pdfPath` via an isolated headless Chrome. Throws
 * if the binary is missing or the render times out.
 */
export async function renderPdf(html: string, pdfPath: string, opts: PdfOptions = {}): Promise<string> {
  const { writeFileSync } = await import('node:fs');
  const work = mkdtempSync(join(tmpdir(), 'wl-report-'));
  const htmlPath = join(work, 'report.html');
  const profileDir = join(work, 'chrome-profile'); // throwaway — NEVER the live profile
  writeFileSync(htmlPath, html);
  const args = buildPdfArgs(htmlPath, pdfPath, profileDir);
  await pExecFile(opts.chromeBinary ?? DEFAULT_CHROME, args, { timeout: opts.timeoutMs ?? 90_000 });
  return pdfPath;
}

/**
 * Write CSV + HTML for a dataset (always) and a PDF (best-effort, when a Chrome
 * binary is available). Returns the paths that were written.
 */
export async function exportReport(
  ds: ReportDataset,
  outDir: string,
  opts: { basename?: string; pdf?: boolean; interactive?: boolean | InteractiveOptions } & PdfOptions = {},
): Promise<{ csv: string; html: string; pdf?: string; interactive?: string }> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const base = opts.basename ?? 'report';
  const csv = join(outDir, `${base}.csv`);
  const html = join(outDir, `${base}.html`);
  writeFileSync(csv, toCsv(ds));
  // The print-safe static HTML is what the PDF is rendered from.
  const htmlDoc = toHtml(ds);
  writeFileSync(html, htmlDoc);
  const result: { csv: string; html: string; pdf?: string; interactive?: string } = { csv, html };
  if (opts.interactive) {
    const iv = join(outDir, `${base}.interactive.html`);
    writeFileSync(iv, toInteractiveHtml(ds, typeof opts.interactive === 'object' ? opts.interactive : {}));
    result.interactive = iv;
  }
  if (opts.pdf !== false) {
    try {
      result.pdf = await renderPdf(htmlDoc, join(outDir, `${base}.pdf`), opts);
    } catch {
      // PDF is best-effort — CSV + HTML always land.
    }
  }
  return result;
}
