// @ts-nocheck
export { normalizeExtensionName, normalizeExtensionList } from './aliases.js';
export { mergeExtensionOverrides } from './settings.js';
export { detectPackageManager, installExtension, uninstallExtension } from './installer.js';
export { promptForMissingSecrets } from './secret-prompter.js';
export { getRecommendations, formatRecommendations } from './recommender.js';
export type { ExtensionRecommendation } from './recommender.js';
export type { SecretPromptResult } from './secret-prompter.js';
