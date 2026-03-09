import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import type { WunderlandAgentConfig } from '../api/types.js';
import { normalizeRagApiBaseUrl } from './rag-client.js';

type LoggerLike = {
  warn?: (msg: string, meta?: unknown) => void;
};

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function resolveAuthToken(config?: WunderlandAgentConfig): string | undefined {
  if (hasText(config?.rag?.authToken)) return config.rag.authToken.trim();
  if (hasText(config?.rag?.authTokenEnvVar)) {
    const fromEnv = process.env[config.rag.authTokenEnvVar.trim()];
    if (hasText(fromEnv)) return fromEnv.trim();
  }
  return undefined;
}

export function isAgentosRagProxyPath(pathname: string): boolean {
  return pathname === '/api/agentos/rag' || pathname.startsWith('/api/agentos/rag/');
}

export function resolveRagProxyBaseUrl(config?: WunderlandAgentConfig): string | null {
  const base =
    config?.rag?.backendUrl
    ?? process.env['WUNDERLAND_BACKEND_URL']
    ?? process.env['NEXT_PUBLIC_API_URL']
    ?? 'http://localhost:3001';

  return hasText(base) ? normalizeRagApiBaseUrl(base.trim()) : null;
}

function copyRequestHeaders(req: IncomingMessage, authToken?: string): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
      continue;
    }
    headers.set(key, value);
  }

  if (authToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${authToken}`);
  }

  return headers;
}

function copyResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'connection' || lower === 'transfer-encoding') return;
    headers[key] = value;
  });
  return headers;
}

function isProxyLoop(url: URL, upstreamBaseUrl: string): boolean {
  try {
    const upstream = new URL(upstreamBaseUrl);
    return upstream.origin === url.origin && upstream.pathname.replace(/\/+$/, '') === '/api/agentos/rag';
  } catch {
    return false;
  }
}

export async function maybeProxyAgentosRagRequest(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  agentConfig?: WunderlandAgentConfig;
  logger?: LoggerLike;
}): Promise<boolean> {
  const { req, res, url, agentConfig, logger } = opts;
  if (!isAgentosRagProxyPath(url.pathname)) return false;

  const upstreamBaseUrl = resolveRagProxyBaseUrl(agentConfig);
  if (!upstreamBaseUrl) {
    sendJson(res, 503, {
      error: 'RAG backend is not configured.',
      hint: 'Set rag.backendUrl or WUNDERLAND_BACKEND_URL.',
    });
    return true;
  }

  if (isProxyLoop(url, upstreamBaseUrl)) {
    sendJson(res, 508, {
      error: 'RAG proxy loop detected.',
      hint: 'Point rag.backendUrl or WUNDERLAND_BACKEND_URL at the real backend, not this local proxy server.',
    });
    return true;
  }

  const upstreamUrl = `${upstreamBaseUrl}${url.pathname.slice('/api/agentos/rag'.length)}${url.search}`;
  const method = (req.method || 'GET').toUpperCase();
  const headers = copyRequestHeaders(req, resolveAuthToken(agentConfig));

  try {
    const response = await fetch(upstreamUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (req as any),
      duplex: method === 'GET' || method === 'HEAD' ? undefined : 'half',
    } as RequestInit & { duplex?: 'half' });

    res.writeHead(response.status, copyResponseHeaders(response));

    if (!response.body) {
      res.end();
      return true;
    }

    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(response.body as any).pipe(res);
      res.on('finish', resolve);
      res.on('error', reject);
    });
    return true;
  } catch (error) {
    logger?.warn?.('[wunderland] failed to proxy AgentOS RAG request', {
      upstreamUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 502, {
      error: 'Failed to reach upstream RAG backend.',
      upstreamUrl,
    });
    return true;
  }
}
