/**
 * @fileoverview Evaluation framework module for Wunderland.
 * Re-exports evaluation primitives from AgentOS.
 * @module wunderland/evaluation
 */

export type {
  MetricType,
  MetricValue,
  EvalTestCase,
  EvalCriteria,
  EvalTestResult,
  EvalRun,
  AggregateMetrics,
  EvalConfig,
  ScorerFunction,
  BuiltInScorer,
  IEvaluator,
  EvalComparison,
  LLMJudgeConfig,
  JudgeCriteria,
  JudgmentResult,
} from '@framers/agentos';

export {
  Evaluator,
  LLMJudge,
  CRITERIA_PRESETS,
} from '@framers/agentos';
