/**
 * @fileoverview LLM provider resolution, Ollama auto-start, auth, OpenRouter fallback.
 * Extracted from start.ts lines 359-485.
 */

import * as path from 'node:path';
import type { LLMProviderConfig } from '../../../runtime/tool-calling.js';
import * as fmt from '../../ui/format.js';
import {
  isLocalOllamaBaseUrl,
  isOllamaRunning,
  normalizeOllamaBaseUrl,
  startOllama,
  detectOllamaInstall,
} from '../../ollama/ollama-manager.js';
import {
  resolveWunderlandProviderId,
  resolveWunderlandTextModel,
} from '../../../config/provider-defaults.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../../../runtime/workspace.js';

export async function setupLlmProvider(ctx: any): Promise<boolean> {
  const { flags, globals, cfg, policy, seedId } = ctx;

  // Resolve provider/model from config (fallbacks preserve legacy env behavior).
  const providerFlag = typeof flags['provider'] === 'string' ? String(flags['provider']).trim() : '';
  const providerFromConfig = typeof cfg.llmProvider === 'string' ? String(cfg.llmProvider).trim() : '';
  let providerId;
  try {
    providerId = resolveWunderlandProviderId(
      flags['ollama'] === true ? 'ollama' : (providerFlag || providerFromConfig || 'openai'),
    );
  } catch {
    fmt.errorBlock(
      'Unsupported LLM provider',
      `Provider "${flags['ollama'] === true ? 'ollama' : (providerFlag || providerFromConfig || 'openai')}" is not supported by this CLI runtime.\nSupported: openai, openrouter, ollama, anthropic, gemini`,
    );
    process.exitCode = 1;
    return false;
  }

  const modelFromConfig = typeof cfg.llmModel === 'string' ? String(cfg.llmModel).trim() : '';
  const model = resolveWunderlandTextModel({
    providerId: providerId as any,
    model: typeof flags['model'] === 'string' ? String(flags['model']) : modelFromConfig,
  });

  const ollamaBaseUrl = (() => {
    const configBaseUrl = typeof cfg?.ollama?.baseUrl === 'string' ? cfg.ollama.baseUrl.trim() : '';
    const raw = String(process.env['OLLAMA_BASE_URL'] || '').trim() || configBaseUrl;
    const normalized = normalizeOllamaBaseUrl(raw);
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
  })();

  // Auto-start Ollama if configured as provider
  const isOllamaProvider = providerId === 'ollama';
  if (isOllamaProvider) {
    const ollamaApiBase = normalizeOllamaBaseUrl(ollamaBaseUrl);
    if (isLocalOllamaBaseUrl(ollamaApiBase)) {
      const ollamaBin = await detectOllamaInstall();
      if (ollamaBin) {
        const running = await isOllamaRunning(ollamaApiBase);
        if (!running) {
          fmt.note('Ollama is configured but not running - starting...');
          try {
            await startOllama(ollamaApiBase);
            fmt.ok(`Ollama server started at ${ollamaApiBase}`);
          } catch {
            fmt.warning('Failed to start Ollama. Start it manually: ollama serve');
          }
        } else {
          fmt.ok(`Ollama server is running at ${ollamaApiBase}`);
        }
      } else {
        fmt.warning('Ollama is configured but no local binary was found. Install Ollama or point OLLAMA_BASE_URL to a remote instance.');
      }
    } else {
      const running = await isOllamaRunning(ollamaApiBase);
      if (!running) {
        fmt.errorBlock('Remote Ollama unavailable', `Could not reach Ollama at ${ollamaApiBase}.`);
        process.exitCode = 1;
        return false;
      }
      fmt.ok(`Remote Ollama is reachable at ${ollamaApiBase}`);
    }
  }

  const portRaw = typeof flags['port'] === 'string' ? flags['port'] : (process.env['PORT'] || '');
  const port = Number(portRaw) || 3777;

  // OpenRouter fallback — when OPENROUTER_API_KEY is set, use it as automatic fallback
  const openrouterApiKey = process.env['OPENROUTER_API_KEY'] || '';
  const openrouterFallback: LLMProviderConfig | undefined = openrouterApiKey
    ? {
        apiKey: openrouterApiKey,
        model: typeof flags['openrouter-model'] === 'string' ? flags['openrouter-model'] : 'auto',
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: { 'HTTP-Referer': 'https://wunderland.sh', 'X-Title': 'Wunderbot' },
      }
    : undefined;

  const dangerouslySkipPermissions = flags['dangerously-skip-permissions'] === true;
  const dangerouslySkipCommandSafety =
    flags['dangerously-skip-command-safety'] === true || dangerouslySkipPermissions;
  const autoApproveToolCalls =
    globals.autoApproveTools || dangerouslySkipPermissions || policy.executionMode === 'autonomous';
  const enableSkills = flags['no-skills'] !== true;
  const lazyTools = flags['lazy-tools'] === true || cfg?.lazyTools === true;
  const workspaceBaseDir = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(seedId);
  // Expose a stable workspace directory path for extension packs (channels/tools) that need
  // to persist lightweight state (rate limits, caches, etc.).
  try {
    const workspaceDir = path.join(workspaceBaseDir, workspaceAgentId);
    if (!process.env['WUNDERLAND_WORKSPACE_DIR']) process.env['WUNDERLAND_WORKSPACE_DIR'] = workspaceDir;
  } catch {
    // ignore
  }

  const llmBaseUrl =
    providerId === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : providerId === 'ollama' ? ollamaBaseUrl
    : providerId === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : undefined;
  // Resolve auth method (OAuth or API key)
  const authMethod: 'api-key' | 'oauth' =
    (cfg?.llmAuthMethod === 'oauth' || flags['oauth'] === true) && providerId === 'openai'
      ? 'oauth'
      : 'api-key';

  let llmApiKey: string;
  let oauthGetApiKey: (() => Promise<string>) | undefined;

  if (authMethod === 'oauth') {
    fmt.errorBlock(
      'Not yet supported',
      'OAuth subscription-based usage (ChatGPT Plus/Pro) is not yet available.\n' +
      'OpenAI subscription token usage requires a registered OAuth application.\n' +
      'Please use an OpenAI API key instead — get one at https://platform.openai.com/api-keys',
    );
    process.exitCode = 1;
    return false;
  } else {
    llmApiKey =
      providerId === 'openrouter' ? openrouterApiKey
      : providerId === 'ollama' ? 'ollama'
      : providerId === 'openai' ? (process.env['OPENAI_API_KEY'] || '')
      : providerId === 'anthropic' ? (process.env['ANTHROPIC_API_KEY'] || '')
      : providerId === 'gemini' ? (process.env['GEMINI_API_KEY'] || '')
      : (process.env['OPENAI_API_KEY'] || '');
  }

  const canUseLLM =
    providerId === 'ollama'
      ? true
      : providerId === 'openrouter'
        ? !!openrouterApiKey
        : providerId === 'anthropic'
          ? !!process.env['ANTHROPIC_API_KEY']
          : providerId === 'gemini'
            ? !!process.env['GEMINI_API_KEY']
            : !!llmApiKey || !!openrouterFallback;

  ctx.providerId = providerId;
  ctx.model = model;
  ctx.port = port;
  ctx.openrouterFallback = openrouterFallback;
  ctx.dangerouslySkipPermissions = dangerouslySkipPermissions;
  ctx.dangerouslySkipCommandSafety = dangerouslySkipCommandSafety;
  ctx.autoApproveToolCalls = autoApproveToolCalls;
  ctx.enableSkills = enableSkills;
  ctx.lazyTools = lazyTools;
  ctx.workspaceBaseDir = workspaceBaseDir;
  ctx.workspaceAgentId = workspaceAgentId;
  ctx.llmBaseUrl = llmBaseUrl;
  ctx.llmApiKey = llmApiKey;
  ctx.oauthGetApiKey = oauthGetApiKey;
  ctx.canUseLLM = canUseLLM;
  ctx.authMethod = authMethod;

  return true;
}
