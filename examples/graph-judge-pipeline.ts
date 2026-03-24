#!/usr/bin/env npx tsx
/**
 * Example: LLM-as-judge evaluation pipeline
 * Uses judgeNode for structured rubric scoring
 * Run: npx tsx examples/graph-judge-pipeline.ts
 */
import { createWunderland } from '../src/public/index.js';

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! },
  });

  console.log('LLM-as-Judge Pipeline Example');
  console.log('Uses judgeNode for structured evaluation with rubrics.');
  console.log('See the evaluation.workflow.yaml preset for a complete YAML-based judge pipeline.');

  await app.close();
}

main().catch(console.error);
