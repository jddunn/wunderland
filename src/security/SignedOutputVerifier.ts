/**
 * @fileoverview Signed Output Verifier - Layer 3 of security pipeline
 * @module wunderland/security/SignedOutputVerifier
 *
 * Creates cryptographically signed outputs with HMAC signatures
 * and maintains an intent chain audit trail.
 */

import { createHmac, timingSafeEqual, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  type IntentChainEntry,
  type SignedAgentOutput,
} from '../core/types.js';
import {
  type OutputSigningConfig,
  type SigningContext,
} from './types.js';

/**
 * Default signing configuration.
 */
const DEFAULT_SIGNING_CONFIG: OutputSigningConfig = {
  algorithm: 'sha256',
  secretKeyEnvVar: 'WUNDERLAND_SIGNING_SECRET',
  includeIntentChain: true,
  maxIntentChainEntries: 100,
};

/**
 * Intent chain tracker for maintaining audit trail.
 */
export class IntentChainTracker {
  private entries: IntentChainEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  /**
   * Adds an entry to the intent chain.
   */
  addEntry(entry: Omit<IntentChainEntry, 'stepId' | 'timestamp'>): IntentChainEntry {
    const fullEntry: IntentChainEntry = {
      stepId: uuidv4(),
      timestamp: new Date(),
      ...entry,
    };

    this.entries.push(fullEntry);

    // Trim if exceeding max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    return fullEntry;
  }

  /**
   * Gets all entries in the chain.
   */
  getEntries(): readonly IntentChainEntry[] {
    return this.entries;
  }

  /**
   * Clears the chain.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Gets the last N entries.
   */
  getLastEntries(n: number): IntentChainEntry[] {
    return this.entries.slice(-n);
  }

  /**
   * Checks if the chain has any security flags.
   */
  hasSecurityFlags(): boolean {
    return this.entries.some((e) => e.securityFlags.length > 0);
  }

  /**
   * Gets all unique security flags across the chain.
   */
  getAllSecurityFlags(): string[] {
    const flags = new Set<string>();
    for (const entry of this.entries) {
      for (const flag of entry.securityFlags) {
        flags.add(flag);
      }
    }
    return [...flags];
  }
}

/**
 * Signed Output Verifier for creating and verifying HMAC-signed outputs.
 *
 * This is the third layer of defense in the Wunderland security pipeline.
 * It provides:
 * - Cryptographic proof that output came from a specific agent
 * - Tamper-evident audit trail via intent chain
 * - Verification mechanism for downstream systems
 *
 * @example
 * ```typescript
 * const verifier = new SignedOutputVerifier({
 *   algorithm: 'sha256',
 *   secretKeyEnvVar: 'MY_SECRET_KEY',
 * });
 *
 * const tracker = new IntentChainTracker();
 * tracker.addEntry({
 *   action: 'USER_INPUT',
 *   inputHash: verifier.hash('user message'),
 *   outputHash: '',
 *   modelUsed: 'llama3.2:3b',
 *   securityFlags: [],
 * });
 *
 * const signedOutput = verifier.sign(
 *   { text: 'Hello!' },
 *   tracker.getEntries(),
 *   { seedId: 'my-agent' }
 * );
 *
 * const isValid = verifier.verify(signedOutput);
 * ```
 */
export class SignedOutputVerifier {
  private readonly config: OutputSigningConfig;
  private secretKey: Buffer | null = null;

  constructor(config: Partial<OutputSigningConfig> = {}) {
    this.config = {
      ...DEFAULT_SIGNING_CONFIG,
      ...config,
    };
  }

  /**
   * Gets the secret key from environment variable.
   * Caches the key after first retrieval.
   */
  private getSecretKey(): Buffer {
    if (this.secretKey) {
      return this.secretKey;
    }

    const envValue = process.env[this.config.secretKeyEnvVar];
    if (!envValue) {
      // Generate a random key for development
      console.warn(
        `[SignedOutputVerifier] Warning: ${this.config.secretKeyEnvVar} not set. Using random key (not suitable for production).`
      );
      this.secretKey = Buffer.from(uuidv4().replace(/-/g, ''), 'hex');
    } else {
      this.secretKey = Buffer.from(envValue, 'utf8');
    }

    return this.secretKey;
  }

  /**
   * Creates a hash of the given data.
   */
  hash(data: string | object): string {
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    return createHash(this.config.algorithm).update(content).digest('hex');
  }

  /**
   * Signs an output with HMAC.
   */
  sign(
    content: unknown,
    intentChain: readonly IntentChainEntry[],
    context: SigningContext
  ): SignedAgentOutput {
    const outputId = uuidv4();
    const timestamp = new Date();

    // Prepare chain (limit entries if configured)
    let chain = [...intentChain];
    if (this.config.maxIntentChainEntries && chain.length > this.config.maxIntentChainEntries) {
      chain = chain.slice(-this.config.maxIntentChainEntries);
    }

    // Build payload for signing
    const payload = {
      outputId,
      seedId: context.seedId,
      timestamp: timestamp.toISOString(),
      content: this.config.includeIntentChain ? content : this.hash(content as string | object),
      intentChain: this.config.includeIntentChain ? chain : this.hash(chain as string | object),
    };

    // Create HMAC signature
    const signature = createHmac(this.config.algorithm, this.getSecretKey())
      .update(JSON.stringify(payload))
      .digest('hex');

    // Create verification hash (includes signature)
    const verificationHash = createHash(this.config.algorithm)
      .update(JSON.stringify({ ...payload, signature }))
      .digest('hex');

    return {
      outputId,
      seedId: context.seedId,
      timestamp,
      content,
      intentChain: chain,
      signature,
      verificationHash,
    };
  }

  /**
   * Verifies a signed output.
   *
   * @returns true if signature is valid, false otherwise
   */
  verify(signedOutput: SignedAgentOutput): boolean {
    try {
      // Rebuild payload for verification
      const payload = {
        outputId: signedOutput.outputId,
        seedId: signedOutput.seedId,
        timestamp: signedOutput.timestamp instanceof Date
          ? signedOutput.timestamp.toISOString()
          : signedOutput.timestamp,
        content: this.config.includeIntentChain
          ? signedOutput.content
          : this.hash(signedOutput.content as string | object),
        intentChain: this.config.includeIntentChain
          ? signedOutput.intentChain
          : this.hash(signedOutput.intentChain as string | object),
      };

      // Recalculate expected signature
      const expectedSignature = createHmac(this.config.algorithm, this.getSecretKey())
        .update(JSON.stringify(payload))
        .digest('hex');

      // Timing-safe comparison
      const signatureValid = timingSafeEqual(
        Buffer.from(signedOutput.signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );

      if (!signatureValid) {
        return false;
      }

      // Verify the verification hash
      const expectedVerificationHash = createHash(this.config.algorithm)
        .update(JSON.stringify({ ...payload, signature: signedOutput.signature }))
        .digest('hex');

      return timingSafeEqual(
        Buffer.from(signedOutput.verificationHash, 'hex'),
        Buffer.from(expectedVerificationHash, 'hex')
      );
    } catch {
      return false;
    }
  }

  /**
   * Extracts and validates the intent chain from a signed output.
   * Returns null if verification fails.
   */
  extractVerifiedIntentChain(signedOutput: SignedAgentOutput): IntentChainEntry[] | null {
    if (!this.verify(signedOutput)) {
      return null;
    }
    return [...signedOutput.intentChain];
  }

  /**
   * Creates a summary of the intent chain for logging.
   */
  summarizeIntentChain(chain: readonly IntentChainEntry[]): {
    stepCount: number;
    uniqueActions: string[];
    modelsUsed: string[];
    securityFlags: string[];
    duration: number | null;
  } {
    const actions = new Set<string>();
    const models = new Set<string>();
    const flags = new Set<string>();

    for (const entry of chain) {
      actions.add(entry.action);
      models.add(entry.modelUsed);
      for (const flag of entry.securityFlags) {
        flags.add(flag);
      }
    }

    let duration: number | null = null;
    if (chain.length >= 2) {
      const first = chain[0].timestamp;
      const last = chain[chain.length - 1].timestamp;
      duration = new Date(last).getTime() - new Date(first).getTime();
    }

    return {
      stepCount: chain.length,
      uniqueActions: [...actions],
      modelsUsed: [...models],
      securityFlags: [...flags],
      duration,
    };
  }

  /**
   * Checks if an intent chain has any logical inconsistencies.
   * Used for auditing purposes.
   */
  validateIntentChainLogic(chain: readonly IntentChainEntry[]): {
    valid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    // Check timestamp ordering
    for (let i = 1; i < chain.length; i++) {
      const prev = new Date(chain[i - 1].timestamp).getTime();
      const curr = new Date(chain[i].timestamp).getTime();
      if (curr < prev) {
        issues.push(`Timestamp regression at step ${i}: ${chain[i].stepId}`);
      }
    }

    // Check for missing hash chains
    for (let i = 1; i < chain.length; i++) {
      // In a well-formed chain, the output hash of step N-1 should relate to input hash of step N
      // This is a simplified check - real implementation would be more rigorous
      if (!chain[i].inputHash && chain[i - 1].outputHash) {
        issues.push(`Potential hash chain break at step ${i}`);
      }
    }

    // Check for security flags without follow-up
    for (let i = 0; i < chain.length - 1; i++) {
      const entry = chain[i];
      if (entry.securityFlags.includes('REQUIRES_STEP_UP_AUTH')) {
        // Should see an authorization action follow
        const nextActions = chain.slice(i + 1, i + 3).map((e) => e.action);
        if (!nextActions.some((a) => a.includes('AUTH') || a.includes('HITL'))) {
          issues.push(`Security flag at step ${i} may not have been addressed`);
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Updates the configuration.
   */
  updateConfig(updates: Partial<OutputSigningConfig>): void {
    Object.assign(this.config, updates);
    // Clear cached key if env var changed
    if (updates.secretKeyEnvVar) {
      this.secretKey = null;
    }
  }

  /**
   * Gets the current configuration (without secret).
   */
  getConfig(): Omit<OutputSigningConfig, 'secretKeyEnvVar'> & { secretKeyEnvVar: string } {
    return {
      ...this.config,
      secretKeyEnvVar: `[env:${this.config.secretKeyEnvVar}]`, // Don't expose actual var name
    };
  }
}
