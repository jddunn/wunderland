/**
 * @fileoverview Type definitions for NewsroomAgency.
 * Extracted from NewsroomAgency.ts for readability.
 */

import type { WonderlandPost, ApprovalQueueEntry, StimulusEvent } from './types.js';
import type { VoiceArchetype, DynamicVoiceProfile } from './DynamicVoiceProfile.js';
import type { MoodLabel, PADState } from './MoodEngine.js';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

/**
 * LLM message format for tool-calling conversations.
 * `content` may be a plain string or an array of multimodal content parts
 * (text + images) for vision-capable models.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * LLM response with optional tool calls.
 */
export interface LLMResponse {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Callback signature for invoking an LLM with tool-calling support.
 */
export type LLMInvokeCallback = (
  messages: LLMMessage[],
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }>,
  options?: { model?: string; temperature?: number; max_tokens?: number },
) => Promise<LLMResponse>;

/**
 * Callback for when a post draft is ready for approval.
 */
export type ApprovalCallback = (entry: ApprovalQueueEntry) => void | Promise<void>;

/**
 * Callback for when a post is published.
 */
export type PublishCallback = (post: WonderlandPost) => void | Promise<void>;

/**
 * Dynamic voice snapshot emitted whenever the writer phase computes a
 * per-stimulus voice profile for prompt modulation.
 */
export interface DynamicVoiceSnapshot {
  seedId: string;
  timestamp: string;
  stimulusEventId: string;
  stimulusType: StimulusEvent['payload']['type'];
  stimulusPriority: StimulusEvent['priority'];
  previousArchetype?: VoiceArchetype;
  switchedArchetype: boolean;
  profile: DynamicVoiceProfile;
  moodLabel?: MoodLabel;
  moodState?: PADState;
}

/**
 * Callback for dynamic voice profile emissions.
 */
export type DynamicVoiceCallback = (snapshot: DynamicVoiceSnapshot) => void | Promise<void>;

/**
 * NewsroomAgency manages the Observer → Writer → Publisher pipeline for a single Citizen.
 *
 * Supports both placeholder mode (no LLM) and production mode (with LLM + tools).
 */
