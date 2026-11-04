// @ts-nocheck
/**
 * @fileoverview Imports the report export helper the way an installed consumer does.
 * @module wunderland/__tests__/consumer-report-entry.integration.test
 *
 * `docs/features/ASSISTANT_BROWSER_ATTACH.md` tells a host to call
 * `exportReport` to turn mission rows into CSV, HTML and an interactive HTML
 * report. A throwaway project links this package into its own `node_modules`,
 * so the import below goes through the `exports` map in package.json and lands
 * on the built `dist`. A subpath missing from the map fails here with
 * ERR_PACKAGE_PATH_NOT_EXPORTED, as it would for a reader of that page. The CI
 * lane builds before this file runs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Parsing the declarations takes a while on a CI runner. */
const COMPILE_TIMEOUT_MS = 180_000;

const RUNTIME_CONSUMER = `import { readFileSync } from 'node:fs';
import { exportReport, toCsv } from 'wunderland/report';

const dataset = {
  title: 'LA Hotels',
  columns: ['hotel', 'rate'],
  rows: [{ hotel: 'Ocean, View', rate: 210 }, { hotel: 'Marina', rate: 180 }],
};
const written = await exportReport(dataset, './out', {
  basename: 'hotels',
  pdf: false,
  interactive: { columns: [{ key: 'rate', numeric: true, heat: 'lower-better' }] },
});

console.log(JSON.stringify({
  files: Object.keys(written).sort(),
  csv: readFileSync(written.csv, 'utf8'),
  sameCsv: readFileSync(written.csv, 'utf8') === toCsv(dataset),
  htmlTitled: readFileSync(written.html, 'utf8').includes('LA Hotels'),
  interactiveTitled: readFileSync(written.interactive, 'utf8').includes('LA Hotels'),
}));
`;

const TYPED_CONSUMER = `import { exportReport } from 'wunderland/report';
import type { InteractiveOptions, ReportDataset } from 'wunderland/report';

export const dataset: ReportDataset = { title: 'LA Hotels', columns: ['hotel'], rows: [{ hotel: 'Marina' }] };
export const interactive: InteractiveOptions = { columns: [{ key: 'rate', numeric: true, heat: 'lower-better' }] };

// Fails as an unused directive if the name resolves to \`any\`.
// @ts-expect-error a dataset needs columns and rows.
export const refused: ReportDataset = { title: 'no rows' };

export const written: Promise<{ csv: string; html: string; pdf?: string; interactive?: string }> = exportReport(
  dataset,
  './out',
  { basename: 'hotels', pdf: false, interactive },
);
`;

describe('a project that installs wunderland and exports a report', () => {
  let project: string;

  beforeAll(() => {
    expect(existsSync(path.join(PKG_ROOT, 'dist/index.js')), 'this file reads dist: build first').toBe(true);
    project = realpathSync(mkdtempSync(path.join(tmpdir(), 'wunderland-report-consumer-')));
    mkdirSync(path.join(project, 'node_modules'));
    symlinkSync(PKG_ROOT, path.join(project, 'node_modules/wunderland'), 'dir');
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module' }));
    writeFileSync(path.join(project, 'consumer.mjs'), RUNTIME_CONSUMER);
    writeFileSync(path.join(project, 'consumer.ts'), TYPED_CONSUMER);
  });

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it('writes the CSV, the HTML and the interactive report under plain Node', () => {
    const run = spawnSync(process.execPath, ['consumer.mjs'], { cwd: project, encoding: 'utf8' });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      files: ['csv', 'html', 'interactive'],
      csv: 'hotel,rate\n"Ocean, View",210\nMarina,180\n',
      sameCsv: true,
      htmlTitled: true,
      interactiveTitled: true,
    });
  });

  it.each([
    ['NodeNext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    ['Bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ])(
    'compiles the same import and its types against the published declarations under %s resolution',
    (_name, module, moduleResolution) => {
      const file = path.join(project, 'consumer.ts');
      const program = ts.createProgram([file], {
        module,
        moduleResolution,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      });

      const messages = ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.file?.fileName === file)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

      expect(messages).toEqual([]);
    },
    COMPILE_TIMEOUT_MS,
  );
});
