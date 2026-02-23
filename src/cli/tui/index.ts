/**
 * @fileoverview TUI entry point. Launches the interactive dashboard.
 * @module wunderland/cli/tui
 */

import type { GlobalFlags } from '../types.js';
import { Screen } from './screen.js';
import { KeybindingManager } from './keybindings.js';
import { Dashboard } from './dashboard.js';

// View mapping: command name → lazy-loaded TUI view
const VIEW_MAP: Record<string, () => Promise<any>> = {
  doctor:     () => import('./views/doctor-view.js'),
  models:     () => import('./views/models-view.js'),
  skills:     () => import('./views/skills-view.js'),
  rag:        () => import('./views/rag-view.js'),
  extensions: () => import('./views/extensions-view.js'),
  status:     () => import('./views/status-view.js'),
  voice:      () => import('./views/voice-view.js'),
};

/**
 * Launch the TUI (interactive dashboard).
 * Called when `wunderland` is run with no args in a TTY.
 */
export async function launchTui(_globals: GlobalFlags): Promise<void> {
  const screen = new Screen();
  const keys = new KeybindingManager();

  let exitResolve: () => void;
  const exitPromise = new Promise<void>((resolve) => { exitResolve = resolve; });

  let activeView: { dispose(): void } | null = null;

  // Clean exit handler
  const cleanup = () => {
    if (activeView) { activeView.dispose(); activeView = null; }
    dashboard.dispose();
    screen.dispose();
    exitResolve();
  };

  // Handle SIGINT/SIGTERM gracefully
  const sigHandler = () => { cleanup(); };
  process.on('SIGINT', sigHandler);
  process.on('SIGTERM', sigHandler);

  screen.enterAltScreen();
  screen.hideCursor();

  const showDashboard = async () => {
    if (activeView) { activeView.dispose(); activeView = null; }
    await dashboard.render();
  };

  const dashboard = new Dashboard({
    screen,
    keys,
    configDir: _globals.config,
    onSelect: async (command: string) => {
      const viewLoader = VIEW_MAP[command];

      if (viewLoader) {
        // Drill down into TUI view
        const viewModule = await viewLoader();
        const ViewClass = viewModule.DoctorView || viewModule.ModelsView
          || viewModule.SkillsView || viewModule.RagView
          || viewModule.ExtensionsView || viewModule.StatusView
          || viewModule.VoiceView;

        if (ViewClass) {
          activeView = new ViewClass({
            screen,
            keys,
            configDir: _globals.config,
            onBack: () => { showDashboard(); },
          });
          await (activeView as any).run();
          return;
        }
      }

      // Fall back to running CLI command (exit TUI first)
      cleanup();
      try {
        const { main } = await import('../index.js');
        await main([command === 'help' ? '--help' : command]);
      } catch (err) {
        console.error('Command failed:', err instanceof Error ? err.message : String(err));
      }
      // TUI has been torn down; cleanly exit after the command finishes
      process.exit(process.exitCode ?? 0);
    },
    onQuit: () => {
      cleanup();
    },
  });

  // Wire keypresses
  screen.onKeypress((key) => {
    // Handle character input for RAG view
    if (key.name === undefined && key.sequence && !key.ctrl && !key.meta) {
      // Pass printable characters through to current key layer
      keys.handle(key);
      return;
    }
    keys.handle(key);
  });

  // Render on resize
  screen.onResize(() => {
    if (activeView && typeof (activeView as any).run === 'function') {
      (activeView as any).run();
    } else {
      dashboard.render();
    }
  });

  // Pre-load config/secrets, then render with animated intro
  await dashboard.init();
  await dashboard.render();

  // Wait for exit
  await exitPromise;

  // Clean up signal handlers
  process.removeListener('SIGINT', sigHandler);
  process.removeListener('SIGTERM', sigHandler);
}
