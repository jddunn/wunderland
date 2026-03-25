import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  resolveWunderlandTextLogConfig,
  WunderlandSessionTextLogger,
} from './session-text-log.js';

describe('Wunderland session text logs', () => {
  let workingDir: string | undefined;

  afterEach(async () => {
    if (workingDir) {
      await rm(workingDir, { recursive: true, force: true });
      workingDir = undefined;
    }
    delete process.env['WUNDERLAND_TEXT_LOGS_ENABLED'];
    delete process.env['AGENTOS_TEXT_LOGS_ENABLED'];
    delete process.env['WUNDERLAND_TEXT_LOGS_DIR'];
    delete process.env['AGENTOS_TEXT_LOGS_DIR'];
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
});
