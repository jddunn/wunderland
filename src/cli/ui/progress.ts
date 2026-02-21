/**
 * @fileoverview Step-by-step progress indicator with animated spinners.
 * @module wunderland/cli/ui/progress
 */

import { createSpinner } from 'nanospinner';
import { success as sColor, error as eColor, muted, dim, accent } from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StepProgress {
  /** Start the spinner for a step. */
  start(index: number): void;
  /** Mark a step as passed (green check). */
  pass(index: number, detail?: string): void;
  /** Mark a step as failed (red X). */
  fail(index: number, reason?: string): void;
  /** Mark a step as skipped (gray circle). */
  skip(index: number, reason?: string): void;
  /** Print summary line and stop all spinners. */
  complete(): void;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a step-by-step progress tracker.
 * Each step gets its own spinner that transitions to a static pass/fail icon.
 *
 * When stdout is NOT a TTY, spinners are skipped and results print directly.
 */
export function createStepProgress(steps: string[]): StepProgress {
  const isTTY = process.stdout.isTTY;
  const results: ('pass' | 'fail' | 'skip' | null)[] = steps.map(() => null);
  const details: (string | undefined)[] = steps.map(() => undefined);
  let activeSpinner: ReturnType<typeof createSpinner> | null = null;
  let activeIndex = -1;

  function stopActive(): void {
    if (activeSpinner) {
      activeSpinner.stop();
      activeSpinner = null;
    }
  }

  function printResult(index: number): void {
    const step = steps[index];
    const result = results[index];
    const detail = details[index];
    const detailStr = detail ? `  ${dim(detail)}` : '';

    if (result === 'pass') {
      console.log(`  ${sColor('✓')} ${step}${detailStr}`);
    } else if (result === 'fail') {
      console.log(`  ${eColor('✗')} ${eColor(step)}${detailStr}`);
    } else if (result === 'skip') {
      console.log(`  ${muted('○')} ${muted(step)}${detailStr}`);
    }
  }

  return {
    start(index: number): void {
      if (index < 0 || index >= steps.length) return;
      stopActive();

      if (isTTY) {
        activeIndex = index;
        activeSpinner = createSpinner(steps[index], {
          color: 'cyan',
        });
        activeSpinner.start();
      }
    },

    pass(index: number, detail?: string): void {
      if (index < 0 || index >= steps.length) return;
      results[index] = 'pass';
      details[index] = detail;

      if (isTTY && activeIndex === index && activeSpinner) {
        const detailStr = detail ? `  ${dim(detail)}` : '';
        activeSpinner.success({ text: `${steps[index]}${detailStr}` });
        activeSpinner = null;
        activeIndex = -1;
      } else {
        printResult(index);
      }
    },

    fail(index: number, reason?: string): void {
      if (index < 0 || index >= steps.length) return;
      results[index] = 'fail';
      details[index] = reason;

      if (isTTY && activeIndex === index && activeSpinner) {
        const detailStr = reason ? `  ${dim(reason)}` : '';
        activeSpinner.error({ text: `${eColor(steps[index])}${detailStr}` });
        activeSpinner = null;
        activeIndex = -1;
      } else {
        printResult(index);
      }
    },

    skip(index: number, reason?: string): void {
      if (index < 0 || index >= steps.length) return;
      results[index] = 'skip';
      details[index] = reason;

      if (isTTY && activeIndex === index && activeSpinner) {
        const detailStr = reason ? `  ${dim(reason)}` : '';
        activeSpinner.stop({ text: `${muted(steps[index])}${detailStr}` });
        activeSpinner = null;
        activeIndex = -1;
      } else {
        printResult(index);
      }
    },

    complete(): void {
      stopActive();
      const passed = results.filter((r) => r === 'pass').length;
      const failed = results.filter((r) => r === 'fail').length;
      const skipped = results.filter((r) => r === 'skip').length;

      const parts = [
        sColor(`${passed} passed`),
        skipped > 0 ? muted(`${skipped} skipped`) : '',
        failed > 0 ? eColor(`${failed} failed`) : '',
      ].filter(Boolean).join(dim(', '));

      console.log();
      console.log(`  ${accent('◆')} ${parts}`);
    },
  };
}
