/**
 * Example: in-process chat runtime using `wunderland/api`.
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   OPENAI_API_KEY=... node examples/chat-runtime.mjs
 */

import { createWunderlandChatRuntime } from 'wunderland/api';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENAI_API_KEY. Set it and re-run.');
    process.exitCode = 1;
    return;
  }

  const runtime = await createWunderlandChatRuntime({
    agentConfig: {
      seedId: 'demo-runtime',
      displayName: 'Demo Runtime',
      bio: 'In-process Wunderland chat runtime demo',
      securityTier: 'balanced',
      permissionSet: 'supervised',
      toolAccessProfile: 'assistant',
      executionMode: 'human-dangerous',
      extensions: { tools: ['web-search', 'news-search', 'image-search'] },
    },
    llm: {
      providerId: 'openai',
      apiKey,
      model: 'gpt-4o-mini',
    },
    askPermission: async (tool, args) => {
      console.log(`Tool requested: ${tool.name}`);
      console.log(JSON.stringify(args, null, 2));
      return false;
    },
  });

  const reply = await runtime.runTurn('Hello! Briefly explain what you can do.');
  console.log('\nAssistant reply:\n', reply);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

