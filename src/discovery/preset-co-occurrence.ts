/**
 * @fileoverview Derive preset co-occurrence data for capability graph construction.
 * @module wunderland/discovery/preset-co-occurrence
 *
 * Reads all 8 agent presets and transforms their suggestedExtensions + suggestedSkills
 * into PresetCoOccurrence entries that drive COMPOSED_WITH edges in the capability graph.
 */

import type { PresetCoOccurrence } from '@framers/agentos/discovery';
import { PresetLoader } from '../core/PresetLoader.js';

/**
 * Derive PresetCoOccurrence data from all agent presets.
 *
 * Each preset's suggestedExtensions.tools[] + suggestedSkills[] + suggestedChannels[]
 * form a co-occurrence group. Capabilities that appear together in presets get
 * COMPOSED_WITH edges in the graph, boosting relevance during discovery.
 */
export function derivePresetCoOccurrences(): PresetCoOccurrence[] {
  try {
    const loader = new PresetLoader();
    const presets = loader.listPresets();

    return presets.map((preset) => {
      const toolIds = (preset.suggestedExtensions?.tools ?? []).map((t) => `tool:${t}`);
      const skillIds = (preset.suggestedSkills ?? []).map((s) => `skill:${s}`);
      const channelIds = (preset.suggestedChannels ?? []).map((c) => `channel:${c}`);

      return {
        presetName: preset.id,
        capabilityIds: [...toolIds, ...skillIds, ...channelIds],
      };
    });
  } catch {
    // Non-fatal — presets directory may not be available in all contexts
    return [];
  }
}
