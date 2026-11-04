// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  resolveWunderlandTextLogConfig,
  WunderlandSessionTextLogger,
} from './session-text-log.js';
import { InvalidAgentWorkspaceIdError } from '../../runtime/tools/workspace.js';

/** The environment settings that override where and whether text logs are written. */
const TEXT_LOG_ENV = [
  'WUNDERLAND_TEXT_LOGS_ENABLED',
  'AGENTOS_TEXT_LOGS_ENABLED',
  'WUNDERLAND_TEXT_LOGS_DIR',
  'AGENTOS_TEXT_LOGS_DIR',
];

describe('Wunderland session text logs', () => {
  let workingDir: string | undefined;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // One fixed date, so a case that crosses midnight still reads the dated
    // folder it wrote; and none of the text-log settings of the shell that
    // runs the tests.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    savedEnv = Object.fromEntries(TEXT_LOG_ENV.map((name) => [name, process.env[name]]));
    for (const name of TEXT_LOG_ENV) delete process.env[name];
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const name of TEXT_LOG_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    if (workingDir) {
      await rm(workingDir, { recursive: true, force: true });
      workingDir = undefined;
    }
  });

  it('enables dated per-session logs by default for config-backed agent runs', async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'wunderland-text-log-'));

    const config = resolveWunderlandTextLogConfig({
      agentConfig: { seedId: 'seed_logger' },
      workingDirectory: workingDir,
      workspace: { agentId: 'seed_logger', baseDir: workingDir },
      configBacked: true,
    });

    expect(config.enabled).toBe(true);
    expect(config.directory).toBe(path.join(workingDir, 'logs'));

    const logger = new WunderlandSessionTextLogger(config);
    await logger.logTurn({
      meta: { agentId: 'seed_logger', seedId: 'seed_logger', displayName: 'Logger', providerId: 'openai', model: 'gpt-test' },
      sessionId: 'session-1',
      userText: 'hello',
      reply: 'world',
      toolCallCount: 0,
    });

    const datedDir = path.join(workingDir, 'logs', new Date().toISOString().slice(0, 10));
    const logPath = path.join(datedDir, 'session-1.log');
    expect(existsSync(logPath)).toBe(true);

    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('SESSION_START');
    expect(content).toContain('USER');
    expect(content).toContain('ASSISTANT');
    expect(content).toContain('"content":"hello"');
    expect(content).toContain('"content":"world"');
  });

  it('supports explicit opt-out', async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'wunderland-text-log-disabled-'));

    const config = resolveWunderlandTextLogConfig({
      agentConfig: {
        seedId: 'seed_logger',
        observability: {
          textLogs: { enabled: false },
        },
      },
      workingDirectory: workingDir,
      configBacked: true,
    });

    expect(config.enabled).toBe(false);

    const logger = new WunderlandSessionTextLogger(config);
    await logger.logTurn({
      meta: { agentId: 'seed_logger' },
      sessionId: 'disabled-session',
      userText: 'hello',
      reply: 'world',
    });

    const datedDir = path.join(workingDir, 'logs', new Date().toISOString().slice(0, 10));
    expect(existsSync(datedDir)).toBe(false);
  });

  it("keeps an agent's logs in its folder under the workspace base and refuses an id that would leave it", async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'wunderland-text-log-workspace-'));
    const baseDir = path.join(workingDir, 'agents');

    const config = resolveWunderlandTextLogConfig({
      agentConfig: { observability: { textLogs: { enabled: true } } },
      workingDirectory: workingDir,
      workspace: { agentId: 'seed_logger', baseDir },
      defaultAgentId: 'seed_logger',
    });
    expect(config.directory).toBe(path.join(baseDir, 'seed_logger', 'logs'));

    await new WunderlandSessionTextLogger(config).logTurn({
      meta: { agentId: 'seed_logger' },
      sessionId: 'session-1',
      userText: 'hello',
    });
    const datedDir = path.join(baseDir, 'seed_logger', 'logs', new Date().toISOString().slice(0, 10));
    expect(existsSync(path.join(datedDir, 'session-1.log'))).toBe(true);

    // '..' would put the logs in <workingDir>/logs, beside the base; '.' in <base>/logs.
    for (const agentId of ['..', '.', '/..']) {
      expect(() =>
        resolveWunderlandTextLogConfig({
          workingDirectory: workingDir,
          workspace: { agentId, baseDir },
          defaultAgentId: agentId,
        }),
      ).toThrow(InvalidAgentWorkspaceIdError);
    }
  });

  it('names each session log file inside the dated folder, whatever the session id', async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'wunderland-text-log-session-ids-'));

    const config = resolveWunderlandTextLogConfig({
      agentConfig: { seedId: 'seed_logger' },
      workingDirectory: workingDir,
      configBacked: true,
    });
    const logger = new WunderlandSessionTextLogger(config);
    for (const sessionId of ['..', '../escape']) {
      await logger.logTurn({ meta: { agentId: 'seed_logger' }, sessionId, userText: 'hello' });
    }

    const logsDir = path.join(workingDir, 'logs');
    const datedDir = path.join(logsDir, new Date().toISOString().slice(0, 10));
    expect((await readdir(datedDir)).sort()).toEqual(['...log', '..-escape.log'].sort());
    expect((await readdir(logsDir)).sort()).toEqual([path.basename(datedDir)]);
    expect((await readdir(workingDir)).sort()).toEqual(['logs']);
  });
});
