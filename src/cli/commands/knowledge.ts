/**
 * @fileoverview `wunderland knowledge` — knowledge graph operations.
 *
 * Wires up to the local in-memory KnowledgeGraph from @framers/agentos.
 * For persistent graphs, an agent must be running with knowledge enabled.
 *
 * @module wunderland/cli/commands/knowledge
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

async function tryLoadKnowledgeGraph(): Promise<any | null> {
  try {
    const mod = await import('@framers/agentos');
    if (mod.KnowledgeGraph) return mod.KnowledgeGraph;
    return null;
  } catch {
    return null;
  }
}

export default async function cmdKnowledge(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (!sub || sub === 'help') {
    fmt.section('wunderland knowledge');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('query <text>')}           Search the knowledge graph
    ${dim('stats')}                  Show graph statistics
    ${dim('demo')}                   Load a demo graph and show stats

  ${accent('Flags:')}
    ${dim('--format json|table')}    Output format
`);
    return;
  }

  try {
    const KnowledgeGraph = await tryLoadKnowledgeGraph();

    if (!KnowledgeGraph) {
      fmt.errorBlock(
        'KnowledgeGraph Unavailable',
        '@framers/agentos is not installed or does not export KnowledgeGraph.\nEnsure it is built: cd packages/agentos && pnpm build',
      );
      process.exitCode = 1;
      return;
    }

    if (sub === 'query') {
      const query = args.slice(1).join(' ');
      if (!query) { fmt.errorBlock('Missing query', 'Usage: wunderland knowledge query <text>'); process.exitCode = 1; return; }

      const kg = new KnowledgeGraph();
      await kg.initialize();

      // Try semantic search first, fall back to entity label match
      const entities = await kg.queryEntities({ type: undefined });
      const matches = entities.filter((e: any) =>
        e.label?.toLowerCase().includes(query.toLowerCase()) ||
        JSON.stringify(e.properties || {}).toLowerCase().includes(query.toLowerCase())
      );

      if (format === 'json') { console.log(JSON.stringify(matches, null, 2)); return; }

      fmt.section(`Knowledge Query: "${query}"`);

      if (matches.length === 0) {
        fmt.note('No entities match this query in the local graph.');
        fmt.note(`The knowledge graph is populated during agent runtime.`);
        fmt.note(`Start an agent with: ${accent('wunderland start')}`);
      } else {
        for (const entity of matches) {
          const icon = sColor('\u25C6');
          const conf = entity.confidence != null ? dim(` (${Math.round(entity.confidence * 100)}%)`) : '';
          console.log(`    ${icon} ${accent(entity.label)}${conf}  ${muted(entity.type)}`);
          if (entity.properties && Object.keys(entity.properties).length > 0) {
            for (const [k, v] of Object.entries(entity.properties)) {
              console.log(`      ${dim(k)}: ${String(v)}`);
            }
          }
        }
        fmt.blank();
        fmt.kvPair('Results', `${matches.length} entities`);
      }
      fmt.blank();

    } else if (sub === 'stats') {
      const kg = new KnowledgeGraph();
      await kg.initialize();

      const stats = await kg.getStats();

      if (format === 'json') { console.log(JSON.stringify(stats, null, 2)); return; }

      fmt.section('Knowledge Graph Statistics');

      if (stats.totalEntities === 0 && stats.totalRelations === 0 && stats.totalMemories === 0) {
        fmt.note('Knowledge graph is empty.');
        fmt.note('Entities, relations, and episodic memories are created during agent runtime.');
        fmt.note(`Start an agent with: ${accent('wunderland start')}`);
        fmt.blank();
        return;
      }

      fmt.kvPair('Total Entities', String(stats.totalEntities));
      fmt.kvPair('Total Relations', String(stats.totalRelations));
      fmt.kvPair('Total Memories', String(stats.totalMemories));
      fmt.kvPair('Avg Confidence', `${(stats.avgConfidence * 100).toFixed(1)}%`);

      if (stats.oldestEntry) fmt.kvPair('Oldest Entry', stats.oldestEntry);
      if (stats.newestEntry) fmt.kvPair('Newest Entry', stats.newestEntry);

      // Entity type breakdown
      if (stats.entitiesByType && Object.keys(stats.entitiesByType).length > 0) {
        console.log(`\n  ${accent('Entities by Type')}`);
        for (const [type, count] of Object.entries(stats.entitiesByType)) {
          fmt.kvPair(`  ${type}`, String(count));
        }
      }

      // Relation type breakdown
      if (stats.relationsByType && Object.keys(stats.relationsByType).length > 0) {
        console.log(`\n  ${accent('Relations by Type')}`);
        for (const [type, count] of Object.entries(stats.relationsByType)) {
          fmt.kvPair(`  ${type}`, String(count));
        }
      }

      fmt.blank();

    } else if (sub === 'demo') {
      const kg = new KnowledgeGraph();
      await kg.initialize();

      // Populate with demo data
      const entities = [
        { type: 'person', label: 'Alice', properties: { role: 'researcher' }, confidence: 0.95, source: { type: 'user_input', timestamp: new Date().toISOString() } },
        { type: 'concept', label: 'Knowledge Graphs', properties: { domain: 'computer science' }, confidence: 0.9, source: { type: 'extraction', timestamp: new Date().toISOString() } },
        { type: 'concept', label: 'Machine Learning', properties: { domain: 'AI' }, confidence: 0.85, source: { type: 'extraction', timestamp: new Date().toISOString() } },
        { type: 'organization', label: 'Wunderland Labs', properties: { type: 'research' }, confidence: 0.92, source: { type: 'user_input', timestamp: new Date().toISOString() } },
      ];

      const createdEntities: any[] = [];
      for (const e of entities) {
        createdEntities.push(await kg.upsertEntity(e as any));
      }

      // Add relations
      await kg.upsertRelation({
        sourceId: createdEntities[0].id,
        targetId: createdEntities[1].id,
        type: 'studies',
        properties: {},
        confidence: 0.9,
        source: { type: 'extraction', timestamp: new Date().toISOString() },
      } as any);

      await kg.upsertRelation({
        sourceId: createdEntities[0].id,
        targetId: createdEntities[3].id,
        type: 'works_at',
        properties: {},
        confidence: 0.95,
        source: { type: 'user_input', timestamp: new Date().toISOString() },
      } as any);

      // Record an episodic memory
      await kg.recordMemory({
        content: 'Alice presented her research on Knowledge Graphs at the Wunderland Labs seminar.',
        importance: 0.8,
        emotionalValence: 0.6,
        entities: [createdEntities[0].id, createdEntities[1].id, createdEntities[3].id],
        metadata: { source: 'demo' },
      } as any);

      const stats = await kg.getStats();

      if (format === 'json') { console.log(JSON.stringify(stats, null, 2)); return; }

      fmt.successBlock('Demo Knowledge Graph Created');
      fmt.kvPair('Entities', String(stats.totalEntities));
      fmt.kvPair('Relations', String(stats.totalRelations));
      fmt.kvPair('Memories', String(stats.totalMemories));
      fmt.kvPair('Avg Confidence', `${(stats.avgConfidence * 100).toFixed(1)}%`);

      if (stats.entitiesByType && Object.keys(stats.entitiesByType).length > 0) {
        console.log(`\n  ${accent('Entities by Type')}`);
        for (const [type, count] of Object.entries(stats.entitiesByType)) {
          fmt.kvPair(`  ${type}`, String(count));
        }
      }

      fmt.blank();
      fmt.note(`Try: ${accent('wunderland knowledge query Alice')}`);
      fmt.blank();

    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland knowledge')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Knowledge Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
