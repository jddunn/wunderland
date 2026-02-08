/**
 * @fileoverview Workflow engine module for Wunderland.
 * Re-exports workflow primitives from AgentOS.
 * @module wunderland/workflows
 */

export type {
  IWorkflowEngine,
  IWorkflowStore,
} from '@framers/agentos';

export {
  WorkflowEngine,
  InMemoryWorkflowStore,
} from '@framers/agentos';
