#!/usr/bin/env node

/**
 * Summarises a vitest JSON report of the quarantined test files.
 *
 * Usage: node scripts/quarantine-report.mjs <report.json> [--root <package dir>]
 *
 * The blocking lanes exclude the files listed in `vitest.quarantine.json` and
 * `vitest.integration.quarantine.json`. This script prints the current result
 * of each of those files, so a quarantined file cannot fail, or start passing,
 * unseen.
 *
 * A quarantined file is expected to fail, so its failures do not fail this
 * script. Each entry records how many of the file's tests passed when it was
 * quarantined (`passing`); the script exits 1 when a file passes fewer than
 * that, because a test that worked has broken. It also exits 1 when the
 * report is missing or unreadable, which means the lane did not run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const packageRoot =
  rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = ['vitest.quarantine.json', 'vitest.integration.quarantine.json'];

/**
 * First line of the first failure a file reported, shortened for a table cell.
 * @param {{ message?: string, assertionResults?: Array<{ status: string, failureMessages?: string[] }> }} result
 * @returns {string}
 */
function firstFailure(result) {
  const failedAssertion = (result.assertionResults ?? []).find((item) => item.status === 'failed');
  const text = result.message || failedAssertion?.failureMessages?.[0] || '';
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? '';
  return line.trim().replace(/\|/g, '/').slice(0, 160);
}

const reportPath = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--root');
if (!reportPath || !fs.existsSync(reportPath)) {
  console.error(`quarantine report: no vitest report at ${reportPath ?? '(no path given)'}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`quarantine report: ${reportPath} is not valid JSON (${error.message})`);
  process.exit(1);
}

/** Results keyed by the path relative to the package root, as the lists write it. */
const byFile = new Map(
  (report.testResults ?? []).map((result) => [
    path.relative(packageRoot, result.name).split(path.sep).join('/'),
    result,
  ]),
);

const rows = [];
for (const list of LISTS) {
  const entries = JSON.parse(fs.readFileSync(path.join(packageRoot, list), 'utf8'));
  for (const entry of entries) {
    const result = byFile.get(entry.file);
    const tests = result?.assertionResults ?? [];
    const passedTests = tests.filter((item) => item.status === 'passed').length;
    const state = !result ? 'not run' : result.status === 'passed' && tests.length > 0 ? 'passes' : 'fails';
    rows.push({
      list,
      file: entry.file,
      state,
      passed: passedTests,
      recorded: Number.isInteger(entry.passing) ? entry.passing : 0,
      tests: result ? `${passedTests}/${tests.length}` : '-',
      detail: state === 'fails' ? firstFailure(result) : '',
      reason: entry.reason,
    });
  }
}

const counts = { passes: 0, fails: 0, 'not run': 0 };
for (const row of rows) counts[row.state] += 1;

const lines = [
  '## Quarantined tests (report only)',
  '',
  `${rows.length} quarantined files: ${counts.fails} fail, ${counts.passes} pass, ${counts['not run']} did not run.`,
  '',
  '| File | Now | Tests passed | Passed when quarantined | First failure | Recorded reason |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(
    (row) =>
      `| \`${row.file}\` | ${row.state} | ${row.tests} | ${row.recorded} | ${row.detail} | ${row.reason.replace(/\|/g, '/')} |`,
  ),
  '',
];
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

for (const row of rows) {
  if (row.state === 'passes') {
    console.log(`::warning file=${row.list}::${row.file} passes now; remove it from ${row.list} so it blocks again`);
  } else if (row.passed > row.recorded) {
    console.log(
      `::warning file=${row.list}::${row.file} now passes ${row.passed} tests (${row.recorded} recorded); raise "passing" in ${row.list}`,
    );
  }
}

// A file is quarantined because some of its tests fail. The tests in it that
// passed must keep passing.
const regressions = rows.filter((row) => row.passed < row.recorded);
for (const row of regressions) {
  console.log(
    `::error file=${row.list}::${row.file} passed ${row.passed} tests; ${row.recorded} passed when it was quarantined. A test that worked has broken.`,
  );
}
if (regressions.length > 0) process.exit(1);
