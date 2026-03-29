/**
 * @fileoverview Configuration and persona route handlers for the CLI HTTP server.
 * @module wunderland/cli/commands/start/routes/config
 *
 * Endpoints handled:
 *  - `GET  /api/agentos/personas`      — List all personas with selected persona info
 *  - `GET  /api/agentos/personas/:id`  — Get a single persona by ID
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CliServerDeps, RouteHandlerResult } from './types.js';

/** Serialize a value as JSON and send it with the given status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Attempt to handle persona/config-related routes.
 *
 * @returns `true` if the request was handled, `false` to fall through
 */
export function handleConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CliServerDeps,
): RouteHandlerResult {
  const { activePersonaId, seed, selectedPersona, availablePersonas } = deps;

  if (req.method === 'GET' && url.pathname === '/api/agentos/personas') {
    sendJson(res, 200, {
      selectedPersonaId: activePersonaId !== seed.seedId ? activePersonaId : undefined,
      selectedPersona: selectedPersona ?? undefined,
      personas: availablePersonas ?? [],
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/agentos/personas/')) {
    const personaId = decodeURIComponent(url.pathname.slice('/api/agentos/personas/'.length));
    const persona = Array.isArray(availablePersonas)
      ? availablePersonas.find((entry: any) => entry?.id === personaId)
      : undefined;
    if (!persona) {
      sendJson(res, 404, { error: `Persona '${personaId}' not found.` });
      return true;
    }
    sendJson(res, 200, { persona });
    return true;
  }

  return false;
}
