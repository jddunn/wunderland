// @ts-nocheck
/**
 * @fileoverview Configuration and persona route handlers for the Wunderland API server.
 * @module wunderland/api/routes/config
 *
 * Endpoints handled:
 *  - `GET  /api/agentos/personas`      — List all personas with selected persona info
 *  - `GET  /api/agentos/personas/:id`  — Get a single persona by ID
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../server-helpers.js';
import type { ServerDeps, RouteHandlerResult } from './types.js';

/**
 * Attempt to handle persona/config-related routes.
 *
 * @param req  - Incoming HTTP request
 * @param res  - Server response
 * @param url  - Parsed request URL
 * @param deps - Shared server dependencies
 * @returns `true` if the request was handled, `false` to fall through
 */
export function handleConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): RouteHandlerResult {
  const { activePersonaId, seedId, selectedPersona, availablePersonas } = deps;

  if (req.method === 'GET' && url.pathname === '/api/agentos/personas') {
    sendJson(res, 200, {
      selectedPersonaId: activePersonaId !== seedId ? activePersonaId : undefined,
      selectedPersona: selectedPersona ?? undefined,
      personas: availablePersonas ?? [],
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/agentos/personas/')) {
    const personaId = decodeURIComponent(url.pathname.slice('/api/agentos/personas/'.length));
    const persona = Array.isArray(availablePersonas)
      ? availablePersonas.find((entry) => entry.id === personaId)
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
