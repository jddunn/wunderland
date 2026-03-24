/**
 * Example: Wunderland library API with the image-generation extension.
 *
 * Run:
 *   cd packages/wunderland
 *   pnpm build
 *   OPENAI_API_KEY=... STABILITY_API_KEY=... node examples/library-chat-image-generation.mjs
 *
 * You can override the preferred image provider with:
 *   WUNDERLAND_IMAGE_PROVIDER=openrouter
 *   WUNDERLAND_IMAGE_PROVIDER=replicate
 */

import { createWunderland } from 'wunderland';

function resolveLlmConfig() {
  if (process.env.OPENAI_API_KEY) return { providerId: 'openai' };
  if (process.env.OPENROUTER_API_KEY) return { providerId: 'openrouter' };
  if (process.env.ANTHROPIC_API_KEY) return { providerId: 'anthropic' };
  if (process.env.GEMINI_API_KEY) return { providerId: 'gemini' };
  return null;
}

function resolveImageProviderDefault() {
  if (process.env.WUNDERLAND_IMAGE_PROVIDER) return process.env.WUNDERLAND_IMAGE_PROVIDER;
  if (process.env.REPLICATE_API_TOKEN) return 'replicate';
  if (process.env.STABILITY_API_KEY) return 'stability';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

async function main() {
  const llm = resolveLlmConfig();
  if (!llm) {
    console.error('Missing an LLM credential. Set OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.');
    process.exitCode = 1;
    return;
  }

  const defaultImageProvider = resolveImageProviderDefault();
  if (!defaultImageProvider) {
    console.error('Missing an image-generation credential. Set OPENAI_API_KEY, OPENROUTER_API_KEY, STABILITY_API_KEY, or REPLICATE_API_TOKEN.');
    process.exitCode = 1;
    return;
  }

  const app = await createWunderland({
    llm,
    tools: 'none',
    extensions: {
      tools: ['image-generation'],
      overrides: {
        'image-generation': {
          options: {
            defaultProvider: defaultImageProvider,
          },
        },
      },
    },
  });

  console.log('Loaded tools:', app.diagnostics().tools.names.join(', '));

  const session = app.session('image-demo');
  const out = await session.sendText(
    'Use the image-generation tool once to create a square poster-style image of a rabbit astronaut in a neon city, then answer in one short sentence.',
  );

  console.log(out.text);
  console.log(
    'Tool calls:',
    out.toolCalls.map((call) => ({
      toolName: call.toolName,
      approved: call.approved,
      providerHint: defaultImageProvider,
    })),
  );

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
