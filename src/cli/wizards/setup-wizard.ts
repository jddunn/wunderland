/**
 * @fileoverview Main setup wizard orchestrator.
 * Runs QuickStart (3 steps) or Advanced (7 steps) mode.
 * @module wunderland/cli/wizards/setup-wizard
 */

import * as p from '@clack/prompts';
import boxen from 'boxen';
import type { GlobalFlags, WizardState, SetupMode } from '../types.js';
import { accent, success as sColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { updateConfig } from '../config/config-manager.js';
import { mergeEnv } from '../config/env-manager.js';
import { URLS } from '../constants.js';
import { runApiKeysWizard } from './api-keys-wizard.js';
import { runChannelsWizard } from './channels-wizard.js';
import { runPersonalityWizard } from './personality-wizard.js';
import { runVoiceWizard } from './voice-wizard.js';
import {
  autoConfigureOllama,
  pullModel,
  type OllamaAutoConfigResult,
} from '../ollama/ollama-manager.js';

function createDefaultState(): WizardState {
  return {
    mode: 'quickstart',
    apiKeys: {},
    channels: [],
    channelCredentials: {},
    toolKeys: {},
    security: {
      preLlmClassifier: true,
      dualLlmAuditor: true,
      outputSigning: true,
      riskThreshold: 0.7,
    },
    agentName: 'My Wunderbot',
  };
}

export async function runSetupWizard(globals: GlobalFlags): Promise<void> {
  p.intro(accent('Wunderland Setup'));

  // Step 1: Mode selection
  const mode = await p.select<SetupMode>({
    message: 'How would you like to get started?',
    options: [
      { value: 'quickstart', label: 'QuickStart', hint: 'API key + go' },
      { value: 'advanced', label: 'Advanced', hint: 'full configuration' },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel('Setup cancelled.');
    return;
  }

  const state = createDefaultState();
  state.mode = mode;

  // Agent name
  const name = await p.text({
    message: 'What should your agent be called?',
    placeholder: 'My Wunderbot',
    defaultValue: 'My Wunderbot',
    validate: (val: string) => {
      if (!val.trim()) return 'Name cannot be empty';
      return undefined;
    },
  });

  if (p.isCancel(name)) {
    p.cancel('Setup cancelled.');
    return;
  }
  state.agentName = name;

  // Step 2: LLM Provider Keys (both modes)
  await runApiKeysWizard(state);
  if (!state.llmProvider) {
    p.cancel('No LLM provider selected.');
    return;
  }

  // Step 2b: Ollama auto-configuration (if Ollama selected)
  if (state.llmProvider === 'ollama') {
    await runOllamaAutoConfig(state);
  }

  // Step 3: Personality (Advanced only)
  if (state.mode === 'advanced') {
    await runPersonalityWizard(state);
  }

  // Step 4: Channels (both modes — QuickStart defaults to webchat)
  await runChannelsWizard(state);

  // Step 5: Tool Keys (Advanced only)
  if (state.mode === 'advanced') {
    await runToolKeysWizard(state);
  }

  // Step 6: Security (Advanced only)
  if (state.mode === 'advanced') {
    await runSecurityWizard(state);
  }

  // Step 7: Voice (Advanced only)
  if (state.mode === 'advanced') {
    await runVoiceWizard(state);
  }

  // Review
  const summary = [
    `Agent: ${accent(state.agentName)}`,
    `LLM: ${accent(state.llmProvider || 'none')} / ${accent(state.llmModel || 'default')}`,
    state.channels.length > 0 ? `Channels: ${state.channels.map((c) => accent(c)).join(', ')}` : null,
    state.personalityPreset ? `Personality: ${accent(state.personalityPreset)}` : null,
    state.voice ? `Voice: ${accent(state.voice.provider)}` : null,
    `Security: ${state.security.preLlmClassifier ? sColor('full pipeline') : wColor('minimal')}`,
  ].filter(Boolean).join('\n');

  console.log(boxen(summary, {
    padding: 1,
    margin: { top: 1, bottom: 1, left: 2, right: 2 },
    borderStyle: 'round',
    borderColor: '#a855f7',
    title: 'Review',
    titleAlignment: 'center',
  }));

  // Confirm
  if (!globals.yes) {
    const confirm = await p.confirm({ message: 'Write configuration?' });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Setup cancelled.');
      return;
    }
  }

  // Write config
  if (!globals.dryRun) {
    // Merge all env vars
    const allEnvKeys: Record<string, string> = { ...state.apiKeys, ...state.toolKeys };
    for (const [_platform, creds] of Object.entries(state.channelCredentials)) {
      Object.assign(allEnvKeys, creds);
    }
    if (state.voice?.apiKey) {
      allEnvKeys['ELEVENLABS_API_KEY'] = state.voice.apiKey;
    }

    await mergeEnv(allEnvKeys, globals.config);

    await updateConfig({
      agentName: state.agentName,
      llmProvider: state.llmProvider,
      llmModel: state.llmModel,
      personalityPreset: state.personalityPreset,
      customHexaco: state.customHexaco,
      channels: state.channels,
      tools: Object.keys(state.toolKeys).length > 0 ? Object.keys(state.toolKeys) : undefined,
      security: state.security,
      voiceProvider: state.voice?.provider,
      voiceModel: state.voice?.model,
      lastSetup: new Date().toISOString(),
    }, globals.config);
  }

  // Done
  p.outro(sColor('Setup complete!'));
  fmt.blank();
  fmt.note(`Next: ${sColor('wunderland init my-agent')} && ${sColor('wunderland start')}`);
  fmt.note(`Dashboard: ${fmt.link(URLS.saas)}`);
  fmt.blank();
}

// ── Ollama auto-configuration sub-wizard ─────────────────────────────────────

async function runOllamaAutoConfig(state: WizardState): Promise<void> {
  fmt.section('Ollama Auto-Configuration');

  let result: OllamaAutoConfigResult;
  try {
    result = await autoConfigureOllama();
  } catch {
    fmt.warning('Ollama not available. You can install it later from https://ollama.ai/');
    return;
  }

  if (!result.installed || !result.running) return;

  const rec = result.recommendation;
  const localNames = new Set(result.localModels.map((m) => m.name));

  // Check which models need to be pulled
  const needed: string[] = [];
  for (const modelId of [rec.router, rec.primary, rec.auditor]) {
    if (!localNames.has(modelId)) {
      needed.push(modelId);
    }
  }

  if (needed.length === 0) {
    fmt.ok('All recommended models are already installed.');
  } else {
    fmt.blank();
    fmt.note(`Models to pull: ${needed.map(accent).join(', ')}`);

    const confirmPull = await p.confirm({
      message: `Pull ${needed.length} recommended model${needed.length > 1 ? 's' : ''}?`,
      initialValue: true,
    });

    if (!p.isCancel(confirmPull) && confirmPull) {
      for (const modelId of needed) {
        fmt.note(`Pulling ${accent(modelId)}...`);
        try {
          await pullModel(modelId);
          fmt.ok(`${modelId} pulled successfully`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fmt.warning(`Failed to pull ${modelId}: ${msg}`);
        }
      }
    }
  }

  // Set the model in state
  state.llmModel = rec.primary;
  fmt.blank();
  fmt.ok(`Ollama configured: primary=${accent(rec.primary)} router=${accent(rec.router)}`);
}

// ── Inline sub-wizards for tool keys & security ─────────────────────────────

async function runToolKeysWizard(state: WizardState): Promise<void> {
  const toolOptions = [
    { value: 'web-search', label: 'Web Search (Serper/SerpAPI/Brave)', hint: 'recommended' },
    { value: 'voice', label: 'Voice (ElevenLabs)' },
    { value: 'image-search', label: 'Image Search (Pexels/Unsplash)' },
    { value: 'news', label: 'News (NewsAPI)' },
    { value: 'media', label: 'GIFs (Giphy)' },
  ];

  const selected = await p.multiselect({
    message: 'Configure tool API keys?',
    options: toolOptions,
    required: false,
  });

  if (p.isCancel(selected)) return;

  const toolProviderMap: Record<string, { envVar: string; label: string; docsUrl: string }> = {
    'web-search': { envVar: 'SERPER_API_KEY', label: 'Serper.dev API Key', docsUrl: 'https://serper.dev/api-key' },
    'voice': { envVar: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API Key', docsUrl: 'https://elevenlabs.io/docs' },
    'image-search': { envVar: 'PEXELS_API_KEY', label: 'Pexels API Key', docsUrl: 'https://www.pexels.com/api/' },
    'news': { envVar: 'NEWSAPI_API_KEY', label: 'NewsAPI Key', docsUrl: 'https://newsapi.org/' },
    'media': { envVar: 'GIPHY_API_KEY', label: 'Giphy API Key', docsUrl: 'https://developers.giphy.com/' },
  };

  for (const toolId of selected as string[]) {
    const tool = toolProviderMap[toolId];
    if (!tool) continue;

    const value = await p.password({
      message: `${tool.label}:`,
    });

    if (p.isCancel(value)) continue;
    if (value) state.toolKeys[tool.envVar] = value as string;

    fmt.note(`Get one at: ${fmt.link(tool.docsUrl)}`);
  }
}

async function runSecurityWizard(state: WizardState): Promise<void> {
  const securityOptions = [
    { value: 'preLlmClassifier', label: 'Pre-LLM Classifier', hint: 'screen inputs before LLM' },
    { value: 'dualLlmAuditor', label: 'Dual-LLM Auditor', hint: 'second model audits responses' },
    { value: 'outputSigning', label: 'Output Signing', hint: 'cryptographic provenance' },
  ];

  const selected = await p.multiselect({
    message: 'Security features:',
    options: securityOptions,
    initialValues: ['preLlmClassifier', 'dualLlmAuditor', 'outputSigning'],
    required: false,
  });

  if (p.isCancel(selected)) return;

  const sel = selected as string[];
  state.security = {
    preLlmClassifier: sel.includes('preLlmClassifier'),
    dualLlmAuditor: sel.includes('dualLlmAuditor'),
    outputSigning: sel.includes('outputSigning'),
    riskThreshold: 0.7,
  };

  const threshold = await p.text({
    message: 'Risk threshold (0.0 - 1.0):',
    defaultValue: '0.7',
    placeholder: '0.7',
    validate: (val: string) => {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0 || n > 1) return 'Must be a number between 0 and 1';
      return undefined;
    },
  });

  if (!p.isCancel(threshold)) {
    state.security.riskThreshold = parseFloat(threshold);
  }
}
