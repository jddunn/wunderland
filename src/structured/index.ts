/**
 * @fileoverview Structured outputs module for Wunderland.
 * Re-exports structured output primitives from AgentOS.
 * @module wunderland/structured
 */

export type {
  IStructuredOutputManager,
  JSONSchema,
  JSONSchemaType,
  StructuredOutputStrategy,
  StructuredGenerationOptions,
  StructuredGenerationResult,
  ParallelFunctionCallOptions,
  ParallelFunctionCallResult,
  FunctionDefinition,
  FunctionCallResult,
  EntityExtractionOptions,
  EntityExtractionResult,
  ValidationIssue,
  StructuredOutputStats,
} from '@framers/agentos';

export {
  StructuredOutputManager,
  StructuredOutputError,
} from '@framers/agentos';
