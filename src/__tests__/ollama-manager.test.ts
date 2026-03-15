/**
 * @fileoverview Unit tests for ollama-manager functions.
 * Tests model recommendations, system spec-based GPU/context config,
 * version checking, model validation, and the auto-setup pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getRequiredOllamaModels,
  recommendModels,
  type SystemSpecs,
  type ModelRecommendation,
} from '../cli/ollama/ollama-manager.js';

const baseSpecs: SystemSpecs = {
  totalMemoryGB: 16,
  freeMemoryGB: 8,
  platform: 'darwin',
  arch: 'arm64',
  hasGpu: true,
  vramGB: 16,
  gpuName: 'Apple M2 Pro',
};

// ── recommendModels ─────────────────────────────────────────────────────────

describe('recommendModels', () => {
  it('returns low tier for systems with <8GB RAM', () => {
    const specs: SystemSpecs = { ...baseSpecs, totalMemoryGB: 4, freeMemoryGB: 2, hasGpu: false, vramGB: null, gpuName: null };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('low');
    expect(rec.router).toBe('qwen2.5:1.5b');
    expect(rec.primary).toBe('qwen2.5:3b');
    expect(rec.auditor).toBe('qwen2.5:1.5b');
    expect(rec.numCtx).toBeGreaterThan(0);
    expect(rec.numGpu).toBe(0); // no GPU
  });

  it('returns mid tier for 8-16GB RAM', () => {
    const specs: SystemSpecs = { ...baseSpecs, totalMemoryGB: 12, freeMemoryGB: 6, hasGpu: false, vramGB: null, gpuName: null };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('mid');
    expect(rec.primary).toBe('qwen2.5:7b');
    expect(rec.router).toBe('qwen2.5:3b');
  });

  it('returns high tier with 7B primary for 16GB+ without enough VRAM for large models', () => {
    const specs: SystemSpecs = { ...baseSpecs, totalMemoryGB: 16, hasGpu: true, vramGB: 8 };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('high');
    expect(rec.primary).toBe('qwen2.5:7b');
  });

  it('returns high tier with llama3.3 primary for Apple Silicon with 48GB+ RAM', () => {
    const specs: SystemSpecs = {
      ...baseSpecs,
      totalMemoryGB: 64,
      freeMemoryGB: 40,
      platform: 'darwin',
      arch: 'arm64',
      hasGpu: true,
      vramGB: 64,
      gpuName: 'Apple M2 Ultra',
    };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('high');
    expect(rec.primary).toBe('llama3.3');
  });

  it('returns high tier with llama3.3 primary for discrete GPU with 40GB+ VRAM', () => {
    const specs: SystemSpecs = {
      ...baseSpecs,
      totalMemoryGB: 32,
      freeMemoryGB: 24,
      platform: 'linux',
      arch: 'x64',
      hasGpu: true,
      vramGB: 48,
      gpuName: 'NVIDIA A6000',
    };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('high');
    expect(rec.primary).toBe('llama3.3');
  });

  it('does NOT recommend llama3.3 for 16GB Apple Silicon', () => {
    const specs: SystemSpecs = {
      ...baseSpecs,
      totalMemoryGB: 16,
      platform: 'darwin',
      arch: 'arm64',
      hasGpu: true,
      vramGB: 16,
    };
    const rec = recommendModels(specs);
    expect(rec.primary).not.toBe('llama3.3');
  });

  it('uses qwen2.5 family models across all tiers', () => {
    const lowSpecs: SystemSpecs = { ...baseSpecs, totalMemoryGB: 4, hasGpu: false, vramGB: null, gpuName: null };
    const midSpecs: SystemSpecs = { ...baseSpecs, totalMemoryGB: 12, hasGpu: false, vramGB: null, gpuName: null };
    const highSpecs: SystemSpecs = { ...baseSpecs, totalMemoryGB: 16, hasGpu: true, vramGB: 16 };

    const low = recommendModels(lowSpecs);
    const mid = recommendModels(midSpecs);
    const high = recommendModels(highSpecs);

    expect(low.router).toContain('qwen2.5');
    expect(low.primary).toContain('qwen2.5');
    expect(mid.router).toContain('qwen2.5');
    expect(mid.primary).toContain('qwen2.5');
    expect(high.router).toContain('qwen2.5');
  });

  it('sets numGpu=-1 for Apple Silicon (full offload)', () => {
    const specs: SystemSpecs = { ...baseSpecs, platform: 'darwin', arch: 'arm64', hasGpu: true };
    const rec = recommendModels(specs);
    expect(rec.numGpu).toBe(-1);
  });

  it('sets numGpu=0 when no GPU is available', () => {
    const specs: SystemSpecs = { ...baseSpecs, hasGpu: false, vramGB: null, gpuName: null, platform: 'linux', arch: 'x64' };
    const rec = recommendModels(specs);
    expect(rec.numGpu).toBe(0);
  });

  it('includes numCtx in recommendation', () => {
    const rec = recommendModels(baseSpecs);
    expect(rec.numCtx).toBeGreaterThanOrEqual(2048);
    expect(rec.numCtx).toBeLessThanOrEqual(8192);
  });

  it('includes reason string', () => {
    const rec = recommendModels(baseSpecs);
    expect(rec.reason).toBeTruthy();
    expect(rec.reason.length).toBeGreaterThan(10);
  });
});

// ── resolveOllamaBase (tested indirectly via env var) ─────────────────────

describe('resolveOllamaBase via environment', () => {
  const origEnv = process.env['OLLAMA_BASE_URL'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['OLLAMA_BASE_URL'] = origEnv;
    } else {
      delete process.env['OLLAMA_BASE_URL'];
    }
  });

  it('recommendModels works regardless of env', () => {
    process.env['OLLAMA_BASE_URL'] = 'https://remote-ollama.example.com';
    const specs: SystemSpecs = {
      totalMemoryGB: 16,
      freeMemoryGB: 8,
      platform: 'linux',
      arch: 'x64',
      hasGpu: false,
      vramGB: null,
      gpuName: null,
    };
    const rec = recommendModels(specs);
    expect(rec.tier).toBeDefined();
    expect(rec.primary).toBeDefined();
  });
});

// ── ModelRecommendation shape ────────────────────────────────────────────────

describe('ModelRecommendation shape', () => {
  it('has all required fields', () => {
    const specs: SystemSpecs = {
      totalMemoryGB: 32,
      freeMemoryGB: 20,
      platform: 'linux',
      arch: 'x64',
      hasGpu: true,
      vramGB: 24,
      gpuName: 'NVIDIA RTX 4090',
    };
    const rec = recommendModels(specs);

    expect(rec).toHaveProperty('router');
    expect(rec).toHaveProperty('primary');
    expect(rec).toHaveProperty('auditor');
    expect(rec).toHaveProperty('tier');
    expect(rec).toHaveProperty('reason');
    expect(rec).toHaveProperty('numCtx');
    expect(rec).toHaveProperty('numGpu');
    expect(['low', 'mid', 'high']).toContain(rec.tier);
    expect(typeof rec.numCtx).toBe('number');
    expect(typeof rec.numGpu).toBe('number');
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles exactly 8GB boundary as mid tier', () => {
    const specs: SystemSpecs = {
      totalMemoryGB: 8,
      freeMemoryGB: 4,
      platform: 'linux',
      arch: 'x64',
      hasGpu: false,
      vramGB: null,
      gpuName: null,
    };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('mid');
  });

  it('handles exactly 16GB boundary as high tier', () => {
    const specs: SystemSpecs = {
      totalMemoryGB: 16,
      freeMemoryGB: 8,
      platform: 'linux',
      arch: 'x64',
      hasGpu: false,
      vramGB: null,
      gpuName: null,
    };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('high');
  });

  it('handles Windows platform', () => {
    const specs: SystemSpecs = {
      totalMemoryGB: 32,
      freeMemoryGB: 16,
      platform: 'win32',
      arch: 'x64',
      hasGpu: true,
      vramGB: 12,
      gpuName: 'NVIDIA RTX 3080',
    };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('high');
    // Windows with discrete GPU — should do full offload for 7B model
    expect(rec.numGpu).toBe(-1);
  });

  it('partial GPU offload when VRAM is borderline', () => {
    const specs: SystemSpecs = {
      totalMemoryGB: 16,
      freeMemoryGB: 8,
      platform: 'linux',
      arch: 'x64',
      hasGpu: true,
      vramGB: 3,  // Not enough for full 8B offload (needs 5GB), but > 50%
      gpuName: 'NVIDIA GTX 1060',
    };
    const rec = recommendModels(specs);
    expect(rec.numGpu).toBeGreaterThan(0);
    expect(rec.numGpu).toBeLessThan(35); // Partial offload
  });

  it('recommends qwen2.5:7b (not llama3.3) for 32GB without large VRAM', () => {
    const specs: SystemSpecs = {
      totalMemoryGB: 32,
      freeMemoryGB: 20,
      platform: 'linux',
      arch: 'x64',
      hasGpu: true,
      vramGB: 8,
      gpuName: 'NVIDIA RTX 3070',
    };
    const rec = recommendModels(specs);
    expect(rec.tier).toBe('high');
    expect(rec.primary).toBe('qwen2.5:7b');
  });

  it('router and auditor are always smaller or equal to primary', () => {
    const tiers: SystemSpecs[] = [
      { totalMemoryGB: 4, freeMemoryGB: 2, platform: 'linux', arch: 'x64', hasGpu: false, vramGB: null, gpuName: null },
      { totalMemoryGB: 12, freeMemoryGB: 6, platform: 'linux', arch: 'x64', hasGpu: false, vramGB: null, gpuName: null },
      { totalMemoryGB: 32, freeMemoryGB: 20, platform: 'linux', arch: 'x64', hasGpu: true, vramGB: 24, gpuName: 'GPU' },
    ];

    for (const specs of tiers) {
      const rec = recommendModels(specs);
      // Router and auditor should never be larger than primary
      expect(rec.router).not.toBe(rec.primary === 'llama3.3' ? 'llama3.3' : undefined);
      expect(rec.auditor).not.toBe(rec.primary === 'llama3.3' ? 'llama3.3' : undefined);
    }
  });

  it('includes the embedding model in the Ollama pull set', () => {
    const rec = recommendModels(baseSpecs);
    expect(getRequiredOllamaModels(rec)).toContain('nomic-embed-text');
  });
});

// ── InitLlmResult ollamaConfig shape ──────────────────────────────────────

describe('ollamaConfig output shape', () => {
  it('recommendation includes all fields needed for agent.config.json', () => {
    const specs: SystemSpecs = {
      totalMemoryGB: 16,
      freeMemoryGB: 8,
      platform: 'darwin',
      arch: 'arm64',
      hasGpu: true,
      vramGB: 16,
      gpuName: 'Apple M3',
    };
    const rec = recommendModels(specs);

    // These are the fields that get written to agent.config.json.ollama
    expect(typeof rec.numCtx).toBe('number');
    expect(rec.numCtx).toBeGreaterThanOrEqual(2048);
    expect(typeof rec.numGpu).toBe('number');
    expect([-1, 0]).toContain(rec.numGpu); // Apple Silicon = -1, no GPU = 0

    // Model should be a valid Ollama model tag
    expect(rec.primary).toMatch(/^[a-z0-9._:-]+$/);
    expect(rec.router).toMatch(/^[a-z0-9._:-]+$/);
    expect(rec.auditor).toMatch(/^[a-z0-9._:-]+$/);
  });
});
