import { describe, expect, it } from 'vitest';
import { WunderlandAdaptiveExecutionRuntime } from '../adaptive-execution.js';

describe('WunderlandAdaptiveExecutionRuntime', () => {
  it('forces fail-open and full-tool exposure when KPI is degraded', async () => {
    const runtime = new WunderlandAdaptiveExecutionRuntime({
      toolFailureMode: 'fail_closed',
      taskOutcomeTelemetry: {
        enabled: true,
        persist: false,
        scope: 'session',
        rollingWindowSize: 10,
      },
      adaptiveExecution: {
        enabled: true,
        minSamples: 2,
        minWeightedSuccessRate: 0.8,
        forceAllToolsWhenDegraded: true,
        forceFailOpenWhenDegraded: true,
      },
    });

    await runtime.recordTurnOutcome({
      scope: { sessionId: 's-1', personaId: 'p-1' },
      degraded: false,
      replyText: '',
      didFail: true,
      toolCallCount: 1,
    });
    await runtime.recordTurnOutcome({
      scope: { sessionId: 's-1', personaId: 'p-1' },
      degraded: false,
      replyText: '',
      didFail: true,
      toolCallCount: 1,
    });

    const decision = runtime.resolveTurnDecision({
      scope: { sessionId: 's-1', personaId: 'p-1' },
    });

    expect(decision.degraded).toBe(true);
    expect(decision.toolFailureMode).toBe('fail_open');
    expect(decision.actions?.forcedToolFailureMode).toBe(true);
    expect(decision.actions?.forcedToolSelectionMode).toBe(true);
  });

  it('preserves explicit per-request fail_closed override when degraded', async () => {
    const runtime = new WunderlandAdaptiveExecutionRuntime({
      toolFailureMode: 'fail_open',
      taskOutcomeTelemetry: {
        enabled: true,
        persist: false,
        scope: 'session',
        rollingWindowSize: 10,
      },
      adaptiveExecution: {
        enabled: true,
        minSamples: 1,
        minWeightedSuccessRate: 0.99,
        forceAllToolsWhenDegraded: true,
        forceFailOpenWhenDegraded: true,
      },
    });

    await runtime.recordTurnOutcome({
      scope: { sessionId: 's-2', personaId: 'p-1' },
      degraded: false,
      replyText: '',
      didFail: true,
      toolCallCount: 1,
    });

    const decision = runtime.resolveTurnDecision({
      scope: { sessionId: 's-2', personaId: 'p-1' },
      requestedToolFailureMode: 'fail_closed',
    });

    expect(decision.degraded).toBe(true);
    expect(decision.toolFailureMode).toBe('fail_closed');
    expect(decision.actions?.preservedRequestedFailClosed).toBe(true);
  });
});
