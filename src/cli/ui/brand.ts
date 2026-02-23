/**
 * @fileoverview Brand assets for the Wunderland CLI/TUI (wordmarks, gradients).
 * @module wunderland/cli/ui/brand
 */

import gradient from 'gradient-string';
import { HEX, GRADIENT_COLORS } from './theme.js';

/**
 * Minimal gradient-string surface we rely on (keeps generated .d.ts stable).
 * `gradient-string` returns a callable object with `.multiline()`.
 */
export type Gradient = ((input: string) => string) & { multiline: (input: string) => string };

export const ASCII_BANNER = `
 ██╗    ██╗██╗   ██╗███╗   ██╗██████╗ ███████╗██████╗ ██╗      █████╗ ███╗   ██╗██████╗
 ██║    ██║██║   ██║████╗  ██║██╔══██╗██╔════╝██╔══██╗██║     ██╔══██╗████╗  ██║██╔══██╗
 ██║ █╗ ██║██║   ██║██╔██╗ ██║██║  ██║█████╗  ██████╔╝██║     ███████║██╔██╗ ██║██║  ██║
 ╚██╗╚█╗██╔╝╚██████╔╝██║╚████║██████╔╝███████╗██║  ██║███████╗██║  ██║██║╚████║██████╔╝
  ╚═╝ ╚═╝    ╚═════╝ ╚═╝ ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝ ╚═══╝╚═════╝`;

/**
 * True ASCII fallback banner (safe for non-UTF8 terminals).
 * Kept intentionally compact to fit in narrow terminals.
 */
export const ASCII_BANNER_ASCII = `
 __        __ _   _ _   _ ____  _____ ____  _        _    _   _ ____
 \\ \\      / /| | | | \\ | |  _ \\| ____|  _ \\| |      / \\  | \\ | |  _ \\
  \\ \\ /\\ / / | | | |  \\| | | | |  _| | |_) | |     / _ \\ |  \\| | | | |
   \\ V  V /  | |_| | |\\  | |_| | |___|  _ <| |___ / ___ \\| |\\  | |_| |
    \\_/\\_/    \\___/|_| \\_|____/|_____|_| \\_\\_____/_/   \\_\\_| \\_|____/`;

/**
 * Multicolor brand gradient for big ASCII headers.
 * Purple → Lavender → Magenta → Bright Cyan → Cyan
 */
export const brandGradient = gradient([
  HEX.purple,
  HEX.lavender,
  HEX.magenta,
  HEX.brightCyan,
  HEX.cyan,
]) as unknown as Gradient;

/** Compact wordmark gradient for one-line headers. */
export const wordmarkGradient = gradient([...GRADIENT_COLORS]) as unknown as Gradient;
