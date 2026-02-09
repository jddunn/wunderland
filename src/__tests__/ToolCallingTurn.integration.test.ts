import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runToolCallingTurn, type ToolInstance } from '../cli/openai/tool-calling.js';
import { createSchemaOnDemandTools } from '../cli/openai/schema-on-demand.js';

function mockOpenAIChatCompletionSequence(messages: Array<Record<string, unknown>>) {
  const queue = messages.slice();
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('Test bug: fetch called more times than expected.');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(next),
    } as any;
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return fetchMock;
}

describe('runToolCallingTurn (integration)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prompts for approval before executing an unknown-category side-effect tool in tiered mode', async () => {
    const tool: ToolInstance = {
      name: 'browser_click',
      description: 'Click an element',
      inputSchema: {
        type: 'object',
        required: ['selector'],
        properties: { selector: { type: 'string' } },
      },
      category: 'research', // not covered by explicit tier overrides
      hasSideEffects: true,
      execute: vi.fn(async () => ({ success: true, output: { ok: true } })),
    };

    mockOpenAIChatCompletionSequence([
      {
        model: 'gpt-test',
        usage: {},
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  function: { name: 'browser_click', arguments: JSON.stringify({ selector: '#buy' }) },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'gpt-test',
        usage: {},
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      },
    ]);

    const askPermission = vi.fn(async () => true);

    const reply = await runToolCallingTurn({
      apiKey: 'test-key',
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      toolMap: new Map([[tool.name, tool]]),
      toolDefs: [
        {
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        },
      ],
      toolContext: { gmiId: 'gmi-1', personaId: 'persona-1', userContext: { userId: 'u-1' } },
      maxRounds: 3,
      dangerouslySkipPermissions: false,
      askPermission,
    });

    expect(reply).toBe('done');
    expect(askPermission).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('executes without prompting when dangerouslySkipPermissions is enabled', async () => {
    const tool: ToolInstance = {
      name: 'browser_click',
      description: 'Click an element',
      inputSchema: {
        type: 'object',
        required: ['selector'],
        properties: { selector: { type: 'string' } },
      },
      category: 'research',
      hasSideEffects: true,
      execute: vi.fn(async () => ({ success: true, output: { ok: true } })),
    };

    mockOpenAIChatCompletionSequence([
      {
        model: 'gpt-test',
        usage: {},
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  function: { name: 'browser_click', arguments: JSON.stringify({ selector: '#buy' }) },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'gpt-test',
        usage: {},
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      },
    ]);

    const askPermission = vi.fn(async () => false);

    const reply = await runToolCallingTurn({
      apiKey: 'test-key',
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      toolMap: new Map([[tool.name, tool]]),
      toolDefs: [
        {
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        },
      ],
      toolContext: { gmiId: 'gmi-1', personaId: 'persona-1', userContext: { userId: 'u-1' } },
      maxRounds: 3,
      dangerouslySkipPermissions: true,
      askPermission,
    });

    expect(reply).toBe('done');
    expect(askPermission).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('updates tool schemas after a schema-on-demand meta tool mutates the toolMap', async () => {
    const toolMap = new Map<string, ToolInstance>();

    const helloTool: ToolInstance = {
      name: 'hello_tool',
      description: 'Say hello',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      category: 'system',
      hasSideEffects: false,
      execute: vi.fn(async () => ({ success: true, output: { ok: true } })),
    };

    const extensionsEnable: ToolInstance = {
      name: 'extensions_enable',
      description: 'Enable an extension pack',
      inputSchema: {
        type: 'object',
        required: ['extension'],
        properties: { extension: { type: 'string' } },
        additionalProperties: false,
      },
      category: 'system',
      hasSideEffects: true,
      execute: vi.fn(async () => {
        toolMap.set(helloTool.name, helloTool);
        return { success: true, output: { loaded: true } };
      }),
    };

    toolMap.set(extensionsEnable.name, extensionsEnable);

    const queue = [
      {
        model: 'gpt-test',
        usage: {},
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  function: { name: 'extensions_enable', arguments: JSON.stringify({ extension: 'hello' }) },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'gpt-test',
        usage: {},
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      },
    ];

    let fetchCalls = 0;
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      fetchCalls += 1;
      const body = JSON.parse(init?.body || '{}');
      const toolNames = Array.isArray(body?.tools)
        ? body.tools.map((t: any) => t?.function?.name).filter(Boolean)
        : [];

      if (fetchCalls === 1) {
        expect(toolNames).toEqual(['extensions_enable']);
      }
      if (fetchCalls === 2) {
        expect(toolNames).toContain('extensions_enable');
        expect(toolNames).toContain('hello_tool');
      }

      const next = queue.shift();
      if (!next) throw new Error('Test bug: fetch called more times than expected.');
      return { ok: true, status: 200, text: async () => JSON.stringify(next) } as any;
    });

    vi.stubGlobal('fetch', fetchMock as any);

    const reply = await runToolCallingTurn({
      apiKey: 'test-key',
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      toolMap,
      toolContext: { gmiId: 'gmi-1', personaId: 'persona-1', userContext: { userId: 'u-1' } },
      maxRounds: 3,
      dangerouslySkipPermissions: true,
      askPermission: vi.fn(async () => false),
    });

    expect(reply).toBe('done');
    expect(extensionsEnable.execute).toHaveBeenCalledTimes(1);
    expect(helloTool.execute).not.toHaveBeenCalled();
  });

  it('runs extension pack onActivate when enabling via extensions_enable', async () => {
    const toolMap = new Map<string, ToolInstance>();

    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-workspace-'));
    const agentId = 'agent-onactivate-test';
    const workspaceDir = path.join(baseDir, agentId);

    try {
      const metaTools = createSchemaOnDemandTools({
        toolMap,
        runtimeDefaults: {
          workingDirectory: process.cwd(),
          headlessBrowser: true,
          dangerouslySkipCommandSafety: false,
          agentWorkspace: { agentId, baseDir },
        },
        logger: console,
      });

      for (const tool of metaTools) toolMap.set(tool.name, tool);

      const enable = toolMap.get('extensions_enable');
      expect(enable).toBeTruthy();

      const result = await enable!.execute({
        extension: '@framers/agentos-ext-cli-executor',
        source: 'package',
      }, {});

      expect(result.success).toBe(true);
      await expect(fs.stat(workspaceDir)).resolves.toBeTruthy();
      await expect(fs.stat(path.join(workspaceDir, 'assets'))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(workspaceDir, 'exports'))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(workspaceDir, 'tmp'))).resolves.toBeTruthy();

      expect(toolMap.has('shell_execute')).toBe(true);
      expect(toolMap.has('file_read')).toBe(true);
      expect(toolMap.has('file_write')).toBe(true);
      expect(toolMap.has('list_directory')).toBe(true);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
