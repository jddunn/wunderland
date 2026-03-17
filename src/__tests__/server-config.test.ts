import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';

import { createWunderlandServer } from '../api/server.js';

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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts Gemini with a direct apiKey override and uses the normalized OpenAI-compatible base URL', async () => {
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
      expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      expect(String(url)).not.toContain('//chat');
    } finally {
      await handle.close();
    }
  });
});
