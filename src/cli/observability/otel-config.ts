import type { ObservabilityPreset } from '../types.js';

export function buildOtelEnvVars(preset: ObservabilityPreset): Record<string, string> {
  if (preset === 'off') {
    // Write explicit "false" so re-running `wunderland setup` can disable OTEL.
    return {
      WUNDERLAND_OTEL_ENABLED: 'false',
      WUNDERLAND_OTEL_LOGS_ENABLED: 'false',
    };
  }

  const base: Record<string, string> = {
    WUNDERLAND_OTEL_ENABLED: 'true',
    // Write explicit "false" so switching presets can reliably disable logs.
    WUNDERLAND_OTEL_LOGS_ENABLED: 'false',

    // Default to local OTLP/HTTP collector. Override in project .env if needed.
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',

    // Keep overhead manageable by default.
    OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
    OTEL_TRACES_SAMPLER_ARG: '0.1',
  };

  if (preset === 'otel_traces_metrics_logs') {
    return {
      ...base,
      WUNDERLAND_OTEL_LOGS_ENABLED: 'true',
      OTEL_LOGS_EXPORTER: 'otlp',
    };
  }

  return base;
}

export function describeObservabilityPreset(preset: ObservabilityPreset): string {
  if (preset === 'otel_traces_metrics_logs') return 'OTEL traces + metrics + logs';
  if (preset === 'otel_traces_metrics') return 'OTEL traces + metrics';
  return 'off';
}
