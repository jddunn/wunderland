// @ts-nocheck
/**
 * @fileoverview Tool execution API route handlers for the Wunderland API server.
 * @module wunderland/api/routes/agents
 *
 * Endpoints handled:
 *  - `GET  /api/tools`          — List all registered tools with schemas
 *  - `POST /api/tools/:name`    — Execute a specific tool by name with JSON arguments
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../server-helpers.js';
import type { ServerDeps, RouteHandlerResult } from './types.js';

/**
 * Attempt to handle tool/agent management routes.
 *
 * @param req  - Incoming HTTP request
 * @param res  - Server response
 * @param url  - Parsed request URL
 * @param deps - Shared server dependencies
 * @returns `true` if the request was handled, `false` to fall through
 */
export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): Promise<RouteHandlerResult> {
  const { toolMap, toolApiSecret, policy, activePersonaId } = deps;

  /* GET /api/tools — list all available tools */
  if (url.pathname === '/api/tools' && req.method === 'GET') {
    if (toolApiSecret && req.headers['x-api-key'] !== toolApiSecret) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const tools = Array.from(toolMap.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      category: t.category,
      hasSideEffects: t.hasSideEffects,
    }));
    sendJson(res, 200, { tools });
    return true;
  }

  /* POST /api/tools/:name — execute a tool */
  if (url.pathname.startsWith('/api/tools/') && req.method === 'POST') {
    if (toolApiSecret && req.headers['x-api-key'] !== toolApiSecret) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const toolName = decodeURIComponent(url.pathname.slice('/api/tools/'.length));
    const tool = toolMap.get(toolName);
    if (!tool) {
      sendJson(res, 404, { error: `Tool '${toolName}' not found` });
      return true;
    }
    let args: Record<string, unknown> = {};
    try {
      const body = await readBody(req);
      if (body) args = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    try {
      const ctx: Record<string, unknown> = {
        gmiId: 'tool-api',
        personaId: activePersonaId,
        permissionSet: policy.permissionSet,
        securityTier: policy.securityTier,
        executionMode: 'autonomous',
        toolAccessProfile: policy.toolAccessProfile,
        interactiveSession: false,
      };
      const result = await tool.execute(args, ctx);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : 'Tool execution failed',
      });
    }
    return true;
  }

  return false;
}
