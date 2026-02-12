import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildOtelEnvVars, describeObservabilityPreset } from './otel-config.js';
import { isWunderlandOtelEnabled, shouldExportWunderlandOtelLogs } from './otel.js';

const ENV_KEYS = [
  'WUNDERLAND_OTEL_ENABLED',
  'WUNDERLAND_OTEL_LOGS_ENABLED',
  'OTEL_ENABLED',
  'OTEL_TRACES_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
] as const;

describe('Wunderland OTEL config helpers', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  describe('buildOtelEnvVars', () => {
    it('returns explicit false values for preset=off', () => {
      expect(buildOtelEnvVars('off')).toEqual({
        WUNDERLAND_OTEL_ENABLED: 'false',
        WUNDERLAND_OTEL_LOGS_ENABLED: 'false',
      });
    });

    it('returns traces+metrics defaults for preset=otel_traces_metrics', () => {
      const env = buildOtelEnvVars('otel_traces_metrics');

      expect(env['WUNDERLAND_OTEL_ENABLED']).toBe('true');
      expect(env['WUNDERLAND_OTEL_LOGS_ENABLED']).toBe('false');
      expect(env['OTEL_TRACES_EXPORTER']).toBe('otlp');
      expect(env['OTEL_METRICS_EXPORTER']).toBe('otlp');
      expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://localhost:4318');
      expect(env['OTEL_EXPORTER_OTLP_PROTOCOL']).toBe('http/protobuf');
      expect(env['OTEL_TRACES_SAMPLER']).toBe('parentbased_traceidratio');
      expect(env['OTEL_TRACES_SAMPLER_ARG']).toBe('0.1');
      expect(env['OTEL_LOGS_EXPORTER']).toBeUndefined();
    });

    it('returns traces+metrics+logs defaults for preset=otel_traces_metrics_logs', () => {
      const env = buildOtelEnvVars('otel_traces_metrics_logs');

      expect(env['WUNDERLAND_OTEL_ENABLED']).toBe('true');
      expect(env['WUNDERLAND_OTEL_LOGS_ENABLED']).toBe('true');
      expect(env['OTEL_LOGS_EXPORTER']).toBe('otlp');
    });
  });

  describe('describeObservabilityPreset', () => {
    it('renders human-friendly labels', () => {
      expect(describeObservabilityPreset('off')).toBe('off');
      expect(describeObservabilityPreset('otel_traces_metrics')).toBe('OTEL traces + metrics');
      expect(describeObservabilityPreset('otel_traces_metrics_logs')).toBe('OTEL traces + metrics + logs');
    });
  });

  describe('env parsing', () => {
    it('prefers WUNDERLAND_OTEL_ENABLED over OTEL_ENABLED', () => {
      process.env['OTEL_ENABLED'] = 'true';
      process.env['WUNDERLAND_OTEL_ENABLED'] = 'false';
      expect(isWunderlandOtelEnabled()).toBe(false);

      process.env['WUNDERLAND_OTEL_ENABLED'] = 'true';
      expect(isWunderlandOtelEnabled()).toBe(true);
    });

    it('falls back to OTEL_ENABLED when WUNDERLAND_OTEL_ENABLED is unset', () => {
      process.env['OTEL_ENABLED'] = 'true';
      expect(isWunderlandOtelEnabled()).toBe(true);
      delete process.env['OTEL_ENABLED'];
      expect(isWunderlandOtelEnabled()).toBe(false);
    });

    it('enables log export only with WUNDERLAND_OTEL_LOGS_ENABLED=true', () => {
      expect(shouldExportWunderlandOtelLogs()).toBe(false);
      process.env['WUNDERLAND_OTEL_LOGS_ENABLED'] = 'true';
      expect(shouldExportWunderlandOtelLogs()).toBe(true);
    });
  });
});
