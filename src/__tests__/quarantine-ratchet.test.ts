import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The quarantine lists only shrink. A file leaves a list by passing: removing
 * its entry returns it to a blocking lane. A list grows only by raising its
 * ceiling here, which is a change a reviewer sees.
 */
const CEILINGS: Record<string, number> = {
  'vitest.quarantine.json': 19,
  'vitest.integration.quarantine.json': 0,
};

interface QuarantineEntry {
  file: string;
  reason: string;
  /** Tests in the file that passed when it was quarantined; the report lane fails below this. */
  passing?: number;
}

function entries(list: string): QuarantineEntry[] {
  return JSON.parse(fs.readFileSync(`${root}${list}`, 'utf8'));
}

describe('test quarantine lists', () => {
  for (const [list, ceiling] of Object.entries(CEILINGS)) {
    it(`${list} holds at most ${ceiling} entries`, () => {
      expect(entries(list).length).toBeLessThanOrEqual(ceiling);
    });

    it(`${list} names each existing test file once, with the reason it is excluded`, () => {
      const seen = new Set<string>();
      for (const entry of entries(list)) {
        expect(fs.existsSync(`${root}${entry.file}`), `${entry.file} does not exist`).toBe(true);
        expect(seen.has(entry.file), `${entry.file} is listed twice`).toBe(false);
        seen.add(entry.file);
        expect((entry.reason ?? '').trim().length, `${entry.file} has no reason`).toBeGreaterThan(10);
        expect(Number.isInteger(entry.passing) && (entry.passing as number) >= 0, `${entry.file} has no passing count`).toBe(true);
      }
    });
  }
});
