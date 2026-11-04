// @ts-nocheck
/**
 * @fileoverview Integration tests for the workspace id the agent bootstrap takes.
 * @module wunderland/agents/__tests__/AgentBootstrap.workspace.integration.test
 *
 * The id names the agent's folder under the workspace base, the folder its file
 * tools work in. An id that would name the base itself or the folder above it
 * is refused before anything is set up; other ids keep their folder names.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AgentBootstrap } from '../lifecycle/AgentBootstrap.js';
import { createWunderlandChatRuntime } from '../../channels/api/chat-runtime.js';
import { WunderlandConfigError } from '../../platform/config/errors.js';
import { getAgentWorkspaceDirFromContext } from '../../runtime/tools/tool-helpers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A temp folder holding an empty workspace base and an empty working folder. */
function makeFolders(): { root: string; base: string; work: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'wunderland-bootstrap-workspace-'));
  roots.push(root);
  const base = path.join(root, 'agents');
  const work = path.join(root, 'work');
  mkdirSync(base);
  mkdirSync(work);
  return { root, base, work };
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** The bootstrap with no extensions, skills, discovery, guardrail packs or stores, so only the workspace varies. */
function bootstrap(folders: { base: string; work: string }, overrides: Record<string, any> = {}) {
  return AgentBootstrap.create({
    mode: 'library',
    providerId: 'openai',
    apiKey: 'test-key',
    lazyTools: true,
    skipMemory: true,
    disableSkills: true,
    workspaceBaseDir: folders.base,
    workingDirectory: folders.work,
    logger: quiet,
    ...overrides,
    agentConfig: {
      seedId: 'seed_workspace',
      discovery: { enabled: false },
      disableGuardrailPacks: true,
      taskOutcomeTelemetry: { persist: false },
      ...(overrides.agentConfig ?? {}),
    },
  });
}

/** Nothing was made beside the base, in it, or in the working folder. */
function expectNothingMade(folders: { root: string; base: string; work: string }): void {
  expect(readdirSync(folders.root).sort()).toEqual(['agents', 'work']);
  expect(readdirSync(folders.base)).toEqual([]);
  expect(readdirSync(folders.work)).toEqual([]);
}

describe('AgentBootstrap workspace id', () => {
  it.each(['..', '.', '/..', ' .. ', '../'])(
    'refuses the workspace id %j before anything is set up',
    async (workspaceId) => {
      const folders = makeFolders();
      const warnings: string[] = [];

      const error = await bootstrap(folders, {
        workspaceId,
        logger: { ...quiet, warn: (message: string) => warnings.push(message) },
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(WunderlandConfigError);
      expect(error.message).toMatch(/^Invalid agent config: /);
      expect(error.message).toContain(JSON.stringify(workspaceId));
      expect(error.issues).toEqual([
        expect.objectContaining({ path: 'workspace.agentId', message: expect.stringContaining('refused') }),
      ]);
      expect(warnings.filter((message) => message.includes('Agent config refused'))).toHaveLength(1);
      expectNothingMade(folders);
    },
  );

  it('refuses a seed id of ".." when the seed id names the workspace', async () => {
    const folders = makeFolders();

    const error = await bootstrap(folders, { agentConfig: { seedId: '..' } }).catch((caught) => caught);

    expect(error).toBeInstanceOf(WunderlandConfigError);
    expect(error.issues).toEqual([expect.objectContaining({ path: 'seedId' })]);
    expectNothingMade(folders);
  });

  it('refuses a workspace agent id of ".." given to the chat runtime', async () => {
    const folders = makeFolders();

    await expect(
      createWunderlandChatRuntime({
        llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
        autoApproveToolCalls: true,
        workspace: { agentId: '..', baseDir: folders.base },
        workingDirectory: folders.work,
        logger: quiet,
        agentConfig: {
          lazyTools: true,
          discovery: { enabled: false },
          disableGuardrailPacks: true,
          taskOutcomeTelemetry: { persist: false },
          memory: { enabled: false },
        },
      }),
    ).rejects.toBeInstanceOf(WunderlandConfigError);
    expectNothingMade(folders);
  });

  it.each([
    ['agent-1', 'agent-1'],
    ['team/../agent', 'team-..-agent'],
    ['My Agent!', 'My-Agent'],
  ])('keeps the workspace id %j as the folder %j inside the base', async (workspaceId, folderName) => {
    const folders = makeFolders();

    const agent = await bootstrap(folders, { workspaceId });
    try {
      expect(agent.workspace).toEqual({ agentId: folderName, baseDir: folders.base });
      // The folder the agent's file tools resolve from their context.
      const dir = getAgentWorkspaceDirFromContext(agent.toolContext, agent.workspace.agentId);
      expect(dir).toBe(path.join(folders.base, folderName));
      expect(path.dirname(dir)).toBe(folders.base);
    } finally {
      await agent.shutdown();
    }
  });
});
