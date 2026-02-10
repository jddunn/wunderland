# Observability (OpenTelemetry)

Wunderland supports **opt-in** OpenTelemetry (OTEL) for:

- Traces and metrics (via the standard OTEL Node SDK)
- Optional OTEL LogRecord export (via OTLP, when explicitly enabled)

Defaults are conservative:

- OTEL is **OFF** unless you enable it
- Prompt content, model outputs, and tool arguments are **not** exported by Wunderland telemetry helpers by default

## Enable OTEL

### Option A: `wunderland setup` (recommended)

Run the setup wizard and choose an Observability preset:

```bash
wunderland setup
```

This writes OTEL-related keys into your global Wunderland env file (typically `~/.wunderland/.env`) so `wunderland chat` and `wunderland start` can pick them up automatically.

### Option B: `.env` (project-local)

In your agent project’s `.env`:

```bash
WUNDERLAND_OTEL_ENABLED=true

# Optional: enable OTEL LogRecord emission (off by default)
WUNDERLAND_OTEL_LOGS_ENABLED=true

# Standard OTEL exporters and endpoints (example: local OTLP/HTTP collector)
OTEL_SERVICE_NAME=my-wunderbot
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
# OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Sampling (recommended)
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

Notes:

- Wunderland uses `WUNDERLAND_OTEL_ENABLED` (preferred). If unset, it falls back to `OTEL_ENABLED=true`.
- Exporting logs over OTLP requires a logs exporter (for example `OTEL_LOGS_EXPORTER=otlp`) and can increase volume.

### Option C: `agent.config.json` (per-agent override)

When you scaffold with `wunderland init`, the generated `agent.config.json` includes:

```json
{
  "observability": {
    "otel": { "enabled": false, "exportLogs": false }
  }
}
```

When present:

- `wunderland start` will set `WUNDERLAND_OTEL_ENABLED` / `WUNDERLAND_OTEL_LOGS_ENABLED` from this config (overriding env)
- `wunderland chat` will do the same when run from a directory containing `agent.config.json`

## What Wunderland Emits

When enabled, the CLI emits spans such as:

- `wunderland.turn`
- `wunderland.llm.chat_completions` (safe metadata only: provider/model id, tool count, token usage when available)
- `wunderland.tool.execute` (safe metadata only: tool name/category, duration, success/error)

Optional OTEL LogRecords (when `WUNDERLAND_OTEL_LOGS_ENABLED=true`) are emitted for tool execution events, without including tool args/output.

## Local Collector (Docker)

If you don’t already have an OTLP endpoint, a local OpenTelemetry Collector is the usual starting point.
Point your agent at `http://localhost:4318` (OTLP/HTTP) and then route to your backend of choice (Jaeger, Tempo, Honeycomb, Datadog, etc).

## Performance Guidance

- Keep OTEL **off** by default unless you need auditing/production debugging.
- Prefer sampling (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`) for high-volume workloads.
- Enable OTEL log export only when you want a unified OTLP pipeline for logs (otherwise ship stdout logs separately).
