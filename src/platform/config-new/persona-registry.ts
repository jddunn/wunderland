// @ts-nocheck
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { BUILT_IN_PERSONAS } from '@framers/agentos';
import type { IPersonaDefinition } from '@framers/agentos/cognitive_substrate/personas/IPersonaDefinition';

import type {
  WunderlandAgentConfig,
  WunderlandAgentPersonaRegistryConfig,
  WunderlandAgentRagConfig,
} from '../channels/api-new/types.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
};

export interface ResolvedPersonaEntry {
  id: string;
  name: string;
  description?: string;
  source: 'builtin' | 'file';
  definition: IPersonaDefinition;
}

export interface PersonaSummary {
  id: string;
  name: string;
  description?: string;
  source: 'builtin' | 'file';
  defaultProviderId?: string;
  defaultModelId?: string;
  toolIds?: string[];
  allowedCapabilities?: string[];
  rag?: {
    enabled: boolean;
    strategy?: 'similarity' | 'mmr' | 'hybrid_search';
    topK?: number;
    collectionIds?: string[];
  };
}

export interface ResolvedPersonaCatalog {
  enabled: boolean;
  selectedPersonaId?: string;
  selectedPersona?: ResolvedPersonaEntry;
  personas: ResolvedPersonaEntry[];
  directories: string[];
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function toRegistryConfig(config?: WunderlandAgentConfig): WunderlandAgentPersonaRegistryConfig {
  const raw = config?.personaRegistry;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

export function resolveSelectedPersonaId(config?: WunderlandAgentConfig): string | undefined {
  const topLevel = hasText(config?.selectedPersonaId) ? config.selectedPersonaId.trim() : undefined;
  if (topLevel) return topLevel;
  const registryConfig = toRegistryConfig(config);
  return hasText(registryConfig.selectedPersonaId) ? registryConfig.selectedPersonaId.trim() : undefined;
}

export function summarizePersona(entry: ResolvedPersonaEntry): PersonaSummary {
  const rag = buildRagConfigFromPersona(entry.definition);
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    defaultProviderId: hasText(entry.definition.defaultProviderId) ? entry.definition.defaultProviderId.trim() : undefined,
    defaultModelId: hasText(entry.definition.defaultModelId) ? entry.definition.defaultModelId.trim() : undefined,
    toolIds: Array.isArray(entry.definition.toolIds) && entry.definition.toolIds.length > 0
      ? uniqueStrings(entry.definition.toolIds)
      : undefined,
    allowedCapabilities: Array.isArray(entry.definition.allowedCapabilities) && entry.definition.allowedCapabilities.length > 0
      ? uniqueStrings(entry.definition.allowedCapabilities)
      : undefined,
    rag: rag?.enabled
      ? {
          enabled: true,
          strategy: rag.strategy,
          topK: rag.defaultTopK,
          collectionIds: rag.collectionIds,
        }
      : undefined,
  };
}

export function extractSystemPromptFromPersona(persona?: IPersonaDefinition): string | undefined {
  if (!persona) return undefined;
  const basePrompt = persona.baseSystemPrompt;
  if (typeof basePrompt === 'string' && basePrompt.trim()) {
    return basePrompt.trim();
  }
  if (basePrompt && typeof basePrompt === 'object' && !Array.isArray(basePrompt) && 'template' in basePrompt) {
    const template = (basePrompt as { template?: unknown }).template;
    return hasText(template) ? template.trim() : undefined;
  }
  if (Array.isArray(basePrompt)) {
    const parts = basePrompt
      .filter((part): part is { content: string; priority?: number } => !!part && typeof part.content === 'string' && part.content.trim().length > 0)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .map((part) => part.content.trim());
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
  return undefined;
}

export function extractHexacoTraitsFromPersona(persona?: IPersonaDefinition): WunderlandAgentConfig['personality'] | undefined {
  const traits = persona?.personalityTraits;
  if (!traits || typeof traits !== 'object' || Array.isArray(traits)) return undefined;
  const raw = traits as Record<string, unknown>;

  const readNumber = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (value >= 0 && value <= 1) return value;
        if (value >= 0 && value <= 100) return value / 100;
      }
    }
    return undefined;
  };

  const mapped = {
    honesty: readNumber('honesty', 'honesty_humility', 'honestyHumility'),
    emotionality: readNumber('emotionality'),
    extraversion: readNumber('extraversion'),
    agreeableness: readNumber('agreeableness'),
    conscientiousness: readNumber('conscientiousness'),
    openness: readNumber('openness'),
  };

  return Object.values(mapped).some((value) => typeof value === 'number') ? mapped : undefined;
}

export function buildRagConfigFromPersona(persona?: IPersonaDefinition): WunderlandAgentRagConfig | undefined {
  const rag = persona?.memoryConfig?.ragConfig;
  if (!rag?.enabled) return undefined;

  const collectionIds = uniqueStrings(
    (rag.dataSources ?? [])
      .filter((source) => source?.isEnabled !== false && hasText(source?.dataSourceNameOrId))
      .map((source) => String(source.dataSourceNameOrId).trim()),
  );

  const strategy = (() => {
    const raw = rag.defaultRetrievalStrategy;
    if (raw === 'similarity' || raw === 'mmr' || raw === 'hybrid_search') return raw;
    return undefined;
  })();

  const mapped: WunderlandAgentRagConfig = {
    enabled: true,
    defaultTopK:
      typeof rag.defaultRetrievalTopK === 'number' && Number.isFinite(rag.defaultRetrievalTopK)
        ? rag.defaultRetrievalTopK
        : undefined,
    collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
    defaultCollectionId: collectionIds.length === 1 ? collectionIds[0] : undefined,
    strategy,
    rewrite: hasText(rag.queryAugmentationPromptName) ? { enabled: true } : undefined,
    preset: rag.rerankerConfig?.enabled === true ? 'accurate' : undefined,
  };

  return Object.values(mapped).some((value) => value !== undefined) ? mapped : { enabled: true };
}

function resolvePersonaDirectories(config: WunderlandAgentConfig | undefined, workingDirectory: string): string[] {
  const registryConfig = toRegistryConfig(config);
  const configured = Array.isArray(registryConfig.paths) ? registryConfig.paths : [];
  const resolved = configured
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
    .map((entry) => path.resolve(workingDirectory, entry))
    .filter((entry) => existsSync(entry));

  if (resolved.length > 0) return uniqueStrings(resolved);

  const defaultDir = path.resolve(workingDirectory, 'personas');
  return existsSync(defaultDir) ? [defaultDir] : [];
}

function shouldLoadPersonas(config: WunderlandAgentConfig | undefined, workingDirectory: string): {
  enabled: boolean;
  selectedPersonaId?: string;
  includeBuiltIns: boolean;
  directories: string[];
  recursive: boolean;
  fileExtension?: string;
} {
  const registryConfig = toRegistryConfig(config);
  const selectedPersonaId = resolveSelectedPersonaId(config);
  const directories = resolvePersonaDirectories(config, workingDirectory);
  const includeBuiltIns = registryConfig.includeBuiltIns !== false;
  const enabled = registryConfig.enabled === true || !!selectedPersonaId || directories.length > 0;

  return {
    enabled,
    selectedPersonaId,
    includeBuiltIns,
    directories,
    recursive: registryConfig.recursive !== false,
    fileExtension: hasText(registryConfig.fileExtension) ? registryConfig.fileExtension.trim() : undefined,
  };
}

async function loadPersonasFromDirectory(opts: {
  directory: string;
  recursive: boolean;
  fileExtension?: string;
  logger?: LoggerLike;
}): Promise<ResolvedPersonaEntry[]> {
  try {
    const extension = hasText(opts.fileExtension)
      ? (opts.fileExtension.startsWith('.') ? opts.fileExtension.toLowerCase() : `.${opts.fileExtension.toLowerCase()}`)
      : '.json';

    const findPersonaFiles = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            return opts.recursive ? findPersonaFiles(fullPath) : [];
          }
          if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
            return [fullPath];
          }
          return [];
        }),
      );
      return nested.flat();
    };

    const personaFiles = await findPersonaFiles(opts.directory);
    const personas = await Promise.all(
      personaFiles.map(async (filePath) => {
        const raw = await readFile(filePath, 'utf8');
        return JSON.parse(raw) as IPersonaDefinition;
      }),
    );

    return personas
      .filter((persona) =>
        !!persona
        && hasText(persona.id)
        && hasText(persona.name)
        && hasText(persona.version)
        && !!extractSystemPromptFromPersona(persona)
        && persona.isPublic !== false,
      )
      .map((persona) => ({
        id: persona.id.trim(),
        name: persona.name.trim(),
        description: hasText(persona.description) ? persona.description.trim() : undefined,
        source: 'file' as const,
        definition: persona,
      }));
  } catch (error) {
    opts.logger?.warn?.('[wunderland] failed to load AgentOS personas from directory', {
      directory: opts.directory,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function resolveConfiguredPersonas(opts: {
  agentConfig?: WunderlandAgentConfig;
  workingDirectory?: string;
  logger?: LoggerLike;
}): Promise<ResolvedPersonaCatalog | undefined> {
  const workingDirectory = opts.workingDirectory ? path.resolve(opts.workingDirectory) : process.cwd();
  const loadPlan = shouldLoadPersonas(opts.agentConfig, workingDirectory);
  if (!loadPlan.enabled) return undefined;

  const personaMap = new Map<string, ResolvedPersonaEntry>();

  if (loadPlan.includeBuiltIns) {
    for (const persona of BUILT_IN_PERSONAS) {
      if (!persona || !hasText(persona.id) || !hasText(persona.name) || persona.isPublic === false) continue;
      personaMap.set(persona.id.trim(), {
        id: persona.id.trim(),
        name: persona.name.trim(),
        description: hasText(persona.description) ? persona.description.trim() : undefined,
        source: 'builtin',
        definition: JSON.parse(JSON.stringify(persona)) as IPersonaDefinition,
      });
    }
  }

  for (const directory of loadPlan.directories) {
    const entries = await loadPersonasFromDirectory({
      directory,
      recursive: loadPlan.recursive,
      fileExtension: loadPlan.fileExtension,
      logger: opts.logger,
    });
    for (const entry of entries) {
      personaMap.set(entry.id, entry);
    }
  }

  const personas = Array.from(personaMap.values()).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const selectedPersona = loadPlan.selectedPersonaId ? personaMap.get(loadPlan.selectedPersonaId) : undefined;

  if (loadPlan.selectedPersonaId && !selectedPersona) {
    opts.logger?.warn?.('[wunderland] selected AgentOS persona was not found', {
      selectedPersonaId: loadPlan.selectedPersonaId,
      directories: loadPlan.directories,
      includeBuiltIns: loadPlan.includeBuiltIns,
    });
  }

  return {
    enabled: true,
    selectedPersonaId: loadPlan.selectedPersonaId,
    selectedPersona,
    personas,
    directories: loadPlan.directories,
  };
}
