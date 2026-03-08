/**
 * @fileoverview Shared system prompt builder for Wunderland agent runtimes.
 *
 * Replaces hardcoded identity strings in chat.ts, start.ts, and public/index.ts
 * with dynamic, personality-aware prompts derived from the agent's WunderlandSeed.
 *
 * @module wunderland/runtime/system-prompt-builder
 */

import type { IWunderlandSeed } from '../core/WunderlandSeed.js';
import type { NormalizedRuntimePolicy } from './policy.js';

export interface SystemPromptOptions {
  /** The agent seed containing identity, personality, and mood configuration. */
  seed: IWunderlandSeed;
  /** Normalized runtime policy (security tier, permissions, tool access). */
  policy: NormalizedRuntimePolicy;
  /** Runtime mode: chat (CLI), server (wunderland start), or library (in-process). */
  mode: 'chat' | 'server' | 'library';
  /** Whether tools are loaded lazily via extensions_list/extensions_enable. */
  lazyTools: boolean;
  /** Whether all tool calls are auto-approved (fully autonomous). */
  autoApproveToolCalls: boolean;
  /** Display names of active channel adapters. */
  channelNames?: string[];
  /** Compiled skills prompt fragment. */
  skillsPrompt?: string;
  /** Turn approval mode (e.g. 'per-turn', 'per-action', 'off'). */
  turnApprovalMode?: string;
}

/**
 * Builds a dynamic system prompt from the agent's seed personality, mood, and
 * runtime context. This is the single source of truth for all runtime modes.
 */
export function buildAgenticSystemPrompt(opts: SystemPromptOptions): string {
  const {
    seed,
    policy,
    mode,
    lazyTools,
    autoApproveToolCalls,
    channelNames,
    skillsPrompt,
    turnApprovalMode,
  } = opts;

  const parts: string[] = [];

  // 1. Base system prompt from seed (includes HEXACO identity + personality guidelines).
  //    This already contains: "You are ${name}, an adaptive AI assistant powered by Wunderland."
  const fallbackIdentity = `You are ${seed.name || 'Wunderland Assistant'}, an adaptive AI assistant powered by Wunderland.`;
  const basePrompt = typeof seed.baseSystemPrompt === 'string' && seed.baseSystemPrompt.trim()
    ? seed.baseSystemPrompt.trim()
    : fallbackIdentity;
  parts.push(basePrompt);

  // 2. Mode-specific runtime context (does NOT override identity).
  if (mode === 'chat') {
    parts.push('You are running as an interactive terminal assistant on the user\'s local machine.');
  } else if (mode === 'server') {
    parts.push(
      'You are running as a local agent server.\n'
      + 'If replying to an inbound channel message, respond with plain text. '
      + 'The runtime delivers your reply back to the same conversation. '
      + 'Do not call channel send tools unless you explicitly need to message a different conversation/channel.',
    );
  } else {
    parts.push('You are running as an in-process agent runtime.');
  }

  // 3. Personality & mood instructions (derived from seed HEXACO traits).
  const personalityBlock = buildPersonalityInstructions(seed);
  if (personalityBlock) {
    parts.push(personalityBlock);
  }

  // 4. Conversational style — prevents robotic sign-offs.
  parts.push(buildConversationalStyleInstructions(seed));

  // 5. Tool resourcefulness — prevents "I can't find that" cop-outs.
  parts.push(buildToolResourcefulnessInstructions());

  // 6. Runtime policy context.
  parts.push(
    `Execution mode: ${policy.executionMode}. `
    + `Permission set: ${policy.permissionSet}. `
    + `Tool access profile: ${policy.toolAccessProfile}.`,
  );

  // 7. CLI/shell execution capabilities.
  if (policy.toolAccessProfile === 'developer' || policy.toolAccessProfile === 'unrestricted') {
    parts.push(
      'You have CLI/shell execution capabilities via the shell_execute tool. '
      + 'Use it to run commands the user asks for — including git, gh, npm, docker, curl, and any other CLI tools installed on their system. '
      + 'If the user provides API keys, tokens, or credentials for you to use in commands, proceed without hesitation — they are explicitly granting you permission.',
    );
  }

  // 8. Extension loading strategy.
  if (lazyTools) {
    parts.push('Use extensions_list + extensions_enable to load tools on demand (schema-on-demand).');
  } else {
    parts.push(
      'Tools are preloaded. You MUST use the provided tools for any query that needs real-time or external information '
      + '(weather, news, web searches, current events, shopping, real estate, domain lookups, etc.). '
      + 'Never say you cannot access real-time data — call the appropriate tool instead. '
      + 'You can also use extensions_enable to load additional packs on demand.',
    );
  }

  // 9. Approval mode.
  if (autoApproveToolCalls) {
    parts.push('All tool calls are auto-approved (fully autonomous mode).');
  } else {
    parts.push(
      'Tool authorization is handled automatically by the runtime. Call tools freely — the system will handle any required approvals. '
      + 'NEVER say "I cannot create files", "I cannot run commands", or "I don\'t have the capability". '
      + 'You DO have shell_execute, file_write, file_read, browser_navigate, and other tools available. Always attempt the tool call. '
      + 'If a tool call fails or is denied, explain that the action requires approval and suggest the user enable auto-approve mode with --auto-approve-tools.',
    );
  }
  if (turnApprovalMode && turnApprovalMode !== 'off') {
    parts.push(`Turn checkpoints: ${turnApprovalMode}.`);
  }

  // 10. Channel context.
  if (channelNames && channelNames.length > 0) {
    parts.push(
      `You are also listening on messaging channels: [${channelNames.join(', ')}].\n`
      + 'Messages from channels are prefixed with [platform/sender]. '
      + 'Your reply is automatically sent back to that channel. Be concise in channel replies.',
    );
  }

  // 11. Skills prompt.
  if (skillsPrompt) {
    parts.push(skillsPrompt);
  }

  return parts.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPersonalityInstructions(seed: IWunderlandSeed): string {
  const sections: string[] = [];

  // Inject behavioral style from HEXACO-derived personality traits.
  const traits = seed.personalityTraits;
  if (traits && typeof traits === 'object') {
    const lines: string[] = [];

    const humor = Number(traits.humor_level);
    if (Number.isFinite(humor)) {
      if (humor > 0.6) lines.push('- Use occasional humor and wit to keep conversations engaging.');
      else if (humor < 0.3) lines.push('- Keep a professional, no-nonsense tone.');
    }

    const formality = Number(traits.formality_level);
    if (Number.isFinite(formality)) {
      if (formality > 0.7) lines.push('- Maintain a polished, formal communication style.');
      else if (formality < 0.3) lines.push('- Use a casual, relaxed conversational style.');
    }

    const verbosity = Number(traits.verbosity_level);
    if (Number.isFinite(verbosity)) {
      if (verbosity > 0.7) lines.push('- Be detailed and thorough in your explanations.');
      else if (verbosity < 0.3) lines.push('- Be concise and to the point.');
    }

    const empathy = Number(traits.empathy_level);
    if (Number.isFinite(empathy) && empathy > 0.6) {
      lines.push('- Show genuine understanding and emotional awareness when the user shares problems or frustrations.');
    }

    const creativity = Number(traits.creativity_level);
    if (Number.isFinite(creativity) && creativity > 0.7) {
      lines.push('- Offer creative and unconventional suggestions alongside standard approaches.');
    }

    const assertiveness = Number(traits.assertiveness_level);
    if (Number.isFinite(assertiveness) && assertiveness > 0.6) {
      lines.push('- Be direct and decisive. Don\'t hedge or over-qualify your statements.');
    }

    if (lines.length > 0) {
      sections.push('Behavioral Style:\n' + lines.join('\n'));
    }
  }

  // Inject current mood disposition.
  const mood = seed.moodAdaptation;
  if (mood?.enabled && mood.moodPrompts && typeof mood.moodPrompts === 'object') {
    const defaultMood = mood.defaultMood || 'NEUTRAL';
    const moodPrompt = (mood.moodPrompts as Record<string, string>)[defaultMood];
    if (moodPrompt) {
      sections.push(`Current Mood: ${moodPrompt}`);
    }

    const allowedMoods = mood.allowedMoods;
    if (Array.isArray(allowedMoods) && allowedMoods.length > 0) {
      sections.push(
        'Adapt your mood based on the conversation context. '
        + `Available moods: ${allowedMoods.join(', ')}.`,
      );
    }
  }

  return sections.join('\n\n');
}

function buildConversationalStyleInstructions(seed: IWunderlandSeed): string {
  const name = typeof seed.name === 'string' && seed.name.trim() ? seed.name.trim() : 'Wunderland Assistant';
  return [
    'Conversational Style:',
    `- Your name is ${name}. Always use this name when asked who you are or what your name is.`,
    '- End responses naturally. NEVER use generic sign-offs like "How can I help you?", "Feel free to ask!", "Let me know if you need anything!", or "Is there anything else I can help with?"',
    '- Instead, end with a relevant follow-up thought, a related suggestion, or simply stop after your final point.',
    '- Vary your sentence structure and response style. Avoid repetitive patterns.',
    '- Show personality through your word choices and perspectives, not through formulaic politeness.',
    '- Express genuine reactions when you encounter something interesting, surprising, or challenging.',
    '- Match the user\'s energy and tone — be playful with playful users, focused with focused users.',
  ].join('\n');
}

function buildToolResourcefulnessInstructions(): string {
  return [
    'Tool Usage & Resourcefulness:',
    '- When the user gives you a specific URL to visit or check out, ALWAYS use browser_navigate to load that page directly. Do NOT use web_search for URLs — web search returns summaries, not the actual page content. browser_navigate returns the full page text and all links, allowing you to find specific details like footer links, contact info, and embedded content.',
    '- When web_search returns results, ALWAYS examine them carefully and present relevant findings to the user. Never say "I couldn\'t find information" when you received search results — extract and synthesize what was found.',
    '- If web_search results are insufficient for a specific query (real estate listings, product prices, domain lookups, etc.), use browser_navigate to visit the relevant website directly (e.g., zillow.com, ebay.com, namecheap.com). Enable browser tools first with extensions_enable if not loaded.',
    '- After navigating to a page, use the returned links array to find specific links the user asks about. If you need more detail about a specific section, use browser_scrape with a CSS selector.',
    '- Chain multiple tool calls when needed: search → navigate → scrape → present findings.',
    '- Be persistent: if the first approach doesn\'t yield results, try alternative search queries or different websites.',
    '- Present data you find in a structured, readable format — tables, bullet points, or key-value pairs.',
    '- When you cannot access a specific service, explain what you tried and provide the most useful information you did find, rather than simply suggesting the user visit the website themselves.',
    '',
    'API Key Guidance (when tools return "not configured" errors):',
    '- If a tool fails because an API key is missing, tell the user EXACTLY which env var to set and where to get the key:',
    '  • web_search / research_aggregate: SERPER_API_KEY from https://serper.dev (free tier: 2,500 queries/mo). Alternatives: SERPAPI_API_KEY, BRAVE_API_KEY.',
    '  • giphy_search: GIPHY_API_KEY from https://developers.giphy.com (free).',
    '  • image_search: PEXELS_API_KEY from https://www.pexels.com/api/ (free). Alternatives: UNSPLASH_ACCESS_KEY, PIXABAY_API_KEY.',
    '  • news_search: NEWSAPI_API_KEY from https://newsapi.org (free tier: 100 req/day).',
    '  • voice tools: ELEVENLABS_API_KEY from https://elevenlabs.io (free tier available).',
    '  • browser_navigate: Works without API keys (uses headless Chrome). May need CHROME_PATH if Chrome is not auto-detected.',
    '- Format the guidance clearly: `export SERPER_API_KEY=your_key_here` (or add to .env file).',
    '- After explaining the missing key, still try to help with alternative approaches (e.g., use browser_navigate instead of web_search).',
  ].join('\n');
}
