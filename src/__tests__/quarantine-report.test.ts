import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/quarantine-report.mjs', import.meta.url));

/**
 * Builds a package root with one quarantined file that recorded `recorded`
 * passing tests, and a vitest JSON report in which `passed` of its tests pass.
 */
function run(recorded: number, passed: number, total = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-report-'));
  fs.writeFileSync(
    path.join(root, 'vitest.quarantine.json'),
    JSON.stringify([{ file: 'src/demo.test.ts', passing: recorded, reason: 'two of its tests fail on a moved import' }]),
  );
  fs.writeFileSync(path.join(root, 'vitest.integration.quarantine.json'), '[]');
  const assertionResults = Array.from({ length: total }, (_, index) =>
    index < passed
      ? { status: 'passed', fullName: `demo ${index}` }
      : { status: 'failed', fullName: `demo ${index}`, failureMessages: ['Error: boom\n    at stack'] },
  );
  const report = path.join(root, 'report.json');
  fs.writeFileSync(
    report,
    JSON.stringify({ testResults: [{ name: path.join(root, 'src/demo.test.ts'), status: 'failed', assertionResults }] }),
  );
  return spawnSync(process.execPath, [script, report, '--root', root], { encoding: 'utf8' });
}

describe('quarantine report', () => {
  it('does not fail on a quarantined file that still passes what it passed', () => {
    const result = run(1, 1);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('1 quarantined files: 1 fail, 0 pass, 0 did not run.');
    expect(result.stdout).toContain('Error: boom');
  });

  it('fails when a test that passed at quarantine time no longer passes', () => {
    const result = run(2, 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/demo.test.ts passed 1 tests; 2 passed when it was quarantined');
  });

  it('warns, without failing, when a file passes more than was recorded or passes outright', () => {
    const more = run(1, 2);
    expect(more.status, more.stderr).toBe(0);
    expect(more.stdout).toContain('now passes 2 tests (1 recorded)');
  });

  it('fails when the vitest report is missing, because the lane did not run', () => {
    const result = spawnSync(process.execPath, [script, path.join(os.tmpdir(), 'no-such-report.json')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no vitest report');
  });
});
