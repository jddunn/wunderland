// @ts-nocheck
/**
 * @fileoverview `wunderland dashboard` — standalone multi-agent web dashboard.
 * @module wunderland/cli/commands/dashboard
 *
 * Launches a lightweight HTTP server on port 4444 (configurable with --port)
 * that serves the Wunderland Hub SPA. The hub provides a unified view of all
 * agents on the local machine: start/stop, spawn new agents from natural
 * language, and tail agent logs — all from a single browser tab.
 *
 * @example
 * ```bash
 * wunderland dashboard
 * wunderland dashboard --port 5555
 * wunderland dashboard --secret my-secret-key
 * ```
 */

import * as crypto from 'node:crypto';
import type { GlobalFlags } from '../../types.js';
import { accent, dim, success as sColor } from '../../ui/theme.js';
import * as fmt from '../../ui/format.js';
import { createDashboardServer } from './dashboard-server.js';
import type { DashboardDeps } from './routes/types.js';

/** Default port for the multi-agent dashboard. */
const DEFAULT_PORT = 4444;

export default async function cmdDashboard(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  /* ── Resolve port ─────────────────────────────────────────────────────── */
  let port = DEFAULT_PORT;
  if (typeof flags['port'] === 'string') {
    const parsed = parseInt(flags['port'], 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) port = parsed;
  }

  /* ── Resolve admin secret ─────────────────────────────────────────────── */
  const adminSecret: string =
    typeof flags['secret'] === 'string' && flags['secret'].trim()
      ? flags['secret'].trim()
      : crypto.randomUUID();

  /* ── Build deps ───────────────────────────────────────────────────────── */
  const deps: DashboardDeps = {
    adminSecret,
    startedAt: new Date().toISOString(),
    port,
  };

  /* ── Create and start server ──────────────────────────────────────────── */
  const server = createDashboardServer(deps);

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        fmt.errorBlock(
          'Port in use',
          `Port ${port} is already in use. Try a different port:\n  ${accent(`wunderland dashboard --port ${port + 1}`)}`,
        );
        process.exitCode = 1;
        reject(err);
      } else {
        fmt.errorBlock('Server error', err.message);
        process.exitCode = 1;
        reject(err);
      }
    });

    server.listen(port, () => {
      resolve();
    });
  });

  /* ── Print startup banner ─────────────────────────────────────────────── */
  fmt.section('Wunderland Hub');
  fmt.kvPair('URL', sColor(`http://localhost:${port}/`));
  fmt.kvPair('Admin Secret', accent(adminSecret));
  fmt.blank();
  fmt.note(`Open ${accent(`http://localhost:${port}/`)} in your browser.`);
  fmt.note(`Paste the admin secret to authenticate.`);
  fmt.note(`Press ${dim('Ctrl+C')} to stop the dashboard server.`);
  fmt.blank();

  /* ── Block forever until SIGINT/SIGTERM ────────────────────────────────── */
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log('\n' + dim('[wunderland] Dashboard server stopped.'));
      server.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
