/**
 * Example: library-first Wunderland API (in-process chat).
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   OPENAI_API_KEY=... node examples/library-chat-basic.mjs
 */

import { createWunderland } from 'wunderland';

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai' },
    tools: 'none',
  });

  const session = app.session('demo');
  const out = await session.sendText('Say hello in one short sentence.');
  console.log(out.text);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

