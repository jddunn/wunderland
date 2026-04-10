// @ts-nocheck
/**
 * @fileoverview Tests for BM25 and RAPTOR state persistence.
 *
 * Verifies save/load round-trips, corpus hash invalidation, and graceful
 * handling of missing/corrupted files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  saveBM25State,
  loadBM25State,
  saveRaptorState,
  loadRaptorState,
  computeCorpusHash,
  getBM25StateAge,
  getRaptorStateAge,
  type SerializedBM25State,
  type SerializedRaptorState,
} from '../runtime/rag-state-persistence.js';

// ── Helpers ────────────────────────────────────────────────────────────

const silentLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rag-persist-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Cleanup best-effort
  }
});

// ── BM25 Persistence ─────────────────────────────────────────────────

describe('BM25 persistence', () => {
  const createBM25State = (overrides?: Partial<SerializedBM25State>): SerializedBM25State => ({
    version: 1,
    k1: 1.2,
    b: 0.75,
    documents: [
      { id: 'doc-1', text: 'TypeScript compiler error TS2304' },
      { id: 'doc-2', text: 'JavaScript runtime TypeError explanation' },
    ],
    corpusHash: 'abc123',
    savedAt: new Date().toISOString(),
    ...overrides,
  });

  it('round-trips BM25 state through save and load', async () => {
    const state = createBM25State();
    const saved = await saveBM25State(state, { agentDir: tempDir, logger: silentLogger });
    expect(saved).toBe(true);

    const loaded = await loadBM25State({ agentDir: tempDir, logger: silentLogger });
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.documents).toHaveLength(2);
    expect(loaded!.documents[0].id).toBe('doc-1');
    expect(loaded!.k1).toBe(1.2);
    expect(loaded!.b).toBe(0.75);
    expect(loaded!.corpusHash).toBe('abc123');
  });

  it('returns null when no BM25 file exists', async () => {
    const loaded = await loadBM25State({ agentDir: tempDir, logger: silentLogger });
    expect(loaded).toBeNull();
  });

  it('rejects BM25 state when corpus hash does not match', async () => {
    const state = createBM25State({ corpusHash: 'old-hash' });
    await saveBM25State(state, { agentDir: tempDir, logger: silentLogger });

    const loaded = await loadBM25State(
      { agentDir: tempDir, logger: silentLogger },
      'new-hash',
    );
    expect(loaded).toBeNull();
  });

  it('accepts BM25 state when corpus hash matches', async () => {
    const state = createBM25State({ corpusHash: 'match-hash' });
    await saveBM25State(state, { agentDir: tempDir, logger: silentLogger });

    const loaded = await loadBM25State(
      { agentDir: tempDir, logger: silentLogger },
      'match-hash',
    );
    expect(loaded).not.toBeNull();
    expect(loaded!.documents).toHaveLength(2);
  });

  it('loads without hash check when no expectedCorpusHash provided', async () => {
    const state = createBM25State({ corpusHash: 'anything' });
    await saveBM25State(state, { agentDir: tempDir, logger: silentLogger });

    const loaded = await loadBM25State({ agentDir: tempDir, logger: silentLogger });
    expect(loaded).not.toBeNull();
  });

  it('rejects BM25 state with wrong version', async () => {
    const state = createBM25State();
    (state as any).version = 99;
    await saveBM25State(state as any, { agentDir: tempDir, logger: silentLogger });

    const loaded = await loadBM25State({ agentDir: tempDir, logger: silentLogger });
    expect(loaded).toBeNull();
  });

  it('returns age of BM25 index file', async () => {
    const state = createBM25State();
    await saveBM25State(state, { agentDir: tempDir, logger: silentLogger });

    const age = await getBM25StateAge({ agentDir: tempDir, logger: silentLogger });
    expect(age).not.toBeNull();
    // Should be a valid ISO timestamp
    expect(new Date(age!).getTime()).toBeGreaterThan(0);
  });

  it('returns null age when no BM25 file exists', async () => {
    const age = await getBM25StateAge({ agentDir: tempDir, logger: silentLogger });
    expect(age).toBeNull();
  });

  it('creates nested directories when saving', async () => {
    const nestedDir = join(tempDir, 'nested', 'agent');
    const state = createBM25State();
    const saved = await saveBM25State(state, { agentDir: nestedDir, logger: silentLogger });
    expect(saved).toBe(true);
    expect(existsSync(join(nestedDir, 'bm25-index.json'))).toBe(true);
  });
});

// ── RAPTOR Persistence ───────────────────────────────────────────────

describe('RAPTOR persistence', () => {
  const createRaptorState = (overrides?: Partial<SerializedRaptorState>): SerializedRaptorState => ({
    version: 1,
    totalLayers: 3,
    nodesPerLayer: { 0: 100, 1: 12, 2: 3 },
    totalNodes: 115,
    totalClusters: 15,
    buildTimeMs: 5000,
    corpusHash: 'raptor-abc',
    savedAt: new Date().toISOString(),
    ...overrides,
  });

  it('round-trips RAPTOR state through save and load', async () => {
    const state = createRaptorState();
    const saved = await saveRaptorState(state, { agentDir: tempDir, logger: silentLogger });
    expect(saved).toBe(true);

    const loaded = await loadRaptorState({ agentDir: tempDir, logger: silentLogger });
    expect(loaded).not.toBeNull();
    expect(loaded!.totalLayers).toBe(3);
    expect(loaded!.totalNodes).toBe(115);
    expect(loaded!.totalClusters).toBe(15);
    expect(loaded!.nodesPerLayer[0]).toBe(100);
  });

  it('returns null when no RAPTOR file exists', async () => {
    const loaded = await loadRaptorState({ agentDir: tempDir, logger: silentLogger });
    expect(loaded).toBeNull();
  });

  it('rejects RAPTOR state when corpus hash does not match', async () => {
    const state = createRaptorState({ corpusHash: 'old-raptor' });
    await saveRaptorState(state, { agentDir: tempDir, logger: silentLogger });

    const loaded = await loadRaptorState(
      { agentDir: tempDir, logger: silentLogger },
      'new-raptor',
    );
    expect(loaded).toBeNull();
  });

  it('accepts RAPTOR state when corpus hash matches', async () => {
    const state = createRaptorState({ corpusHash: 'same-hash' });
    await saveRaptorState(state, { agentDir: tempDir, logger: silentLogger });

    const loaded = await loadRaptorState(
      { agentDir: tempDir, logger: silentLogger },
      'same-hash',
    );
    expect(loaded).not.toBeNull();
    expect(loaded!.totalLayers).toBe(3);
  });

  it('rejects RAPTOR state with wrong version', async () => {
    const state = createRaptorState();
    (state as any).version = 2;
    await saveRaptorState(state as any, { agentDir: tempDir, logger: silentLogger });

    const loaded = await loadRaptorState({ agentDir: tempDir, logger: silentLogger });
    expect(loaded).toBeNull();
  });

  it('returns age of RAPTOR tree file', async () => {
    const state = createRaptorState();
    await saveRaptorState(state, { agentDir: tempDir, logger: silentLogger });

    const age = await getRaptorStateAge({ agentDir: tempDir, logger: silentLogger });
    expect(age).not.toBeNull();
    expect(new Date(age!).getTime()).toBeGreaterThan(0);
  });

  it('returns null age when no RAPTOR file exists', async () => {
    const age = await getRaptorStateAge({ agentDir: tempDir, logger: silentLogger });
    expect(age).toBeNull();
  });
});

// ── Corpus Hash ──────────────────────────────────────────────────────

describe('computeCorpusHash', () => {
  it('produces consistent hash for same paths', () => {
    const paths = ['/a/b/docs', '/c/d/docs', '/e/f/docs'];
    const hash1 = computeCorpusHash(paths);
    const hash2 = computeCorpusHash(paths);
    expect(hash1).toBe(hash2);
  });

  it('produces same hash regardless of input order (paths are sorted)', () => {
    const hash1 = computeCorpusHash(['/z/docs', '/a/docs', '/m/docs']);
    const hash2 = computeCorpusHash(['/a/docs', '/m/docs', '/z/docs']);
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different paths', () => {
    const hash1 = computeCorpusHash(['/a/docs']);
    const hash2 = computeCorpusHash(['/b/docs']);
    expect(hash1).not.toBe(hash2);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = computeCorpusHash(['/some/path']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
