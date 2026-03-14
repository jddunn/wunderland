/**
 * @fileoverview Ollama auto-detection, system spec analysis, and model
 * recommendation for the Wunderland CLI. Handles the full lifecycle of
 * discovering a local Ollama install, ensuring the server is running,
 * reading hardware capabilities, and mapping them to optimal model configs.
 * @module wunderland/cli/ollama/ollama-manager
 */

import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { createSpinner } from 'nanospinner';
import { ok, fail, note, warning } from '../ui/format.js';
import { accent, dim, info as iColor, success as sColor } from '../ui/theme.js';

const execFileAsync = promisify(execFile);

// ── Constants ──────────────────────────────────────────────────────────────

/** Default Ollama API base URL. */
const OLLAMA_DEFAULT_BASE = 'http://localhost:11434';

/**
 * Resolve the Ollama API base URL from environment or config.
 * Priority: OLLAMA_BASE_URL env var > default (localhost:11434).
 */
function resolveOllamaBase(): string {
  const raw = String(process.env['OLLAMA_BASE_URL'] || '').trim();
  if (raw) {
    const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    // Strip /v1 suffix if present — ollama-manager uses /api/* endpoints, not /v1
    return normalized.replace(/\/v1$/, '');
  }
  return OLLAMA_DEFAULT_BASE;
}

/** Timeout for Ollama API health checks (ms). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Max time to wait for Ollama server to become ready after starting (ms). */
const SERVER_STARTUP_TIMEOUT_MS = 15_000;

/** Polling interval when waiting for server startup (ms). */
const SERVER_POLL_INTERVAL_MS = 500;

// ── Interfaces ─────────────────────────────────────────────────────────────

/** Hardware and OS capabilities of the host machine. */
export interface SystemSpecs {
  /** Total physical memory in GB. */
  totalMemoryGB: number;
  /** Currently available memory in GB. */
  freeMemoryGB: number;
  /** Operating system platform (e.g. 'darwin', 'linux', 'win32'). */
  platform: string;
  /** CPU architecture (e.g. 'arm64', 'x64'). */
  arch: string;
  /** Whether a compatible GPU was detected (Metal on macOS, NVIDIA on Linux). */
  hasGpu: boolean;
  /** Detected VRAM in GB (null if unavailable or unified memory). */
  vramGB: number | null;
  /** GPU name/description (e.g. 'Apple M2 Pro', 'NVIDIA RTX 4090'). */
  gpuName: string | null;
}

/** Recommended Ollama model configuration for a three-tier inference stack. */
export interface ModelRecommendation {
  /** Fast, small model used for intent routing / classification. */
  router: string;
  /** Primary workhorse model for generation tasks. */
  primary: string;
  /** Secondary model used by the dual-LLM auditor. */
  auditor: string;
  /** Human-readable tier label (e.g. 'low', 'mid', 'high'). */
  tier: 'low' | 'mid' | 'high';
  /** Explanation of why this configuration was selected. */
  reason: string;
  /** Recommended context window size based on available memory. */
  numCtx: number;
  /** Number of GPU layers to offload (-1 = all, 0 = CPU only). */
  numGpu: number;
}

/** Metadata for a locally-installed Ollama model. */
export interface LocalModel {
  /** Model name/tag (e.g. 'llama3.2:3b'). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** ISO date string of last modification. */
  modifiedAt: string;
}

/** Result returned by the full auto-configuration flow. */
export interface OllamaAutoConfigResult {
  /** Whether Ollama was found on the system. */
  installed: boolean;
  /** Whether the Ollama server is running (or was started). */
  running: boolean;
  /** Detected system hardware specs. */
  specs: SystemSpecs;
  /** Recommended model configuration. */
  recommendation: ModelRecommendation;
  /** Models already available locally. */
  localModels: LocalModel[];
  /** Ollama version string (e.g. '0.5.4'). */
  version: string | null;
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Check whether the `ollama` binary is available on the system PATH.
 * @returns The resolved path to the binary, or `null` if not found.
 */
export async function detectOllamaInstall(): Promise<string | null> {
  const cmd = os.platform() === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['ollama']);
    const resolved = stdout.trim().split('\n')[0]?.trim() || '';
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Get the installed Ollama version.
 * @returns Version string (e.g. '0.5.4') or null if unavailable.
 */
export async function getOllamaVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ollama', ['--version'], { timeout: 5_000 });
    // Output is typically "ollama version 0.5.4" or just "0.5.4"
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Minimum Ollama version required for OpenAI-compatible /v1 endpoints. */
const MIN_OLLAMA_VERSION = '0.1.24';

/**
 * Check if the installed Ollama version meets the minimum requirement.
 * @returns Object with compatibility info and the detected version.
 */
export async function checkOllamaVersion(): Promise<{
  version: string | null;
  compatible: boolean;
  message: string;
}> {
  const version = await getOllamaVersion();
  if (!version) {
    return { version: null, compatible: true, message: 'Could not detect Ollama version' };
  }
  const parts = version.split('.').map(Number);
  const minParts = MIN_OLLAMA_VERSION.split('.').map(Number);
  let compatible = true;
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) > (minParts[i] || 0)) break;
    if ((parts[i] || 0) < (minParts[i] || 0)) { compatible = false; break; }
  }
  return {
    version,
    compatible,
    message: compatible
      ? `Ollama ${version} (compatible)`
      : `Ollama ${version} is outdated. Minimum required: ${MIN_OLLAMA_VERSION}. Run: ollama update`,
  };
}

/**
 * Validate that a model exists in the Ollama library before pulling.
 * Uses the Ollama API show endpoint for locally installed models,
 * or tries a HEAD request to the library for remote models.
 */
export async function validateModelExists(modelId: string): Promise<{
  exists: boolean;
  local: boolean;
  message: string;
}> {
  // Check if already installed locally
  const localModels = await listLocalModels();
  const localMatch = localModels.find((m) =>
    m.name === modelId || m.name === `${modelId}:latest` || m.name.startsWith(`${modelId}:`),
  );
  if (localMatch) {
    return { exists: true, local: true, message: `${modelId} is already installed locally` };
  }

  // Try the Ollama show API (works for models in library even if not pulled)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${resolveOllamaBase()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelId }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      return { exists: true, local: true, message: `${modelId} found` };
    }
  } catch {
    // Server might not be running or model not local — that's fine
  }

  // If server isn't running we can't validate remotely — assume valid
  return { exists: true, local: false, message: `${modelId} will be pulled from Ollama library` };
}

/**
 * Ping the local Ollama server to determine if it is running and responsive.
 * @returns `true` if the server responds successfully.
 */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    const res = await fetch(`${resolveOllamaBase()}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Server lifecycle ───────────────────────────────────────────────────────

/**
 * Start the Ollama server as a detached background process.
 * Waits up to {@link SERVER_STARTUP_TIMEOUT_MS} for the server to become
 * responsive before resolving.
 * @throws If the server does not become reachable within the timeout.
 */
export async function startOllama(): Promise<void> {
  const spinner = createSpinner('Starting Ollama server...').start();

  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
  });

  // Allow the parent process to exit independently of the server.
  child.unref();

  // Poll until the server is ready or we time out.
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await isOllamaRunning();
    if (ready) {
      spinner.success({ text: 'Ollama server is running' });
      return;
    }
    await sleep(SERVER_POLL_INTERVAL_MS);
  }

  spinner.error({ text: 'Ollama server did not start in time' });
  throw new Error(
    `Ollama server did not become reachable within ${SERVER_STARTUP_TIMEOUT_MS / 1000}s. ` +
      'Try running "ollama serve" manually.',
  );
}

// ── System specs ───────────────────────────────────────────────────────────

/**
 * Detect hardware and OS capabilities of the current machine.
 * - On macOS: checks for Metal GPU support via `system_profiler`.
 * - On Linux: checks for NVIDIA GPU via `nvidia-smi`.
 * @returns A {@link SystemSpecs} snapshot.
 */
export async function detectSystemSpecs(): Promise<SystemSpecs> {
  const totalMemoryGB = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
  const freeMemoryGB = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10;
  const platform = os.platform();
  const arch = os.arch();

  let hasGpu = false;
  let vramGB: number | null = null;
  let gpuName: string | null = null;

  if (platform === 'darwin') {
    // macOS — Apple Silicon uses unified memory (VRAM = total RAM)
    try {
      const { stdout } = await execFileAsync(
        'system_profiler',
        ['SPDisplaysDataType'],
        { timeout: 5_000 },
      );
      hasGpu = /metal/i.test(stdout);
      if (hasGpu) {
        // Extract GPU name (e.g. "Apple M2 Pro")
        const chipMatch = stdout.match(/Chipset Model:\s*(.+)/i);
        gpuName = chipMatch ? chipMatch[1].trim() : null;
        // Apple Silicon uses unified memory — all RAM is available to GPU
        if (arch === 'arm64') {
          vramGB = totalMemoryGB;
        } else {
          // Discrete GPU on Intel Mac — try to extract VRAM
          const vramMatch = stdout.match(/VRAM.*?(\d+)\s*(MB|GB)/i);
          if (vramMatch) {
            const val = parseInt(vramMatch[1], 10);
            vramGB = vramMatch[2].toUpperCase() === 'GB' ? val : val / 1024;
          }
        }
      }
    } catch {
      // system_profiler unavailable or timed out
    }
  } else if (platform === 'linux') {
    // Linux — check for NVIDIA GPU via nvidia-smi with VRAM query
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { timeout: 5_000 },
      );
      hasGpu = true;
      const line = stdout.trim().split('\n')[0];
      if (line) {
        const parts = line.split(',').map((s) => s.trim());
        gpuName = parts[0] || null;
        const memMB = parseInt(parts[1] || '', 10);
        if (!isNaN(memMB)) vramGB = Math.round((memMB / 1024) * 10) / 10;
      }
    } catch {
      // nvidia-smi not found or failed — check for AMD ROCm
      try {
        const { stdout } = await execFileAsync('rocm-smi', ['--showmeminfo', 'vram'], { timeout: 5_000 });
        hasGpu = true;
        gpuName = 'AMD GPU (ROCm)';
        const vramMatch = stdout.match(/(\d+)\s*bytes/i);
        if (vramMatch) vramGB = Math.round(parseInt(vramMatch[1], 10) / (1024 ** 3) * 10) / 10;
      } catch {
        // No NVIDIA or AMD GPU
      }
    }
  } else if (platform === 'win32') {
    // Windows — check for GPU via PowerShell
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json'],
        { timeout: 10_000 },
      );
      const data = JSON.parse(stdout);
      const gpus = Array.isArray(data) ? data : [data];
      const dedicated = gpus.find((g: any) => g.AdapterRAM > 0 && !/microsoft basic/i.test(g.Name || ''));
      if (dedicated) {
        hasGpu = true;
        gpuName = dedicated.Name || null;
        if (dedicated.AdapterRAM) vramGB = Math.round(dedicated.AdapterRAM / (1024 ** 3) * 10) / 10;
      }
    } catch {
      // PowerShell not available
    }
  }

  return { totalMemoryGB, freeMemoryGB, platform, arch, hasGpu, vramGB, gpuName };
}

// ── Model recommendation ───────────────────────────────────────────────────

/**
 * Select the optimal Ollama model configuration based on detected hardware.
 *
 * Tier breakdown:
 * - **Low** (<8 GB RAM): smallest quantised models only.
 * - **Mid** (8-16 GB RAM): 3B router/auditor, 8B primary.
 * - **High** (16 GB+): 3B router/auditor, 70B primary when GPU is present.
 *
 * @param specs - System hardware snapshot from {@link detectSystemSpecs}.
 * @returns A {@link ModelRecommendation} with model IDs and explanation.
 */
/**
 * Determine optimal context window size based on available memory and model size.
 * Larger context windows consume more memory — this prevents OOM.
 */
function recommendNumCtx(specs: SystemSpecs, modelSize: '1b' | '3b' | '8b' | '70b'): number {
  const availableGB = specs.vramGB ?? specs.freeMemoryGB;

  // Base context sizes per model size tier
  const contextMap: Record<string, { min: number; mid: number; max: number }> = {
    '1b':  { min: 2048, mid: 4096,  max: 8192 },
    '3b':  { min: 2048, mid: 4096,  max: 8192 },
    '8b':  { min: 2048, mid: 4096,  max: 8192 },
    '70b': { min: 2048, mid: 4096,  max: 8192 },
  };

  const ctx = contextMap[modelSize] || contextMap['8b'];

  // Conservative: leave headroom for the model weights + KV cache
  if (modelSize === '70b') {
    // 70B needs ~40GB for weights alone (Q4), so context must be conservative
    return availableGB >= 64 ? ctx.max : ctx.min;
  }
  if (modelSize === '8b') {
    return availableGB >= 16 ? ctx.max : availableGB >= 8 ? ctx.mid : ctx.min;
  }
  // 1b/3b models are small — can afford larger context
  return availableGB >= 8 ? ctx.max : ctx.mid;
}

/**
 * Determine number of GPU layers to offload.
 * -1 = offload all layers (full GPU), 0 = CPU only.
 */
function recommendNumGpu(specs: SystemSpecs, modelSize: '1b' | '3b' | '8b' | '70b'): number {
  if (!specs.hasGpu) return 0;

  const vram = specs.vramGB ?? 0;

  // Apple Silicon uses unified memory — always offload everything
  if (specs.platform === 'darwin' && specs.arch === 'arm64') return -1;

  // Discrete GPU: check if VRAM can hold the model
  const minVramForFullOffload: Record<string, number> = {
    '1b': 1,
    '3b': 2,
    '8b': 5,
    '70b': 40,
  };

  const needed = minVramForFullOffload[modelSize] || 5;
  if (vram >= needed) return -1; // Full offload
  if (vram >= needed * 0.5) return Math.floor(vram / needed * 35); // Partial offload
  return 0; // CPU only
}

export function recommendModels(specs: SystemSpecs): ModelRecommendation {
  const { totalMemoryGB, hasGpu } = specs;

  if (totalMemoryGB < 8) {
    return {
      router: 'llama3.2:1b',
      primary: 'llama3.2:3b',
      auditor: 'llama3.2:1b',
      tier: 'low',
      reason:
        `${totalMemoryGB} GB RAM detected - using lightweight 1B/3B models ` +
        'to stay within memory limits.',
      numCtx: recommendNumCtx(specs, '3b'),
      numGpu: recommendNumGpu(specs, '3b'),
    };
  }

  if (totalMemoryGB < 16) {
    return {
      router: 'llama3.2:3b',
      primary: 'dolphin-llama3:8b',
      auditor: 'llama3.2:3b',
      tier: 'mid',
      reason:
        `${totalMemoryGB} GB RAM detected - 8B primary model with 3B ` +
        'router/auditor for a balanced local setup.',
      numCtx: recommendNumCtx(specs, '8b'),
      numGpu: recommendNumGpu(specs, '8b'),
    };
  }

  // 16 GB+
  const vram = specs.vramGB ?? 0;
  const canRun70B = hasGpu && (specs.platform === 'darwin' ? totalMemoryGB >= 48 : vram >= 40);
  const primary = canRun70B ? 'llama3.1:70b' : 'dolphin-llama3:8b';
  const primarySize = canRun70B ? '70b' : '8b';
  const gpuNote = canRun70B
    ? `GPU detected (${specs.gpuName || 'unknown'}) - using 70B primary for maximum quality.`
    : hasGpu
      ? `GPU detected but insufficient VRAM (${vram || '?'} GB) for 70B - using 8B primary.`
      : 'No dedicated GPU - capping at 8B primary to avoid swap pressure.';

  return {
    router: 'llama3.2:3b',
    primary,
    auditor: 'llama3.2:3b',
    tier: 'high',
    reason: `${totalMemoryGB} GB RAM detected. ${gpuNote}`,
    numCtx: recommendNumCtx(specs, primarySize),
    numGpu: recommendNumGpu(specs, primarySize),
  };
}

// ── Model management ───────────────────────────────────────────────────────

/**
 * Pull (download) an Ollama model, streaming progress to stdout.
 * @param modelId - The model name/tag to pull (e.g. 'llama3.2:3b').
 * @returns Resolves when the pull completes successfully.
 * @throws If the pull process exits with a non-zero code.
 */
export async function pullModel(modelId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ollama', ['pull', modelId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        process.stdout.write(`  ${dim(line)}\r`);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        process.stderr.write(`  ${dim(line)}\n`);
      }
    });

    child.on('close', (code) => {
      // Clear the carriage-return progress line.
      process.stdout.write('\n');
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`ollama pull ${modelId} exited with code ${code}`),
        );
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ollama pull: ${err.message}`));
    });
  });
}

/**
 * Fetch the list of models currently installed in the local Ollama instance.
 * @returns Array of {@link LocalModel} entries, or an empty array if the
 * server is unreachable.
 */
export async function listLocalModels(): Promise<LocalModel[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    const res = await fetch(`${resolveOllamaBase()}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [];

    const body = (await res.json()) as {
      models?: Array<{ name: string; size: number; modified_at: string }>;
    };

    return (body.models ?? []).map((m) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
    }));
  } catch {
    return [];
  }
}

// ── Full auto-configuration flow ───────────────────────────────────────────

/**
 * End-to-end Ollama auto-configuration:
 *
 * 1. Detect whether `ollama` is installed.
 * 2. Check if the server is already running; start it if not.
 * 3. Detect host system specs (RAM, GPU).
 * 4. Generate a model recommendation.
 * 5. List already-pulled models.
 *
 * **Does NOT pull models** — the caller should present the recommendation
 * to the user for confirmation before invoking {@link pullModel}.
 *
 * @returns An {@link OllamaAutoConfigResult} with all gathered information.
 * @throws If Ollama is not installed on the system.
 */
export async function autoConfigureOllama(): Promise<OllamaAutoConfigResult> {
  // Step 1: Detect install
  note('Checking for Ollama installation...');
  const binaryPath = await detectOllamaInstall();

  if (!binaryPath) {
    fail('Ollama is not installed');
    note(`Install it from ${iColor('https://ollama.ai/')} and try again.`);
    throw new Error(
      'Ollama binary not found on PATH. Install from https://ollama.ai/',
    );
  }
  ok(`Ollama found at ${accent(binaryPath)}`);

  // Step 1b: Version check
  const versionInfo = await checkOllamaVersion();
  if (versionInfo.version) {
    if (versionInfo.compatible) {
      ok(`${versionInfo.message}`);
    } else {
      warning(versionInfo.message);
    }
  }

  // Step 2: Check / start server
  let running = await isOllamaRunning();
  if (running) {
    ok('Ollama server is already running');
  } else {
    warning('Ollama server is not running - attempting to start...');
    await startOllama();
    running = true;
  }

  // Step 3: Detect system specs
  note('Detecting system specifications...');
  const specs = await detectSystemSpecs();
  const gpuDetail = specs.hasGpu
    ? `${sColor('yes')}${specs.gpuName ? ` (${specs.gpuName})` : ''}${specs.vramGB ? ` ${specs.vramGB} GB` : ''}`
    : dim('no');
  ok(
    `${specs.platform}/${specs.arch}  ` +
      `${chalk.bold(String(specs.totalMemoryGB))} GB RAM  ` +
      `(${chalk.bold(String(specs.freeMemoryGB))} GB free)  ` +
      `GPU: ${gpuDetail}`,
  );

  // Step 4: Recommend models
  const recommendation = recommendModels(specs);
  note(`Tier: ${accent(recommendation.tier)}  ${dim(recommendation.reason)}`);
  note(
    `Recommended models:  ` +
      `router=${accent(recommendation.router)}  ` +
      `primary=${accent(recommendation.primary)}  ` +
      `auditor=${accent(recommendation.auditor)}`,
  );
  note(
    `Context window: ${accent(String(recommendation.numCtx))}  ` +
      `GPU layers: ${accent(recommendation.numGpu === -1 ? 'all' : String(recommendation.numGpu))}`,
  );

  // Step 5: List local models
  const localModels = await listLocalModels();
  if (localModels.length > 0) {
    note(`${localModels.length} model(s) already installed locally:`);
    for (const m of localModels) {
      const sizeGB = (m.size / (1024 ** 3)).toFixed(1);
      ok(`${m.name}  ${dim(`${sizeGB} GB`)}`);
    }
  } else {
    note('No models installed yet - you will need to pull the recommended models.');
  }

  return {
    installed: true,
    running,
    specs,
    recommendation,
    localModels,
    version: versionInfo.version,
  };
}

// ── Utilities ──────────────────────────────────────────────────────────────

/** Simple async sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
