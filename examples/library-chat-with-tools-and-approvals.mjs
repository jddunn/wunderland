/**
 * Example: tools + safe approvals (deny side effects by default).
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   OPENAI_API_KEY=... node examples/library-chat-with-tools-and-approvals.mjs
 */

import { createWunderland } from 'wunderland';

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai' },
    tools: 'curated',
    approvals: {
      mode: 'custom',
      onRequest: async ({ tool, preview }) => {
        // In a real app, show a UI prompt. Here, we just deny side effects.
        console.log(`[approvals] tool=${tool.name} sideEffects=${tool.hasSideEffects === true}`);
        console.log(preview);
        return tool.hasSideEffects !== true;
      },
    },
  });

  const session = app.session('demo-tools');
  const out = await session.sendText('Search the web for the current time in UTC and respond.');
  console.log(out.text);

  console.log('Tool calls:', out.toolCalls.map((c) => ({ toolName: c.toolName, approved: c.approved })));

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

