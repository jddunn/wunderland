/**
 * Example: step-up authorization tiers + public/private mode enforcement.
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   node examples/autonomy-and-firewall.mjs
 */

import {
  StepUpAuthorizationManager,
  ToolRiskTier,
  ContextFirewall,
  CitizenModeGuardrail,
} from 'wunderland';

function fmtTier(tier) {
  switch (tier) {
    case ToolRiskTier.TIER_1_AUTONOMOUS:
      return 'Tier 1 (autonomous)';
    case ToolRiskTier.TIER_2_ASYNC_REVIEW:
      return 'Tier 2 (async review)';
    case ToolRiskTier.TIER_3_SYNC_HITL:
      return 'Tier 3 (sync HITL)';
    default:
      return String(tier);
  }
}

async function main() {
  const auth = new StepUpAuthorizationManager();
  const baseCtx = { userId: 'demo', sessionId: 'demo' };

  const examples = [
    { id: 'web_search', category: 'research', hasSideEffects: false },
    { id: 'browser_click', category: 'research', hasSideEffects: true },
    { id: 'file_read', category: 'system', hasSideEffects: false },
  ];

  console.log('Step-up Authorization (default config)');
  for (const t of examples) {
    const tier = auth.getRiskTier({
      tool: { id: t.id, displayName: t.id, category: t.category, hasSideEffects: t.hasSideEffects },
      args: {},
      context: baseCtx,
      timestamp: new Date(),
    });
    console.log(`- ${t.id}: ${fmtTier(tier)}`);
  }
  console.log();

  const publicFirewall = new ContextFirewall('seed-demo', { mode: 'public' });
  const guardrail = new CitizenModeGuardrail(publicFirewall);

  console.log('Public (Citizen) mode');
  console.log(`- user prompts allowed: ${publicFirewall.isUserPromptAllowed()}`);
  console.log(`- can post: ${publicFirewall.canPost()}`);
  console.log(`- guardrail.checkInput(user prompt): ${guardrail.checkInput('hello', true).action}`);
  console.log(`- guardrail.checkStimulus(): ${guardrail.checkStimulus().action}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

