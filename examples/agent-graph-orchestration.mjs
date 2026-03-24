/**
 * Example: explicit AgentGraph routing with a research -> judge -> write loop.
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   OPENAI_API_KEY=... node examples/agent-graph-orchestration.mjs
 */

import { createWunderland } from 'wunderland';
import { AgentGraph, START, END, gmiNode, toolNode } from 'wunderland/workflows';

const loadBriefTool = {
  id: 'demo.load.brief',
  name: 'load_brief',
  displayName: 'Load Brief',
  description: 'Provide a starting brief for a topic.',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' },
    },
  },
  hasSideEffects: false,
  async execute(args) {
    const topic = String(args?.topic ?? 'unknown');
    return {
      scratch: {
        brief: {
          topic,
          notes: [
            `Primary objective: explain ${topic} clearly`,
            'Need a confident summary and a go/no-go decision',
          ],
        },
      },
    };
  },
};

async function main() {
  const app = await createWunderland({
    llm: { providerId: 'openai' },
    tools: { custom: [loadBriefTool] },
  });

  const graph = new AgentGraph({
    input: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string' },
      },
    },
    scratch: {
      type: 'object',
      properties: {},
    },
    artifacts: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
    },
  })
    .addNode('brief', toolNode('load_brief', { args: { topic: 'agent memory systems' } }))
    .addNode('research', gmiNode({
      instructions: [
        'Expand scratch.brief into a stronger research note.',
        'Return JSON like {"scratch":{"research":{"confidence":0.65,"findings":["..."]}}}.',
      ].join(' '),
      executionMode: 'single_turn',
    }))
    .addNode('judge', gmiNode({
      instructions: [
        'Review scratch.research.',
        'Return JSON like {"scratch":{"judge":{"verdict":"write","confidence":0.82,"reasoning":"..."}}}.',
      ].join(' '),
      executionMode: 'single_turn',
    }))
    .addNode('write', gmiNode({
      instructions: 'Return JSON like {"artifacts":{"answer":"Final answer here."}}.',
      executionMode: 'single_turn',
    }))
    .addEdge(START, 'brief')
    .addEdge('brief', 'research')
    .addEdge('research', 'judge')
    .addConditionalEdge('judge', (state) =>
      state.scratch?.judge?.verdict === 'write' ? 'write' : 'research',
    )
    .addEdge('write', END)
    .compile({ validate: false });

  const result = await app.runGraph(graph, { topic: 'agent memory systems' });
  console.log(JSON.stringify(result, null, 2));
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
