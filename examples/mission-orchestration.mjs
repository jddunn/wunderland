/**
 * Example: mission() planning + explain() + Wunderland graph execution.
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   OPENAI_API_KEY=... node examples/mission-orchestration.mjs
 */

import { createWunderland } from 'wunderland';
import { mission, toolNode } from 'wunderland/workflows';

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai' },
    tools: 'none',
  });

  const compiled = mission('deep-research')
    .input({
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string' },
      },
    })
    .goal('Research {{topic}} and produce a concise summary with a confidence score')
    .returns({
      type: 'object',
      properties: {
        summary: { type: 'string' },
        confidence: { type: 'number' },
      },
    })
    .planner({
      strategy: 'plan_and_execute',
      maxSteps: 4,
      maxIterationsPerNode: 1,
      parallelTools: false,
    })
    .anchor(
      'fact-check',
      toolNode('unknown'),
      {
        phase: 'validate',
        before: ['output'],
      },
    )
    .compile();

  const explanation = await compiled.explain({ topic: 'graph-based agent runtimes' });
  console.log('Planned steps:');
  for (const step of explanation.steps) {
    console.log(`- ${step.id}: ${step.type}`);
  }

  const result = await app.runGraph(compiled, { topic: 'graph-based agent runtimes' });
  console.log(JSON.stringify(result, null, 2));
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
