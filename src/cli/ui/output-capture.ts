/**
 * @fileoverview Intercept stdout for the PNG export pipeline.
 * Captures all console output with ANSI escape codes intact.
 * @module wunderland/cli/ui/output-capture
 */

// ── OutputCapture ──────────────────────────────────────────────────────────

/**
 * Captures all output written to `process.stdout` while active.
 * Used by the PNG export pipeline to grab ANSI-styled command output.
 */
export class OutputCapture {
  private chunks: string[] = [];
  private originalWrite: typeof process.stdout.write | null = null;
  private capturing = false;

  /**
   * Start capturing stdout. Monkey-patches `process.stdout.write`.
   * Output is still written to the terminal AND captured.
   */
  start(): void {
    if (this.capturing) return;
    this.capturing = true;
    this.chunks = [];

    const orig = process.stdout.write.bind(process.stdout) as Function;
    this.originalWrite = process.stdout.write;

    (process.stdout as any).write = (...args: any[]): boolean => {
      const chunk = args[0];
      const text = typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString('utf8');
      this.chunks.push(text);

      // Still write to actual stdout
      return orig(...args) as boolean;
    };
  }

  /**
   * Start capturing stdout silently — output is NOT passed through to terminal.
   */
  startSilent(): void {
    if (this.capturing) return;
    this.capturing = true;
    this.chunks = [];

    this.originalWrite = process.stdout.write;

    (process.stdout as any).write = (...args: any[]): boolean => {
      const chunk = args[0];
      const text = typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString('utf8');
      this.chunks.push(text);

      // Don't write to terminal — call callback if provided
      const cb = typeof args[1] === 'function' ? args[1] : args[2];
      if (typeof cb === 'function') cb();
      return true;
    };
  }

  /**
   * Stop capturing and restore the original `process.stdout.write`.
   * @returns The captured ANSI string.
   */
  stop(): string {
    if (!this.capturing) return '';
    this.capturing = false;

    if (this.originalWrite) {
      process.stdout.write = this.originalWrite;
      this.originalWrite = null;
    }

    return this.chunks.join('');
  }

  /** Whether capture is currently active. */
  get isCapturing(): boolean {
    return this.capturing;
  }
}
