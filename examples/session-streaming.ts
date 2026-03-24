#!/usr/bin/env npx tsx
/**
 * Example: Streaming session events in real-time
 * Run: npx tsx examples/session-streaming.ts
 */
import { createWunderland } from '../src/public/index.js';

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! },
    tools: 'none',
  });

  const session = app.session();

  console.log('Streaming session events:\n');
  for await (const event of session.stream('What is quantum computing?')) {
    switch (event.type) {
      case 'run_start': console.log('  [start]'); break;
      case 'text_delta': process.stdout.write(event.content); break;
      case 'node_end': console.log(`\n  [done in ${event.durationMs}ms]`); break;
      case 'run_end': console.log(`  [total: ${event.totalDurationMs}ms]`); break;
    }
  }

  await app.close();
}

main().catch(console.error);
