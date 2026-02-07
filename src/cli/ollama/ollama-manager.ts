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
const OLLAMA_API_BASE = 'http://localhost:11434';

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
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Check whether the `ollama` binary is available on the system PATH.
 * @returns The resolved path to the binary, or `null` if not found.
 */
export async function detectOllamaInstall(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', ['ollama']);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Ping the local Ollama server to determine if it is running and responsive.
 * @returns `true` if the server responds successfully.
 */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_API_BASE}/api/tags`, {
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

  if (platform === 'darwin') {
    // macOS — Apple Silicon / discrete GPU with Metal support
    try {
      const { stdout } = await execFileAsync(
        'system_profiler',
        ['SPDisplaysDataType'],
        { timeout: 5_000 },
      );
      hasGpu = /metal/i.test(stdout);
    } catch {
      // system_profiler unavailable or timed out — assume no GPU
    }
  } else if (platform === 'linux') {
    // Linux — check for NVIDIA GPU via nvidia-smi
    try {
      await execFileAsync('which', ['nvidia-smi']);
      hasGpu = true;
    } catch {
      // nvidia-smi not found — no NVIDIA GPU
    }
  }

  return { totalMemoryGB, freeMemoryGB, platform, arch, hasGpu };
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
export function recommendModels(specs: SystemSpecs): ModelRecommendation {
  const { totalMemoryGB, hasGpu } = specs;

  if (totalMemoryGB < 8) {
    return {
      router: 'llama3.2:1b',
      primary: 'llama3.2:3b',
      auditor: 'llama3.2:1b',
      tier: 'low',
      reason:
        `${totalMemoryGB} GB RAM detected — using lightweight 1B/3B models ` +
        'to stay within memory limits.',
    };
  }

  if (totalMemoryGB < 16) {
    return {
      router: 'llama3.2:3b',
      primary: 'dolphin-llama3:8b',
      auditor: 'llama3.2:3b',
      tier: 'mid',
      reason:
        `${totalMemoryGB} GB RAM detected — 8B primary model with 3B ` +
        'router/auditor for a balanced local setup.',
    };
  }

  // 16 GB+
  const primary = hasGpu ? 'llama3.1:70b' : 'dolphin-llama3:8b';
  const gpuNote = hasGpu
    ? 'GPU detected — using 70B primary for maximum quality.'
    : 'No dedicated GPU — capping at 8B primary to avoid swap pressure.';

  return {
    router: 'llama3.2:3b',
    primary,
    auditor: 'llama3.2:3b',
    tier: 'high',
    reason: `${totalMemoryGB} GB RAM detected. ${gpuNote}`,
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
    const res = await fetch(`${OLLAMA_API_BASE}/api/tags`, {
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

  // Step 2: Check / start server
  let running = await isOllamaRunning();
  if (running) {
    ok('Ollama server is already running');
  } else {
    warning('Ollama server is not running — attempting to start...');
    await startOllama();
    running = true;
  }

  // Step 3: Detect system specs
  note('Detecting system specifications...');
  const specs = await detectSystemSpecs();
  ok(
    `${specs.platform}/${specs.arch}  ` +
      `${chalk.bold(String(specs.totalMemoryGB))} GB RAM  ` +
      `(${chalk.bold(String(specs.freeMemoryGB))} GB free)  ` +
      `GPU: ${specs.hasGpu ? sColor('yes') : dim('no')}`,
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

  // Step 5: List local models
  const localModels = await listLocalModels();
  if (localModels.length > 0) {
    note(`${localModels.length} model(s) already installed locally:`);
    for (const m of localModels) {
      const sizeGB = (m.size / (1024 ** 3)).toFixed(1);
      ok(`${m.name}  ${dim(`${sizeGB} GB`)}`);
    }
  } else {
    note('No models installed yet — you will need to pull the recommended models.');
  }

  return {
    installed: true,
    running,
    specs,
    recommendation,
    localModels,
  };
}

// ── Utilities ──────────────────────────────────────────────────────────────

/** Simple async sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
