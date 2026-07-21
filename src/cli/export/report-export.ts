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
  opts: { basename?: string; pdf?: boolean } & PdfOptions = {},
): Promise<{ csv: string; html: string; pdf?: string }> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const base = opts.basename ?? 'report';
  const csv = join(outDir, `${base}.csv`);
  const html = join(outDir, `${base}.html`);
  writeFileSync(csv, toCsv(ds));
  const htmlDoc = toHtml(ds);
  writeFileSync(html, htmlDoc);
  const result: { csv: string; html: string; pdf?: string } = { csv, html };
  if (opts.pdf !== false) {
    try {
      result.pdf = await renderPdf(htmlDoc, join(outDir, `${base}.pdf`), opts);
    } catch {
      // PDF is best-effort — CSV + HTML always land.
    }
  }
  return result;
}
