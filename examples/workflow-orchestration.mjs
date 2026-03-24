/**
 * Example: deterministic workflow() orchestration with an LLM-as-judge step.
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   OPENAI_API_KEY=... node examples/workflow-orchestration.mjs
 */

import { createWunderland } from 'wunderland';
import { workflow } from 'wunderland/workflows';

const sourceCollector = {
  id: 'demo.collect.sources',
  name: 'collect_sources',
  displayName: 'Collect Sources',
  description: 'Return a small deterministic source bundle for a topic.',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' },
    },
  },
  hasSideEffects: false,
  async execute(args) {
    const topic = String(args?.topic ?? 'unknown topic');
    return {
      scratch: {
        research: {
          topic,
          sources: [
            { title: `Primer on ${topic}`, quality: 8, url: 'https://example.com/primer' },
            { title: `${topic} market note`, quality: 7, url: 'https://example.com/market' },
          ],
        },
      },
    };
  },
};

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai' },
    tools: { custom: [sourceCollector] },
  });

  const compiled = workflow('research-pipeline')
    .input({
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string' },
      },
    })
    .returns({
      type: 'object',
      properties: {
        finalSummary: { type: 'string' },
      },
    })
    .step('collect', {
      tool: 'collect_sources',
    })
    .then('judge', {
      gmi: {
        instructions: [
          'Review scratch.collect.research.',
          'Return JSON with a scratch.judge object.',
          'Use this exact shape:',
          '{"scratch":{"judge":{"score":8,"verdict":"ship","reasoning":"..."}}}',
        ].join(' '),
      },
    })
    .branch(
      (state) => Number(state.scratch?.judge?.score ?? 0) >= 7 ? 'ship' : 'revise',
      {
        ship: {
          gmi: {
            instructions: [
              'Write a concise summary from scratch.collect.research and scratch.judge.',
              'Return JSON like {"artifacts":{"finalSummary":"..."}}.',
            ].join(' '),
          },
        },
        revise: {
          gmi: {
            instructions: 'Return JSON like {"artifacts":{"finalSummary":"Research quality is too low to ship yet."}}.',
          },
        },
      },
    )
    .compile();

  const result = await app.runGraph(compiled, { topic: 'agent orchestration frameworks' });
  console.log(JSON.stringify(result, null, 2));
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
