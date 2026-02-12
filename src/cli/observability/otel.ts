/**
 * @fileoverview OpenTelemetry (OTEL) bootstrap for the Wunderland CLI.
 *
 * Design goals:
 * - Default OFF (avoid overhead + accidental export)
 * - Standard OTEL_* env vars control exporters/sampling (OTLP, etc)
 * - Keep tool args/prompt content out of telemetry by default
 *
 * Enable via:
 * - WUNDERLAND_OTEL_ENABLED=true (preferred), or
 * - OTEL_ENABLED=true (fallback for compatibility with other repo apps)
 */

function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return undefined;
}

export function isWunderlandOtelEnabled(): boolean {
  const explicit = parseBooleanEnv(process.env['WUNDERLAND_OTEL_ENABLED']);
  if (typeof explicit === 'boolean') return explicit;
  return parseBooleanEnv(process.env['OTEL_ENABLED']) === true;
}

export function shouldExportWunderlandOtelLogs(): boolean {
  return parseBooleanEnv(process.env['WUNDERLAND_OTEL_LOGS_ENABLED']) === true;
}

async function configureDiagLogger(): Promise<void> {
  // Keep OTEL internal logs quiet by default.
  const raw = (process.env['OTEL_DIAG_LOG_LEVEL'] ?? '').trim().toLowerCase();
  if (!raw) return;

  const { diag, DiagConsoleLogger, DiagLogLevel } = await import('@opentelemetry/api');

  const level =
    raw === 'debug'
      ? DiagLogLevel.DEBUG
      : raw === 'info'
        ? DiagLogLevel.INFO
        : raw === 'warn'
          ? DiagLogLevel.WARN
          : raw === 'error'
            ? DiagLogLevel.ERROR
            : raw === 'none'
              ? DiagLogLevel.NONE
              : null;
  if (level === null) return;

  diag.setLogger(new DiagConsoleLogger(), level);
}

let sdk: { start(): void | Promise<void>; shutdown(): Promise<void> } | null = null;

export async function shutdownWunderlandOtel(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error) {
    // Keep shutdown best-effort.
    // eslint-disable-next-line no-console
    console.warn('[wunderland][otel] shutdown failed', error);
  } finally {
    sdk = null;
  }
}

export async function startWunderlandOtel(opts?: { serviceName?: string }): Promise<void> {
  if (!isWunderlandOtelEnabled()) return;
  if (sdk) return;

  await configureDiagLogger();

  const serviceName = (opts?.serviceName ?? process.env['OTEL_SERVICE_NAME'] ?? 'wunderland-cli').trim();

  const [{ NodeSDK }, { getNodeAutoInstrumentations }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
  ]);

  sdk = new NodeSDK({
    serviceName,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Reduce default overhead/noise; enable more only when needed.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-aws-sdk': { enabled: false },
        '@opentelemetry/instrumentation-redis-4': { enabled: false },
      }),
    ],
  });

  await sdk.start();
}
