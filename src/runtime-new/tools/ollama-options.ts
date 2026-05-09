// @ts-nocheck
export type OllamaRuntimeConfig = {
  numCtx?: number;
  numGpu?: number;
};

export function buildOllamaRuntimeOptions(
  config?: OllamaRuntimeConfig,
): Record<string, unknown> | undefined {
  if (!config) return undefined;

  const options: Record<string, unknown> = {};
  if (typeof config.numCtx === 'number' && Number.isFinite(config.numCtx) && config.numCtx > 0) {
    options['num_ctx'] = config.numCtx;
  }
  if (typeof config.numGpu === 'number' && Number.isFinite(config.numGpu)) {
    options['num_gpu'] = config.numGpu;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}
