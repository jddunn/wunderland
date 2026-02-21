/**
 * @fileoverview UI layer barrel exports.
 * @module wunderland/cli/ui
 */

export { printBanner } from './banner.js';
export { printCompactHeader } from './compact-header.js';
export * from './theme.js';
export * as fmt from './format.js';

// New UI primitives
export { renderTable, printTable, type TableColumn, type TableOptions } from './table.js';
export { renderPanel, printPanel, type PanelOptions, type PanelStyle } from './panel.js';
export { createStepProgress, type StepProgress } from './progress.js';
export { OutputCapture } from './output-capture.js';
