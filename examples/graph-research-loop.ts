#!/usr/bin/env npx tsx
// @ts-nocheck
/**
 * Example: AgentGraph with conditional retry loop
 * Run: npx tsx examples/graph-research-loop.ts
 */
import { createWunderland } from '../src/public/index.js';

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! },
  });

  // Use the agentGraph builder for full control
  // This demonstrates a cyclic graph (not possible with workflow YAML)
  console.log('AgentGraph with conditional retry loop');
  console.log('This example demonstrates cycles — use AgentGraph (not workflow) for loops.');
  console.log('See docs/AGENT_GRAPH.md for the full API.');

  await app.close();
}

main().catch(console.error);
