/**
 * @fileoverview Discovery config, skills registry, discovery manager init.
 * Extracted from start.ts lines 831-936.
 */

import * as fmt from '../../ui/format.js';
import { SkillRegistry, resolveDefaultSkillsDirs } from '../../../skills/index.js';
import { WunderlandDiscoveryManager, type WunderlandDiscoveryConfig } from '../../../discovery/index.js';

export async function setupSkillsAndDiscovery(ctx: any): Promise<void> {
  const { cfg, flags, enableSkills, toolMap, providerId, llmApiKey, llmBaseUrl } = ctx;

  // Capability discovery — semantic search + graph re-ranking
  const discoveryOpts: WunderlandDiscoveryConfig = {};
  if (cfg?.discovery) {
    const d = cfg.discovery as Record<string, unknown>;
    if (typeof d.enabled === 'boolean') discoveryOpts.enabled = d.enabled;
    if (d.recallProfile === 'aggressive' || d.recallProfile === 'balanced' || d.recallProfile === 'precision') {
      discoveryOpts.recallProfile = d.recallProfile;
    }
    if (typeof d.embeddingProvider === 'string') discoveryOpts.embeddingProvider = d.embeddingProvider;
    if (typeof d.embeddingModel === 'string') discoveryOpts.embeddingModel = d.embeddingModel;
    if (typeof d.scanManifests === 'boolean') discoveryOpts.scanManifestDirs = d.scanManifests;
    const budgetFields = { tier0Budget: 'tier0TokenBudget', tier1Budget: 'tier1TokenBudget', tier2Budget: 'tier2TokenBudget', tier1TopK: 'tier1TopK', tier2TopK: 'tier2TopK' } as const;
    const configOverrides: Record<string, number> = {};
    for (const [src, dest] of Object.entries(budgetFields)) {
      if (typeof d[src] === 'number') configOverrides[dest] = d[src] as number;
    }
    // Support tier1MinRelevance directly or via nested config object
    if (typeof d.tier1MinRelevance === 'number') configOverrides['tier1MinRelevance'] = d.tier1MinRelevance;
    if (typeof d.graphBoostFactor === 'number') configOverrides['graphBoostFactor'] = d.graphBoostFactor;
    // Merge nested config object (allows full CapabilityDiscoveryConfig overrides)
    if (d.config && typeof d.config === 'object' && !Array.isArray(d.config)) {
      for (const [k, v] of Object.entries(d.config as Record<string, unknown>)) {
        if (typeof v === 'number') configOverrides[k] = v;
        if (typeof v === 'boolean') (configOverrides as any)[k] = v;
      }
    }
    if (Object.keys(configOverrides).length > 0) discoveryOpts.config = configOverrides as any;
  }
  // Skills — load from filesystem dirs + config-declared skills (BEFORE discovery so we can pass entries)
  let skillsPrompt = '';
  const skillEntries: Array<{ name: string; description: string; content: string; category?: string; tags?: string[] }> = [];
  if (enableSkills) {
    const parts: string[] = [];

    // 1. Directory-based skills (local ./skills/ dirs, --skills-dir flag)
    const skillRegistry = new SkillRegistry();
    const dirs = resolveDefaultSkillsDirs({
      cwd: process.cwd(),
      skillsDirFlag: typeof flags['skills-dir'] === 'string' ? flags['skills-dir'] : undefined,
    });
    if (dirs.length > 0) {
      await skillRegistry.loadFromDirs(dirs);
      const snapshot = skillRegistry.buildSnapshot({ platform: process.platform, strict: true });
      if (snapshot.prompt) parts.push(snapshot.prompt);
      // Extract entries for discovery indexing
      if (typeof skillRegistry.listAll === 'function') {
        for (const entry of skillRegistry.listAll() as any[]) {
          const skill = entry.skill ?? entry;
          skillEntries.push({
            name: skill.name ?? 'unknown',
            description: skill.description ?? '',
            content: skill.content ?? '',
          });
        }
      }
    }

    // 2. Config-declared skills (from agent.config.json "skills" array)
    if (Array.isArray(cfg.skills) && cfg.skills.length > 0) {
      try {
        const { resolveSkillsByNames } = await import('../../../core/PresetSkillResolver.js');
        const presetSnapshot = await resolveSkillsByNames(cfg.skills as string[]);
        if (presetSnapshot.prompt) parts.push(presetSnapshot.prompt);
        // Extract skill names for discovery
        if (Array.isArray(presetSnapshot.skills)) {
          const existing = new Set(skillEntries.map((e) => e.name));
          for (const skill of presetSnapshot.skills as any[]) {
            const name = typeof skill === 'string' ? skill : skill.name ?? 'unknown';
            if (!existing.has(name)) {
              skillEntries.push({ name, description: '', content: '' });
            }
          }
        }
      } catch { /* non-fatal — registry package may not be installed */ }
    }

    skillsPrompt = parts.filter(Boolean).join('\n\n');
  }

  // Discovery — initialized after skills so skillEntries can be indexed
  const discoveryManager = new WunderlandDiscoveryManager(discoveryOpts);
  try {
    await discoveryManager.initialize({
      toolMap,
      skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
      llmConfig: { providerId, apiKey: llmApiKey, baseUrl: llmBaseUrl },
    });
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, {
        name: metaTool.name,
        description: metaTool.description,
        inputSchema: metaTool.inputSchema as any,
        hasSideEffects: metaTool.hasSideEffects,
        category: 'productivity',
        execute: metaTool.execute as any,
      });
    }
    const stats = discoveryManager.getStats();
    if (stats.initialized) {
      fmt.ok(`Discovery: ${stats.capabilityCount} capabilities indexed, ${stats.graphEdges} graph edges`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fmt.warning(`Discovery initialization failed (continuing without): ${msg}`);
  }

  ctx.skillsPrompt = skillsPrompt;
  ctx.discoveryManager = discoveryManager;
}
