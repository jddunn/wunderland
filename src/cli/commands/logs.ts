/**
 * @fileoverview `wunderland logs [seedId]` — tail agent daemon logs.
 * @module wunderland/cli/commands/logs
 */

import { existsSync } from 'node:fs';
import { readFile, stat, open } from 'node:fs/promises';
import { watch } from 'node:fs';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { getDaemonDir, resolveDaemon } from '../daemon/daemon-state.js';

const DEFAULT_LINES = 50;

export default async function cmdLogs(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const seedIdArg = args[0];
  const { info, error } = await resolveDaemon(seedIdArg);

  if (!info) {
    fmt.errorBlock('No daemon', error || 'No daemon found.');
    process.exitCode = 1;
    return;
  }

  const useStderr = flags['stderr'] === true;
  const logFileName = useStderr ? 'stderr.log' : 'stdout.log';
  const logPath = path.join(getDaemonDir(info.seedId), logFileName);

  if (!existsSync(logPath)) {
    fmt.note(`No log file yet: ${logPath}`);
    return;
  }

  // Parse --lines / -n
  let numLines = DEFAULT_LINES;
  if (typeof flags['lines'] === 'string') {
    const parsed = parseInt(flags['lines'], 10);
    if (!isNaN(parsed) && parsed > 0) numLines = parsed;
  } else if (typeof flags['n'] === 'string') {
    const parsed = parseInt(flags['n'], 10);
    if (!isNaN(parsed) && parsed > 0) numLines = parsed;
  }

  // Resolve follow mode.
  const follow =
    flags['follow'] === true || flags['f'] === true ||
    (flags['follow'] !== false && flags['f'] !== false && process.stdout.isTTY);

  // ── Print last N lines ─────────────────────────────────────────────────
  const content = await readFile(logPath, 'utf-8');
  const lines = content.split('\n');
  // Remove trailing empty line from split.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const startIdx = Math.max(0, lines.length - numLines);
  for (let i = startIdx; i < lines.length; i++) {
    console.log(lines[i]);
  }

  if (!follow) return;

  // ── Follow mode: stream new lines ──────────────────────────────────────
  fmt.note(`Following ${accent(logFileName)} — Ctrl+C to exit`);

  let filePos = (await stat(logPath)).size;
  const fh = await open(logPath, 'r');
  let buffer = '';

  const readNewContent = async () => {
    const currentSize = (await stat(logPath)).size;
    if (currentSize <= filePos) return;

    const bytesToRead = currentSize - filePos;
    const buf = Buffer.alloc(bytesToRead);
    await fh.read(buf, 0, bytesToRead, filePos);
    filePos = currentSize;

    buffer += buf.toString('utf-8');
    const newLines = buffer.split('\n');
    // Keep the last (possibly incomplete) line in the buffer.
    buffer = newLines.pop() || '';
    for (const line of newLines) {
      console.log(line);
    }
  };

  const watcher = watch(logPath, async () => {
    try {
      await readNewContent();
    } catch {
      // File may have been deleted.
    }
  });

  // Also poll every second as a fallback (fs.watch can miss events on some platforms).
  const pollInterval = setInterval(async () => {
    try {
      await readNewContent();
    } catch {
      // ignore
    }
  }, 1000);

  // Graceful exit.
  const cleanup = () => {
    watcher.close();
    clearInterval(pollInterval);
    void fh.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Keep the process alive.
  await new Promise(() => {});
}
