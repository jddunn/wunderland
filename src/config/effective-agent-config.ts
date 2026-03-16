import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  WunderlandAgentConfig,
  WunderlandAgentDiscoveryConfig,
  WunderlandAgentPersonaRegistryConfig,
  WunderlandAgentRagConfig,
  WunderlandExtensionConfig,
} from '../api/types.js';
import type { WunderlandDiscoveryConfig } from '../discovery/index.js';
import { PresetLoader, type AgentPreset } from '../core/PresetLoader.js';
import {
  buildRagConfigFromPersona,
  extractHexacoTraitsFromPersona,
  extractSystemPromptFromPersona,
  resolveConfiguredPersonas,
  type PersonaSummary,
  summarizePersona,
} from './persona-registry.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
};

export interface EffectiveAgentConfigResult {
  agentConfig: WunderlandAgentConfig;
  preset?: AgentPreset;
  personaPath?: string;
  selectedPersona?: PersonaSummary;
  availablePersonas?: PersonaSummary[];
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function mergeStringArrays(a?: string[], b?: string[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of [...(a ?? []), ...(b ?? [])]) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out.length > 0 ? out : undefined;
}

function mergeExtensions(
  preset?: WunderlandExtensionConfig,
  config?: WunderlandExtensionConfig,
): WunderlandExtensionConfig | undefined {
  const keys = new Set<string>([
    ...Object.keys(preset ?? {}),
    ...Object.keys(config ?? {}),
  ]);

  if (keys.size === 0) return undefined;

  const merged: WunderlandExtensionConfig = {};
  for (const key of keys) {
    const values = mergeStringArrays(preset?.[key], config?.[key]);
    if (values) merged[key] = values;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizePresetPersonality(
  preset?: AgentPreset['hexacoTraits'],
): WunderlandAgentConfig['personality'] | undefined {
  return preset
    ? {
        honesty: preset.honesty,
        emotionality: preset.emotionality,
        extraversion: preset.extraversion,
        agreeableness: preset.agreeableness,
        conscientiousness: preset.conscientiousness,
        openness: preset.openness,
      }
    : undefined;
}

function mergePersonalitySources(
  ...sources: Array<WunderlandAgentConfig['personality'] | undefined>
): WunderlandAgentConfig['personality'] | undefined {
  const merged = Object.assign({}, ...sources.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeDiscoveryConfig(
  preset?: WunderlandAgentDiscoveryConfig,
  config?: WunderlandAgentDiscoveryConfig,
): WunderlandAgentDiscoveryConfig | undefined {
  const merged: WunderlandAgentDiscoveryConfig = {
    ...(preset ?? {}),
    ...(config ?? {}),
    config: {
      ...(preset?.config ?? {}),
      ...(config?.config ?? {}),
    },
  };

  if (!merged.config || Object.keys(merged.config).length === 0) {
    delete merged.config;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeRagConfig(
  preset?: WunderlandAgentRagConfig,
  config?: WunderlandAgentRagConfig,
): WunderlandAgentRagConfig | undefined {
  const merged: WunderlandAgentRagConfig = {
    ...(preset ?? {}),
    ...(config ?? {}),
    collectionIds: mergeStringArrays(preset?.collectionIds, config?.collectionIds),
    queryVariants: mergeStringArrays(preset?.queryVariants, config?.queryVariants),
    filters: {
      ...(preset?.filters ?? {}),
      ...(config?.filters ?? {}),
    },
    rewrite: {
      ...(preset?.rewrite ?? {}),
      ...(config?.rewrite ?? {}),
    },
    strategyParams: {
      ...(preset?.strategyParams ?? {}),
      ...(config?.strategyParams ?? {}),
    },
    hyde: {
      ...(preset?.hyde ?? {}),
      ...(config?.hyde ?? {}),
    },
  };

  if (!merged.collectionIds) delete merged.collectionIds;
  if (!merged.queryVariants) delete merged.queryVariants;
  if (!merged.filters || Object.keys(merged.filters).length === 0) delete merged.filters;
  if (!merged.rewrite || Object.keys(merged.rewrite).length === 0) delete merged.rewrite;
  if (!merged.strategyParams || Object.keys(merged.strategyParams).length === 0) delete merged.strategyParams;
  if (!merged.hyde || Object.keys(merged.hyde).length === 0) delete merged.hyde;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergePersonaRegistryConfig(
  config?: WunderlandAgentPersonaRegistryConfig,
): WunderlandAgentPersonaRegistryConfig | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const merged: WunderlandAgentPersonaRegistryConfig = {
    ...config,
    paths: mergeStringArrays(config.paths),
  };
  if (!merged.paths) delete merged.paths;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function resolveSystemPrompt(opts: {
  explicitPrompt?: string;
  localPersona?: string;
  selectedPersonaPrompt?: string;
  presetPersona?: string;
}): string | undefined {
  if (hasText(opts.explicitPrompt)) return opts.explicitPrompt;

  const blocks = [
    hasText(opts.selectedPersonaPrompt) ? opts.selectedPersonaPrompt : undefined,
    hasText(opts.localPersona) ? opts.localPersona : undefined,
  ].filter((block): block is string => hasText(block));

  if (blocks.length > 0) return blocks.join('\n\n');
  if (hasText(opts.presetPersona)) return opts.presetPersona;
  return undefined;
}

async function readPersonaFile(workingDirectory?: string): Promise<{ content?: string; personaPath?: string }> {
  const baseDir = workingDirectory ? path.resolve(workingDirectory) : process.cwd();
  const personaPath = path.join(baseDir, 'PERSONA.md');
  if (!existsSync(personaPath)) {
    return {};
  }

  try {
    const content = await readFile(personaPath, 'utf8');
    return hasText(content) ? { content, personaPath } : {};
  } catch {
    return {};
  }
}

export async function resolveEffectiveAgentConfig(opts: {
  agentConfig: WunderlandAgentConfig;
  workingDirectory?: string;
  presetId?: string;
  logger?: LoggerLike;
}): Promise<EffectiveAgentConfigResult> {
  const inputConfig = opts.agentConfig ?? {};
  const resolvedPresetId =
    hasText(opts.presetId) ? opts.presetId.trim() : hasText(inputConfig.presetId) ? inputConfig.presetId.trim() : '';

  let preset: AgentPreset | undefined;
  if (resolvedPresetId) {
    try {
      const loader = new PresetLoader();
      preset = loader.loadPreset(resolvedPresetId);
      opts.logger?.debug?.('[wunderland] applied preset defaults', { presetId: resolvedPresetId });
    } catch (error) {
      opts.logger?.warn?.('[wunderland] failed to load preset defaults', {
        presetId: resolvedPresetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { content: localPersona, personaPath } = await readPersonaFile(opts.workingDirectory);
  const personaCatalog = await resolveConfiguredPersonas({
    agentConfig: inputConfig,
    workingDirectory: opts.workingDirectory,
    logger: opts.logger,
  });
  const selectedPersona = personaCatalog?.selectedPersona;
  const personaPrompt = extractSystemPromptFromPersona(selectedPersona?.definition);
  const personaRag = buildRagConfigFromPersona(selectedPersona?.definition);
  const personaTraits = extractHexacoTraitsFromPersona(selectedPersona?.definition);

  const mergedConfig: WunderlandAgentConfig = {
    ...inputConfig,
    presetId: resolvedPresetId || inputConfig.presetId,
    selectedPersonaId: selectedPersona?.id ?? inputConfig.selectedPersonaId ?? inputConfig.personaRegistry?.selectedPersonaId,
    displayName: hasText(inputConfig.displayName)
      ? inputConfig.displayName
      : hasText(selectedPersona?.name)
        ? selectedPersona.name
        : preset?.name,
    bio: hasText(inputConfig.bio)
      ? inputConfig.bio
      : hasText(selectedPersona?.description)
        ? selectedPersona.description
        : preset?.description,
    systemPrompt: resolveSystemPrompt({
      explicitPrompt: inputConfig.systemPrompt,
      localPersona,
      selectedPersonaPrompt: personaPrompt,
      presetPersona: preset?.persona,
    }),
    personality: mergePersonalitySources(
      normalizePresetPersonality(preset?.hexacoTraits),
      personaTraits,
      inputConfig.personality,
    ),
    llmProvider: hasText(inputConfig.llmProvider)
      ? inputConfig.llmProvider
      : hasText(selectedPersona?.definition.defaultProviderId)
        ? selectedPersona.definition.defaultProviderId
        : undefined,
    llmModel: hasText(inputConfig.llmModel)
      ? inputConfig.llmModel
      : hasText(selectedPersona?.definition.defaultModelId)
        ? selectedPersona.definition.defaultModelId
        : undefined,
    securityTier: hasText(inputConfig.securityTier) ? inputConfig.securityTier : preset?.securityTier,
    toolAccessProfile: hasText(inputConfig.toolAccessProfile)
      ? inputConfig.toolAccessProfile
      : preset?.toolAccessProfile,
    skills: mergeStringArrays(preset?.suggestedSkills, inputConfig.skills),
    suggestedChannels: mergeStringArrays(preset?.suggestedChannels, inputConfig.suggestedChannels),
    extensions: mergeExtensions(preset?.suggestedExtensions, inputConfig.extensions),
    extensionOverrides: {
      ...(preset?.extensionOverrides ?? {}),
      ...(inputConfig.extensionOverrides ?? {}),
    },
    personaRegistry: mergePersonaRegistryConfig(inputConfig.personaRegistry),
    discovery: mergeDiscoveryConfig(preset?.discovery, inputConfig.discovery),
    rag: mergeRagConfig(mergeRagConfig(preset?.rag, personaRag), inputConfig.rag),
  };

  if (!mergedConfig.extensionOverrides || Object.keys(mergedConfig.extensionOverrides).length === 0) {
    delete mergedConfig.extensionOverrides;
  }

  return {
    agentConfig: mergedConfig,
    preset,
    personaPath,
    selectedPersona: selectedPersona ? summarizePersona(selectedPersona) : undefined,
    availablePersonas: personaCatalog?.personas.map((persona) => summarizePersona(persona)),
  };
}

export function buildDiscoveryOptionsFromAgentConfig(
  agentConfig?: WunderlandAgentConfig,
): WunderlandDiscoveryConfig {
  const opts: WunderlandDiscoveryConfig = {};
  const discovery = agentConfig?.discovery;
  if (!discovery) return opts;

  if (typeof discovery.enabled === 'boolean') opts.enabled = discovery.enabled;
  if (
    discovery.recallProfile === 'aggressive'
    || discovery.recallProfile === 'balanced'
    || discovery.recallProfile === 'precision'
  ) {
    opts.recallProfile = discovery.recallProfile;
  }
  if (hasText(discovery.embeddingProvider)) opts.embeddingProvider = discovery.embeddingProvider;
  if (hasText(discovery.embeddingModel)) opts.embeddingModel = discovery.embeddingModel;
  if (typeof discovery.scanManifests === 'boolean') opts.scanManifestDirs = discovery.scanManifests;

  const configOverrides: Record<string, unknown> = {};
  const budgetFields = {
    tier0Budget: 'tier0TokenBudget',
    tier1Budget: 'tier1TokenBudget',
    tier2Budget: 'tier2TokenBudget',
    tier1TopK: 'tier1TopK',
    tier2TopK: 'tier2TopK',
  } as const;

  for (const [sourceKey, destKey] of Object.entries(budgetFields)) {
    const value = discovery[sourceKey as keyof WunderlandAgentDiscoveryConfig];
    if (typeof value === 'number') {
      configOverrides[destKey] = value;
    }
  }

  if (typeof discovery.tier1MinRelevance === 'number') {
    configOverrides['tier1MinRelevance'] = discovery.tier1MinRelevance;
  }
  if (typeof discovery.graphBoostFactor === 'number') {
    configOverrides['graphBoostFactor'] = discovery.graphBoostFactor;
  }
  if (discovery.config && typeof discovery.config === 'object' && !Array.isArray(discovery.config)) {
    Object.assign(configOverrides, discovery.config);
  }
  if (Object.keys(configOverrides).length > 0) {
    opts.config = configOverrides as any;
  }

  return opts;
}
