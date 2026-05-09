// @ts-nocheck
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPersonaSessionKey,
  createRequestScopedToolMap,
  extractRequestedPersonaId,
  resolveRequestScopedPersonaRuntime,
} from '../execution/request-persona.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('request-persona runtime helper', () => {
  it('resolves a request-scoped persona override and replaces the persisted system prompt', async () => {
    const dir = path.join(os.tmpdir(), `wunderland-request-persona-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'personas'), { recursive: true });

    writeFileSync(
      path.join(dir, 'personas', 'custom_architect.json'),
      JSON.stringify({
        id: 'custom_architect',
        name: 'Custom Architect',
        description: 'Custom file-backed persona',
        version: '1.0.0',
        baseSystemPrompt: 'You are Custom Architect. Design systems carefully.',
        personalityTraits: {
          openness: 0.91,
        },
        memoryConfig: {
          enabled: true,
          ragConfig: {
            enabled: true,
            defaultRetrievalStrategy: 'hybrid_search',
            defaultRetrievalTopK: 8,
            dataSources: [
              {
                id: 'arch_docs',
                dataSourceNameOrId: 'architecture_docs',
                isEnabled: true,
              },
            ],
          },
        },
      }, null, 2),
      'utf8',
    );

    writeFileSync(path.join(dir, 'PERSONA.md'), 'Local persona overlay instructions.', 'utf8');

    const result = await resolveRequestScopedPersonaRuntime({
      rawAgentConfig: {
        seedId: 'seed_custom_architect',
        systemPrompt: 'Persisted default prompt that should be replaced.',
        personaRegistry: { enabled: true },
      },
      requestedPersonaId: 'custom_architect',
      workingDirectory: dir,
      policy: {
        executionMode: 'human-dangerous',
        permissionSet: 'standard',
        toolAccessProfile: 'developer',
      } as any,
      mode: 'server',
      lazyTools: false,
      autoApproveToolCalls: false,
      turnApprovalMode: 'off',
    });

    expect(result).toBeDefined();
    expect(result?.activePersonaId).toBe('custom_architect');
    expect(result?.agentConfig.rag?.enabled).toBe(true);
    expect(result?.agentConfig.rag?.strategy).toBe('hybrid_search');
    expect(result?.systemPrompt).toContain('You are Custom Architect. Design systems carefully.');
    expect(result?.systemPrompt).toContain('Local persona overlay instructions.');
    expect(result?.systemPrompt).not.toContain('Persisted default prompt that should be replaced.');
  });

  it('refreshes configured RAG tools for the active request persona', async () => {
    const dir = path.join(os.tmpdir(), `wunderland-request-persona-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'personas'), { recursive: true });

    writeFileSync(
      path.join(dir, 'personas', 'custom_architect.json'),
      JSON.stringify({
        id: 'custom_architect',
        name: 'Custom Architect',
        version: '1.0.0',
        baseSystemPrompt: 'You are Custom Architect.',
        memoryConfig: {
          enabled: true,
          ragConfig: {
            enabled: true,
            defaultRetrievalStrategy: 'hybrid_search',
            defaultRetrievalTopK: 6,
            dataSources: [
              {
                id: 'arch_docs',
                dataSourceNameOrId: 'architecture_docs',
                isEnabled: true,
              },
            ],
          },
        },
      }, null, 2),
      'utf8',
    );

    const result = await resolveRequestScopedPersonaRuntime({
      rawAgentConfig: {
        seedId: 'seed_custom_architect',
        personaRegistry: { enabled: true },
      },
      requestedPersonaId: 'custom_architect',
      workingDirectory: dir,
      policy: {
        executionMode: 'human-dangerous',
        permissionSet: 'standard',
        toolAccessProfile: 'developer',
      } as any,
      mode: 'server',
      lazyTools: false,
      autoApproveToolCalls: false,
      turnApprovalMode: 'off',
    });

    const originalRagTool = {
      name: 'rag_query',
      description: 'old rag tool',
      inputSchema: {},
      execute: vi.fn(),
      category: 'research',
    } as any;
    const baseToolMap = new Map<string, any>([
      ['dummy_tool', {
        name: 'dummy_tool',
        description: 'dummy',
        inputSchema: {},
        execute: vi.fn(),
        category: 'productivity',
      }],
      ['rag_query', originalRagTool],
    ]);

    const toolMap = createRequestScopedToolMap(baseToolMap, result!.agentConfig);

    expect(toolMap.has('dummy_tool')).toBe(true);
    expect(toolMap.has('memory_read')).toBe(true);
    expect(toolMap.has('rag_query')).toBe(true);
    expect(toolMap.get('rag_query')).not.toBe(originalRagTool);
  });

  it('extracts persona IDs and scopes sessions per persona', () => {
    expect(extractRequestedPersonaId({ personaId: 'voice_assistant_persona' })).toBe('voice_assistant_persona');
    expect(extractRequestedPersonaId({ selectedPersonaId: 'atlas-systems-architect' })).toBe('atlas-systems-architect');
    expect(buildPersonaSessionKey('session-1', 'voice_assistant_persona')).toBe('session-1::persona:voice_assistant_persona');
  });
});
