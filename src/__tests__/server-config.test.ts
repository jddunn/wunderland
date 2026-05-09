// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createWunderlandServer } from '../channels/api/server.js';

type JsonResponse = {
  statusCode: number;
  body: string;
};

async function postJson(port: number, path: string, payload: unknown): Promise<JsonResponse> {
  const body = JSON.stringify(payload);

  return await new Promise<JsonResponse>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: data,
          });
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('createWunderlandServer', () => {
  let workingDirectory: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (workingDirectory) {
      await rm(workingDirectory, { recursive: true, force: true });
      workingDirectory = undefined;
    }
  });

  it('accepts Gemini with a direct apiKey override and uses the normalized OpenAI-compatible base URL', async () => {
    workingDirectory = await mkdtemp(path.join(tmpdir(), 'wunderland-server-logs-'));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: 'gemini-2.0-flash',
        usage: {},
        choices: [{ message: { role: 'assistant', content: 'hello from gemini' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    const handle = await createWunderlandServer({
      loadEnv: false,
      workingDirectory,
      host: '127.0.0.1',
      port: 0,
      lazyTools: true,
      llm: {
        providerId: 'gemini',
        apiKey: 'gemini-direct-key',
        model: 'gemini-2.0-flash',
      },
      agentConfig: {
        seedId: 'gemini_server_test',
        discovery: { enabled: false },
      } as any,
      taskOutcomeTelemetry: { enabled: false },
      adaptiveExecution: { enabled: false },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    try {
      expect(handle.providerId).toBe('gemini');
      expect(handle.canUseLLM).toBe(true);

      const response = await postJson(handle.port, '/chat', { message: 'hello' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ reply: 'hello from gemini' });

      expect(fetchMock).toHaveBeenCalled();
      const [url] = fetchMock.mock.calls[0];
      const normalizedUrl = new URL(String(url));
      expect(normalizedUrl.origin + normalizedUrl.pathname).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      );
      expect(normalizedUrl.searchParams.get('key')).toBe('gemini-direct-key');
      expect(String(url)).not.toContain('//chat');

      const logPath = path.join(
        workingDirectory,
        'logs',
        new Date().toISOString().slice(0, 10),
        'default.log',
      );
      expect(existsSync(logPath)).toBe(true);
      const logText = await readFile(logPath, 'utf8');
      expect(logText).toContain('USER');
      expect(logText).toContain('ASSISTANT');
      expect(logText).toContain('hello');
      expect(logText).toContain('hello from gemini');
    } finally {
      await handle.close();
    }
  });
});
