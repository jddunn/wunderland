#!/usr/bin/env npx tsx
// @ts-nocheck
/**
 * Example: Session checkpoint and resume
 * Run: npx tsx examples/checkpoint-resume.ts
 */
import { createWunderland } from '../src/public/index.js';

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! },
    tools: 'none',
  });

  const session = app.session('demo-session');

  // Have a conversation
  const r1 = await session.sendText('My name is Alice. Remember that.');
  console.log('Turn 1:', r1.text.slice(0, 100));

  // Save checkpoint
  const cpId = await session.checkpoint();
  console.log('Checkpoint saved:', cpId);

  // Continue conversation
  const r2 = await session.sendText('What is my name?');
  console.log('Turn 2:', r2.text.slice(0, 100));

  // Resume from checkpoint (rolls back to after turn 1)
  await session.resume(cpId);
  console.log('Resumed from checkpoint');

  // Messages are now back to turn 1
  console.log('Messages after resume:', session.messages().length);

  await app.close();
}

main().catch(console.error);
