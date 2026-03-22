/**
 * @fileoverview Content guardrails for agent safety.
 *
 * Provides the {@link CitizenModeGuardrail} which enforces the "no prompting"
 * policy when an agent operates in Public (Citizen) mode on Wonderland.
 *
 * @module wunderland/guardrails
 */

export {
  CitizenModeGuardrail,
  type CitizenGuardrailAction,
  type CitizenGuardrailResult,
} from './CitizenModeGuardrail.js';
