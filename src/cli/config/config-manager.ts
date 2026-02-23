/**
 * @fileoverview Read/write ~/.wunderland/config.json.
 * @module wunderland/cli/config/config-manager
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import type { CliConfig } from '../types.js';
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from '../constants.js';

/** Resolve the global config directory path. */
export function getConfigDir(override?: string): string {
  if (override) return path.resolve(override);
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/** Resolve the config.json file path. */
export function getConfigPath(override?: string): string {
  return path.join(getConfigDir(override), CONFIG_FILE_NAME);
}

/** Ensure the config directory exists with secure permissions. */
export async function ensureConfigDir(override?: string): Promise<string> {
  const dir = getConfigDir(override);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/** Load config from disk. Returns empty config if file doesn't exist. */
export async function loadConfig(override?: string): Promise<CliConfig> {
  const filePath = getConfigPath(override);
  if (!existsSync(filePath)) return {};

  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

/** Save config to disk (creates dir if needed). */
export async function saveConfig(config: CliConfig, override?: string): Promise<void> {
  await ensureConfigDir(override);
  const filePath = getConfigPath(override);
  await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** Merge partial updates into existing config. */
export async function updateConfig(updates: Partial<CliConfig>, override?: string): Promise<CliConfig> {
  const existing = await loadConfig(override);
  const merged = { ...existing, ...updates };
  await saveConfig(merged, override);
  return merged;
}

/** Get a single config value by key. */
export async function getConfigValue(key: string, override?: string): Promise<unknown> {
  const config = await loadConfig(override);
  if (!key) return undefined;

  // Support dot-path keys (e.g. "ui.theme").
  if (key.includes('.')) {
    const parts = key.split('.').filter(Boolean);
    let cur: unknown = config as unknown;
    for (const p of parts) {
      if (typeof cur !== 'object' || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[p];
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  return (config as Record<string, unknown>)[key];
}

/** Set a single config value by key. */
export async function setConfigValue(key: string, value: unknown, override?: string): Promise<void> {
  const config = await loadConfig(override);
  if (!key) return;

  // Support dot-path keys (e.g. "ui.theme").
  if (key.includes('.')) {
    const parts = key.split('.').filter(Boolean);
    let cur: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const isLast = i === parts.length - 1;
      if (isLast) {
        cur[p] = value;
        break;
      }
      const next = cur[p];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        cur[p] = {};
      }
      cur = cur[p] as Record<string, unknown>;
    }
  } else {
    (config as Record<string, unknown>)[key] = value;
  }
  await saveConfig(config, override);
}
