import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleWebhookRequest,
  resetWebhookRateLimiter,
  type WebhookDeps,
  type WebhookHookConfig,
} from '../webhooks.js';

interface FakeRes {
  statusCode: number;
  body: string;
  writeHead(code: number): FakeRes;
  end(payload?: string): void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: '',
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(payload?: string) {
      res.body = payload ?? '';
    },
  };
  return res;
}

const hooks: WebhookHookConfig[] = [
  { id: 'gh', secret: 's3cret', mode: 'notify' },
  { id: 'wake', secret: 'k3y', mode: 'turn' },
];

function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function makeReq(hookId: string, headers: Record<string, string>): IncomingMessage {
  return { method: 'POST', url: `/webhooks/${hookId}`, headers } as unknown as IncomingMessage;
}

function makeDeps(): WebhookDeps & { enqueueTurn: ReturnType<typeof vi.fn>; appendFeed: ReturnType<typeof vi.fn> } {
  return {
    hooks,
    enqueueTurn: vi.fn(async () => undefined),
    appendFeed: vi.fn(async () => undefined),
    now: () => Date.now(),
  };
}

const call = (req: IncomingMessage, res: FakeRes, body: string, deps: WebhookDeps) =>
  handleWebhookRequest(req, res as unknown as ServerResponse, body, deps);

describe('handleWebhookRequest', () => {
  beforeEach(() => resetWebhookRateLimiter());

  it('valid HMAC signature on a notify hook broadcasts and returns 202', async () => {
    const deps = makeDeps();
    const timestamp = String(Date.now());
    const body = JSON.stringify({ hello: 1 });
    const res = makeRes();

    const handled = await call(
      makeReq('gh', {
        'x-wunderland-timestamp': timestamp,
        'x-wunderland-signature': sign('s3cret', timestamp, body),
      }),
      res,
      body,
      deps,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(deps.appendFeed).toHaveBeenCalledOnce();
    expect(deps.enqueueTurn).not.toHaveBeenCalled();
  });

  it('bearer secret works and turn mode wakes a turn', async () => {
    const deps = makeDeps();
    const body = '{"x":1}';
    const res = makeRes();

    await call(makeReq('wake', { authorization: 'Bearer k3y' }), res, body, deps);

    expect(res.statusCode).toBe(202);
    expect(deps.enqueueTurn).toHaveBeenCalledWith('wake', body);
  });

  it('bad signature returns a generic 404 (unprobeable)', async () => {
    const deps = makeDeps();
    const timestamp = String(Date.now());
    const res = makeRes();

    await call(
      makeReq('gh', { 'x-wunderland-timestamp': timestamp, 'x-wunderland-signature': 'deadbeef' }),
      res,
      '{}',
      deps,
    );

    expect(res.statusCode).toBe(404);
    expect(deps.appendFeed).not.toHaveBeenCalled();
  });

  it('expired timestamp (>5 min) is rejected', async () => {
    const deps = makeDeps();
    const timestamp = String(Date.now() - 6 * 60 * 1000);
    const body = '{}';
    const res = makeRes();

    await call(
      makeReq('gh', {
        'x-wunderland-timestamp': timestamp,
        'x-wunderland-signature': sign('s3cret', timestamp, body),
      }),
      res,
      body,
      deps,
    );

    expect(res.statusCode).toBe(404);
  });

  it('unknown hook id is a generic 404; non-webhook paths are not claimed', async () => {
    const deps = makeDeps();
    const res = makeRes();

    expect(await call(makeReq('nope', {}), res, '{}', deps)).toBe(true);
    expect(res.statusCode).toBe(404);

    const passthrough = makeRes();
    const handled = await call(
      { method: 'GET', url: '/health', headers: {} } as unknown as IncomingMessage,
      passthrough,
      '',
      deps,
    );
    expect(handled).toBe(false);
    expect(passthrough.statusCode).toBe(0);
  });

  it('oversized bodies are rejected with 413 before any side effect', async () => {
    const deps = makeDeps();
    const res = makeRes();
    const body = 'x'.repeat(64 * 1024 + 1);

    await call(makeReq('wake', { authorization: 'Bearer k3y' }), res, body, deps);

    expect(res.statusCode).toBe(413);
    expect(deps.enqueueTurn).not.toHaveBeenCalled();
  });

  it('rate limit trips after 60 hits in a minute', async () => {
    const deps = makeDeps();
    const body = '{"x":1}';

    for (let i = 0; i < 60; i++) {
      await call(makeReq('wake', { authorization: 'Bearer k3y' }), makeRes(), body, deps);
    }
    const res = makeRes();
    await call(makeReq('wake', { authorization: 'Bearer k3y' }), res, body, deps);

    expect(res.statusCode).toBe(429);
    expect(deps.enqueueTurn).toHaveBeenCalledTimes(60);
  });
});
