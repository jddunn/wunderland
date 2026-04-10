// @ts-nocheck
/**
 * @fileoverview Agent history — tracks recently used agents across sessions.
 * Persisted at ~/.wunderland/agent-history.json.
 * @module wunderland/cli/config/agent-history
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { getConfigDir, ensureConfigDir } from './config-manager.js';

const HISTORY_FILE = 'agent-history.json';
const MAX_ENTRIES = 50;

export interface AgentHistoryEntry {
  seedId: string;
  displayName: string;
  /** Absolute path to agent.config.json. */
  configPath: string;
  /** ISO 8601 timestamp of last successful start. */
  lastStarted: string;
}

function getHistoryPath(configDirOverride?: string): string {
  return path.join(getConfigDir(configDirOverride), HISTORY_FILE);
}

/** Read agent history from disk. Returns empty array if file doesn't exist. */
export function readAgentHistory(configDirOverride?: string): AgentHistoryEntry[] {
  const filePath = getHistoryPath(configDirOverride);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Record (or update) an agent start in history. Deduplicates by seedId. */
export async function recordAgentStart(
  entry: Omit<AgentHistoryEntry, 'lastStarted'>,
  configDirOverride?: string,
): Promise<void> {
  await ensureConfigDir(configDirOverride);
  const filePath = getHistoryPath(configDirOverride);

  const history = readAgentHistory(configDirOverride);

  // Remove existing entry for this seedId (will re-add at front)
  const filtered = history.filter((h) => h.seedId !== entry.seedId);

  const newEntry: AgentHistoryEntry = {
    ...entry,
    configPath: path.resolve(entry.configPath),
    lastStarted: new Date().toISOString(),
  };

  // Prepend and cap at MAX_ENTRIES
  const updated = [newEntry, ...filtered].slice(0, MAX_ENTRIES);

  await writeFile(filePath, JSON.stringify(updated, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}
