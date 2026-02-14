# AgentOS Reference Server API

The `packages/agentos/src/server/AgentOSServer.ts` module ships with a minimal HTTP server that demonstrates how to wire the AgentOS runtime into a standalone service. It is intentionally lightweight—no Express, Socket.IO, or custom middleware—so that it can serve as a template for custom deployments or test harnesses.

The server exposes three endpoints:

| Method | Path                                | Description                                                                                                                    |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/health`                           | Basic liveness probe. Returns `{ "status": "ok" }` when the process is ready to accept requests.                               |
| `GET`  | `/api/agentos/personas?userId=<id>` | Returns the personas the current user can access. Useful for rendering selector UIs before initiating a chat session.          |
| `POST` | `/api/agentos/chat`                 | Accepts a minimal chat payload, forwards it through `AgentOS.processRequest`, and returns the streamed chunks as a JSON array. |

## Request/response examples

### GET `/health`

#### Response

```json
{
  "status": "ok",
  "service": "agentos-server"
}
```

### GET `/api/agentos/personas`

```http
GET /api/agentos/personas?userId=user-123
```

#### Response

```json
{
  "personas": [
    { "id": "coding-core", "name": "Coding Assistant", "isPublic": true },
    { "id": "diary-reflection", "name": "Reflection Partner", "minSubscriptionTier": "pro" }
  ]
}
```

### POST `/api/agentos/chat`

```http
POST /api/agentos/chat
Content-Type: application/json

{
  "userId": "user-123",
  "organizationId": "org-123",
  "sessionId": "session-1",
  "selectedPersonaId": "coding-core",
  "textInput": "Help me write a unit test for this function.",
  "memoryControl": {
    "longTermMemory": {
      "enabled": true,
      "scopes": { "conversation": true, "user": true }
    }
  }
}
```

#### Response

```json
{
  "chunks": [
    { "type": "system_progress", "message": "Persona coding-core ready.", "...": "..." },
    { "type": "text_delta", "textDelta": "Sure, let's start by..." },
    {
      "type": "final_response",
      "finalResponseText": "Here's a sample Vitest case you can adapt...",
      "finalResponseTextPlain": "Here's a sample Vitest case you can adapt...",
      "...": "..."
    }
  ]
}
```

## Modifying the template

- **Authentication:** the default server has no auth. Add your own checks before dispatching to AgentOS (for example, verify API keys or bearer tokens).
- **CORS:** enable/disable via `AgentOSServerConfig.enableCors` and `corsOrigin`.
- **Streaming:** the example buffers all chunks and returns them in one response. For real-time streaming, hook the async generator returned by `processRequest` to Server-Sent Events or WebSockets.
- **Secrets:** the `/api/agentos/stream` handler accepts an `apiKeys` query parameter (JSON string) so browsers can forward user-provided API keys via `AgentOSInput.userApiKeys`.
- **Additional routes:** extend the handler to surface conversations, feedback, or other AgentOS facade methods as needed.

Because the server avoids external dependencies, it can be deployed as-is for local testing or embedded in another Node.js app with minimal friction. Use it as a starting point before layering in features from the full Voice Chat Assistant backend (rate limiting, Supabase auth, billing, etc.).
