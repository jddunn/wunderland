// @ts-nocheck
/**
 * @fileoverview PairingManager setup.
 * Extracted from start.ts lines 964-981.
 */

import * as path from 'node:path';
import { PairingManager } from '../../../channels/pairing/PairingManager.js';

export function initPairing(ctx: any): void {
  const { cfg, workspaceBaseDir, workspaceAgentId } = ctx;

  const pairingEnabled = cfg?.pairing?.enabled !== false;
  const pairingGroupTrigger = (() => {
    const raw = (cfg as any)?.pairing?.groupTrigger;
    if (typeof raw === 'string') return raw.trim();
    return '!pair';
  })();
  const pairingGroupTriggerEnabled =
    pairingEnabled && !!pairingGroupTrigger && pairingGroupTrigger.toLowerCase() !== 'off';
  const pairing = new PairingManager({
    storeDir: path.join(workspaceBaseDir, workspaceAgentId, 'pairing'),
    pendingTtlMs: Number.isFinite(cfg?.pairing?.pendingTtlMs) ? cfg.pairing.pendingTtlMs : undefined,
    maxPending: Number.isFinite(cfg?.pairing?.maxPending) ? cfg.pairing.maxPending : undefined,
    codeLength: Number.isFinite(cfg?.pairing?.codeLength) ? cfg.pairing.codeLength : undefined,
  });

  ctx.pairingEnabled = pairingEnabled;
  ctx.pairingGroupTrigger = pairingGroupTrigger;
  ctx.pairingGroupTriggerEnabled = pairingGroupTriggerEnabled;
  ctx.pairing = pairing;
}
