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
     - `packages/agentos/src/api/AgentOSOrchestrator.ts`

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

to selected chunk types (metadata updates, final responses, errors). See `packages/agentos/src/api/AgentOSOrchestrator.ts`.

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

- OTEL bootstrap: `packages/wunderland/src/cli/observability/otel.ts`
- LLM/tool spans: `packages/wunderland/src/cli/openai/tool-calling.ts`
