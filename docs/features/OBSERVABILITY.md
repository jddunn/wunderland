# Observability (OpenTelemetry)

This repo supports opt-in OpenTelemetry (OTEL) tracing end-to-end:

- Backend: NodeSDK bootstrap + auto-instrumentation (HTTP, fetch, etc).
- AgentOS: manual spans around agent turns and tool-result handling (no prompt/tool-args collection by default).
- AgentOS: optional metrics (turn/tool counters + histograms).
- Optional: trace IDs in streamed chunks and log correlation (`trace_id`, `span_id`).

Default is OFF to avoid accidental data export and overhead.

## Opt-In Switches

There are two layers:

1. **Backend OTEL SDK (export + auto-instrumentation)**
   - Env: `OTEL_ENABLED=true`
   - File: `backend/src/observability/otel.ts`

2. **AgentOS manual spans + correlation helpers**
   - Env: `AGENTOS_OBSERVABILITY_ENABLED=true` (enables tracing + log correlation)
   - Or config: `AgentOSConfig.observability` (recommended for per-instance control)
   - Files:
     - `packages/agentos/src/core/observability/otel.ts`
     - `packages/agentos/src/api/runtime/AgentOSOrchestrator.ts`

### Precedence

- `AgentOSConfig.observability.enabled=false` hard-disables all AgentOS observability helpers (even if env vars are set).
- Otherwise, config fields override env fields, and env provides defaults.

## Backend: Enable OTEL SDK

Set env (example local OTLP/HTTP collector):

```bash
OTEL_ENABLED=true
OTEL_SERVICE_NAME=voice-chat-assistant-backend

OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
# OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Optional sampling
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

Notes:

- OTEL must start before most imports to make auto-instrumentation effective. The backend entrypoint calls `startOtel()` at the very top: `backend/src/main.ts`.
- Keep `OTEL_DIAG_LOG_LEVEL` unset in production unless debugging (`debug|info|warn|error|none`).
- To disable metrics or logs while keeping traces, set `OTEL_METRICS_EXPORTER=none` and/or `OTEL_LOGS_EXPORTER=none`.

## AgentOS: Enable Manual Spans

### Via `.env`

```bash
AGENTOS_OBSERVABILITY_ENABLED=true

# Optional toggles
# AGENTOS_METRICS_ENABLED=true
AGENTOS_TRACE_IDS_IN_RESPONSES=true
AGENTOS_LOG_TRACE_IDS=true
# AGENTOS_OTEL_LOGS_ENABLED=true
AGENTOS_OTEL_TRACER_NAME=@framers/agentos
AGENTOS_OTEL_METER_NAME=@framers/agentos
# AGENTOS_OTEL_LOGGER_NAME=@framers/agentos
```

### Via AgentOS Config (per instance)

```ts
import { AgentOS } from '@framers/agentos';

const agentos = new AgentOS();
await agentos.initialize({
  // ...existing required config...
  observability: {
    metrics: { enabled: true },
    tracing: { enabled: true, includeTraceInResponses: true },
    logging: { includeTraceIds: true, exportToOtel: true },
  },
});
```

## What AgentOS Emits (Spans)

When enabled, AgentOS emits spans like:

- `agentos.turn`
- `agentos.gmi.get_or_create`
- `agentos.gmi.process_turn_stream`
- `agentos.tool_result`
- `agentos.gmi.handle_tool_result`
- `agentos.conversation.save` (stage-tagged)

Sensitive content policy:

- Prompts, model outputs, and tool arguments are not attached to spans by default.
- Prefer adding high-level attributes only (ids, durations, success booleans, model id/provider id, token usage, cost), and keep content capture behind explicit, separate opt-in.

## Trace IDs in Streamed Chunks

When `includeTraceInResponses` (or `AGENTOS_TRACE_IDS_IN_RESPONSES=true`) is enabled, AgentOS attaches:

```json
{
  "metadata": {
    "trace": {
      "traceId": "...",
      "spanId": "...",
      "traceparent": "00-...-...-01"
    }
  }
}
```

to selected chunk types (metadata updates, final responses, errors). See `packages/agentos/src/api/runtime/AgentOSOrchestrator.ts`.

## Logging (Pino) + OTEL Logs (Optional)

### Backend Logger

The backend uses `pino` for structured logs:

- File: `backend/utils/logger.ts`
- Level: `LOG_LEVEL=debug|info|warn|error` (default: `info`)

When `OTEL_ENABLED=true`, backend logs will include `trace_id` and `span_id` fields when an active span exists.

### AgentOS Logger

When enabled, `packages/agentos/src/logging/PinoLogger.ts` adds `trace_id` and `span_id` to log metadata when an active span exists (opt-in via `AGENTOS_LOG_TRACE_IDS=true` or `AgentOSConfig.observability.logging.includeTraceIds=true`).

AgentOS can also emit OpenTelemetry LogRecords (opt-in via `AGENTOS_OTEL_LOGS_ENABLED=true` or `AgentOSConfig.observability.logging.exportToOtel=true`). This requires the host SDK to export logs (for NodeSDK: `OTEL_LOGS_EXPORTER=otlp`).

### Export Logs via OpenTelemetry (OTLP)

By default, logs go to stdout (pino JSON). If you want _OTEL LogRecords_ exported over OTLP:

```bash
OTEL_ENABLED=true
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Implementation note: backend log export uses the OpenTelemetry Logs API (`@opentelemetry/api-logs`) and emits LogRecords only when `OTEL_LOGS_EXPORTER` is explicitly set (to avoid accidental export).

AgentOS log correlation does not start OTEL by itself; the host app still needs an SDK provider (NodeSDK in the backend) to create/propagate context and export telemetry.

### Pros / Cons (Recommended Default)

Recommended default:

- Keep `OTEL_LOGS_EXPORTER` unset (stdout logs only).
- Turn on OTEL traces/metrics when you need them, and keep sampling on.
- Turn on OTEL log export only when you specifically want a single OTLP pipeline for logs.

Tradeoffs:

- OTEL log export pros: unified pipeline (traces/metrics/logs) and native correlation in OTEL backends; consistent transport (OTLP) to your collector/vendor.
- OTEL log export cons: extra CPU/network overhead; potential double-ingest if you also ship stdout logs; higher data volume (especially at `debug`).

## Performance Guidance

- Keep OTEL off by default in dev unless actively debugging.
- Use sampling (`parentbased_traceidratio`) and collector-side tail sampling if you need high-volume traces.
- Avoid capturing prompts/tool args by default; export only safe metadata and aggregate metrics.

## AgentOS Metrics (Counters + Histograms)

When enabled, AgentOS records basic metrics via `@opentelemetry/api` meters:

- `agentos.turns` (counter)
- `agentos.turn.duration_ms` (histogram)
- `agentos.turn.tokens.*` and `agentos.turn.cost.usd` (histograms; only when usage/cost is available)
- `agentos.tool_results` (counter)
- `agentos.tool_result.duration_ms` (histogram)

Cardinality guidance:

- Avoid high-cardinality attributes (conversation ids, user ids, tool args, prompt text).
- Keep labels stable and low-cardinality (e.g., `status`, `persona_id`, `tool_name`).

## SOTA Notes (2026)

- Follow OTEL GenAI semantic conventions when you start instrumenting model calls and tools (`gen_ai.*`), but treat them as moving targets until they stabilize. Many vendors/tools support mapping these attributes into their own trace UIs.
- Prefer OTEL-native log correlation for Node (for example, `@opentelemetry/instrumentation-pino`) if you want consistent `trace_id`/`span_id` injection across the whole backend.
- For LLM/agent-specific trace UIs (beyond raw OTEL), the common approach is: emit OTEL spans and export to an OTLP backend that understands LLM concepts (token usage, cost, prompt linking, redaction/masking, evaluations).

Common tools in this space (pick one, do not run all at once):

- OTEL backends: Grafana Tempo, Jaeger, Honeycomb, Datadog, New Relic, SigNoz.
- LLM/agent observability: Langfuse (OTLP ingest + UI), Helicone (gateway/proxy + telemetry), Sentry (AI monitoring), OpenLIT, OpenLLMetry-js.

## Wunderland CLI (Optional)

The `wunderland` CLI also supports opt-in OTEL export (traces/metrics + optional OTEL LogRecords):

- Env (global or project `.env`):

```bash
WUNDERLAND_OTEL_ENABLED=true
# Optional:
WUNDERLAND_OTEL_LOGS_ENABLED=true
```

- Per-agent override (in `agent.config.json`):

```json
{
  "observability": {
    "otel": { "enabled": true, "exportLogs": false }
  }
}
```

Code:

- OTEL config: `packages/wunderland/src/cli/observability/otel-config.ts`
- OTEL bootstrap: `packages/wunderland/src/observability/` (runtime-level)
- LLM/tool spans: `packages/wunderland/src/runtime/tool-calling.ts`

## Hosted events

```bash
export WUNDERLAND_EVENTS_URL=https://control.example.com/agent
export WUNDERLAND_EVENTS_TOKEN=<the agent's token>
export AGENTOS_OPERATION_ID_HEADER=x-operation-id   # optional
wunderland start
```

```http
POST /agent/events
Authorization: Bearer <the agent's token>
x-operation-id: 0b7c1f4e-5a0e-4d2b-9a55-1f2f3c6f7a10
Content-Type: application/json

{ "events": [
  { "kind": "turn_started", "at": 1793836800000 },
  { "kind": "tool_called", "toolName": "web_search", "at": 1793836801200 },
  { "kind": "turn_finished", "promptTokens": 1204, "completionTokens": 88, "at": 1793836803500 }
] }
```

With both variables set, `wunderland start` posts the coarse events of what the agent does to `<WUNDERLAND_EVENTS_URL>/events`, so a control plane that runs the agent can see it working. Names, counts, codes and times go out; message text, tool arguments, tool output and provider error messages never do. With either variable unset or blank, no reporter exists and nothing is posted. A `WUNDERLAND_EVENTS_URL` that does not parse makes no reporter and writes one warning line.

| Kind | When | Fields beside `kind` and `at` |
|------|------|-------------------------------|
| `turn_started` | A turn begins: a channel message, a `POST /chat`, or a webhook's `mode: "turn"` wake | none |
| `tool_called` | The model called a tool the agent has, before that call's approval | `toolName` |
| `approval_requested` | The turn waits on a person: a tool's approval or a turn checkpoint | none |
| `provider_error` | A provider request failed, including a primary that then falls back | `code`: the HTTP status, as a string; none when the request got no answer |
| `turn_finished` | The turn ended, however it ended | `promptTokens`, `completionTokens`: the turn's totals across its rounds |
| `channel_auth_failed` | A channel adapter emitted an `error` event whose data has `code: "auth_failed"`: the platform rejected its token. A pack that emits no such event reports nothing. It belongs to no turn | `code`: the platform |
| `referral_sent` | The reporter's kind for a guardrail pack that counts the referrals it sends; `start` itself sends none | none |

`at` is milliseconds since the epoch. `count`, when set, says how many times the event happened; `start`'s own events leave it out, so a server counts one. A field that does not hold what it should is left out: `code`, `toolName` and the operation id go out only as a single word (letters, digits and `_ . : -`), so a caller that passes text by mistake loses the field rather than posting the text.

- **Batching.** A post goes out every 5 seconds while events wait, with at most 200 events. Each turn's events go in their own post, with a new UUID in the header `AGENTOS_OPERATION_ID_HEADER` names. With that variable unset, no header is sent; an event outside a turn sends none either.
- **The queue.** The reporter holds 1,000 events and drops the oldest past that.
- **Failures.** A post that gets no answer within 10 seconds, a 429 or a 5xx keeps its batch for the next try. Any other refusal drops the batch. The reason goes to `console.warn`, one line a minute at most, never with the token.
- **Shutdown.** On SIGINT or SIGTERM, `start` posts what waits before the rest of its teardown and waits up to 2 seconds for the answer.

Code: `src/cli/commands/start/hosted-events.ts`.
