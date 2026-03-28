import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

vi.mock('../runtime/tool-calling.js', async () => {
  const actual = await vi.importActual<any>('../runtime/tool-calling.js');
  return {
    ...actual,
    runToolCallingTurn: vi.fn(),
  };
});

vi.mock('../rag/http-proxy.js', () => ({
  maybeProxyAgentosRagRequest: vi.fn(async () => false),
}));

import { createAgentHttpServer } from '../cli/commands/start/http-server.js';
import { runToolCallingTurn } from '../runtime/tool-calling.js';

describe('createAgentHttpServer SSE chat streaming', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('streams progress and reply events for /chat requests in stream mode', async () => {
    vi.mocked(runToolCallingTurn).mockImplementation(async (opts: any) => {
      opts.onToolProgress?.({
        toolName: 'deep_research',
        phase: 'searching',
        message: 'Searching sources',
        progress: 0.5,
      });
      return 'final answer';
    });

    const server = createAgentHttpServer({
      hitlSecret: '',
      chatSecret: '',
      feedSecret: '',
      hitlManager: {
        requestApproval: vi.fn(async () => ({ approved: true })),
        checkpoint: vi.fn(async () => ({ decision: 'continue' })),
        cancelRequest: vi.fn(async () => undefined),
      },
      pairing: null,
      pairingEnabled: false,
      sessions: new Map(),
      systemPrompt: 'system prompt',
      toolMap: new Map(),
      canUseLLM: true,
      seed: { seedId: 'seed_test' },
      seedId: 'seed_test',
      displayName: 'Test Agent',
      providerId: 'openai',
      model: 'gpt-4o-mini',
      llmApiKey: 'test-key',
      llmBaseUrl: 'https://api.openai.com/v1',
      policy: {
        permissionSet: 'default',
        securityTier: 'standard',
        executionMode: 'autonomous',
        toolAccessProfile: 'default',
        wrapToolOutputs: true,
      },
      adaptiveRuntime: {
        resolveTurnDecision: vi.fn(() => ({
          toolFailureMode: 'fail_open',
          degraded: false,
          reason: undefined,
          actions: undefined,
          kpi: undefined,
        })),
        recordTurnOutcome: vi.fn(async () => undefined),
      },
      discoveryManager: {
        discoverForTurn: vi.fn(async () => null),
      },
      autoApproveToolCalls: true,
      dangerouslySkipPermissions: true,
      strictToolNames: false,
      openrouterFallback: undefined,
      oauthGetApiKey: undefined,
      workspaceAgentId: 'seed_test',
      workspaceBaseDir: process.cwd(),
      sseClients: new Set(),
      broadcastHitlUpdate: vi.fn(),
      adapterByPlatform: new Map(),
      loadedHttpHandlers: [],
      turnApprovalMode: 'off',
      defaultTenantId: undefined,
      port: 0,
      startTime: Date.now(),
      cfg: { research: { autoClassify: false } },
      rawAgentConfig: {},
      globalConfig: {},
      configDir: process.cwd(),
      lazyTools: false,
      skillsPrompt: '',
      selectedPersona: undefined,
      availablePersonas: [],
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'research TMJ treatment',
          stream: true,
        }),
      });

      const body = await response.text();

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(body).toContain('event: progress');
      expect(body).toContain('"type":"SYSTEM_PROGRESS"');
      expect(body).toContain('"toolName":"deep_research"');
      expect(body).toContain('event: reply');
      expect(body).toContain('"type":"REPLY"');
      expect(body).toContain('"reply":"final answer"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
