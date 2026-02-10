# GMI Integration Guide

## Overview

The job execution system in `packages/wunderland/src/jobs/` currently uses mock execution. This guide outlines how to wire the system to real GMI (General Machine Intelligence) agent execution.

## Current State

### JobExecutor Mock Implementation
- `JobExecutor` has an `executeJob` callback in its config
- If no callback provided, uses `mockExecuteJob()` which generates:
  - Code deliverables for `development` category
  - Report deliverables for `research` category
  - Generic report for other categories
- `QualityChecker` validates deliverables before submission
- `DeliverableManager` stores and submits to Solana

## Integration Points

### 1. ExecuteJobCallback Hook

The main integration point is the `ExecuteJobCallback` type:

```typescript
type ExecuteJobCallback = (
  agentId: string,
  job: AssignedJob,
  prompt: string,
) => Promise<Deliverable>;
```

### 2. Job Prompt Generation

`JobExecutor.buildJobPrompt()` already generates comprehensive prompts including:
- Job title, description, budget, category
- Deadline if set
- Confidential details (API keys, credentials, instructions)
- Output format instructions (`<DELIVERABLE>` tags)

### 3. Deliverable Output Format

The callback must return:

```typescript
interface Deliverable {
  type: 'code' | 'report' | 'data' | 'url' | 'ipfs';
  content: string;
  mimeType?: string;
}
```

## TODO Items

### P0: Basic Execution

- [ ] **Spawn GMI Agent**
  - Use `OrchestrationService` or `GMIManager` to create agent session
  - Pass job execution prompt
  - Set appropriate tools (web_search, code_interpreter, cli_executor)
  - Set timeout (5 minutes default)

- [ ] **Basic Text Output**
  - Return entire agent output as a single deliverable
  - Default to `type: 'report'` for simplicity
  - Log execution time and basic metrics

### P1: Structured Deliverables

- [ ] **Parse Deliverables from Output**
  - Implement `extractDeliverables()` to parse `<DELIVERABLE type="...">...</DELIVERABLE>` tags
  - Handle multiple deliverables per job
  - Fall back to treating entire output as a single report if no tags found

- [ ] **Deliverable Type Detection**
  - Auto-detect type from content (code vs text vs data)
  - Set appropriate MIME types
  - Validate deliverable structure

### P2: Confidential Data Handling

- [ ] **Inject Confidential API Keys**
  - Implement `parseConfidentialApiKeys()` to extract keys from job metadata
  - Securely inject API keys into agent tool configuration
  - Strip keys from logs/output

- [ ] **Secure Credential Management**
  - Never log or persist API keys
  - Clear credentials from memory after execution
  - Encrypt credentials in transit

### P3: Advanced Features

- [ ] **Tool Configuration by Category**
  - `development`: code_interpreter, cli_executor, file_writer
  - `research`: web_search, code_interpreter
  - `data`: code_interpreter, data_analyzer
  - `general`: web_search, code_interpreter

- [ ] **Streaming Progress**
  - Wire `processTurnStream()` for real-time execution feedback
  - Log tool usage for debugging
  - Track token usage for cost accounting

- [ ] **Progress Updates**
  - Emit progress events during execution
  - Update job status in database
  - Show real-time progress in UI

### P4: Production Hardening

- [ ] **Error Handling**
  - Timeout handling (kill agent after max time)
  - OOM (out of memory) handling
  - Tool failure recovery
  - Rate limit handling for external APIs

- [ ] **Retry Logic**
  - Retry on transient failures (network, rate limits)
  - Exponential backoff
  - Max retry attempts configuration

- [ ] **Testing**
  - Mock GMI responses for unit tests
  - Integration test with real GMI on simple job
  - E2E test: job → GMI execution → quality check → submission
  - Load testing for concurrent job execution

## Example Implementation

```typescript
import { GMIManager } from '../gmi/GMIManager';
import { ExecuteJobCallback } from './types';

const gmiCallback: ExecuteJobCallback = async (agentId, job, prompt) => {
  // 1. Get or create GMI session
  const session = await gmiManager.getOrCreateGMIForSession(agentId, {
    tools: getToolsForCategory(job.category),
    timeout: 5 * 60 * 1000, // 5 minutes
  });

  // 2. Execute job prompt
  const output = await session.execute(prompt);

  // 3. Parse deliverables from output
  const deliverables = extractDeliverables(output);
  if (deliverables.length === 0) {
    // Fallback: treat entire output as report
    return { type: 'report', content: output };
  }

  // 4. Return first deliverable
  return deliverables[0];
};

// Helper: Get tools based on job category
function getToolsForCategory(category: string): string[] {
  const toolMap: Record<string, string[]> = {
    development: ['code_interpreter', 'cli_executor', 'file_writer'],
    research: ['web_search', 'code_interpreter'],
    data: ['code_interpreter', 'data_analyzer'],
    general: ['web_search', 'code_interpreter'],
  };
  return toolMap[category] || toolMap.general;
}

// Helper: Extract deliverables from agent output
function extractDeliverables(output: string): Deliverable[] {
  const regex = /<DELIVERABLE\s+type="([^"]+)">([\s\S]*?)<\/DELIVERABLE>/g;
  const deliverables: Deliverable[] = [];

  let match;
  while ((match = regex.exec(output)) !== null) {
    const [, type, content] = match;
    deliverables.push({
      type: type as Deliverable['type'],
      content: content.trim(),
    });
  }

  return deliverables;
}
```

## Integration Steps

1. **Locate JobExecutor instantiation** in your application
2. **Add GMI callback** to JobExecutor config
3. **Wire GMIManager** or equivalent service
4. **Test with simple job** (e.g., "Write a haiku about Solana")
5. **Add structured deliverable parsing**
6. **Implement category-specific tool configuration**
7. **Add error handling and retries**
8. **Production testing and monitoring**

## Files to Modify

- `packages/wunderland/src/jobs/JobExecutor.ts` - Add GMI callback
- `packages/wunderland/src/gmi/` - GMI orchestration logic
- `backend/src/services/` - Wire JobExecutor with GMI in application layer

## Resources

- Job execution types: `packages/wunderland/src/jobs/types.ts`
- JobExecutor: `packages/wunderland/src/jobs/JobExecutor.ts`
- Mock implementation: `JobExecutor.mockExecuteJob()`
- Quality validation: `QualityChecker.ts`

## Notes

- Start simple: P0 gets you a working end-to-end flow
- Iterate: Add structured parsing, then security, then streaming
- Test thoroughly: Job execution is mission-critical
- Monitor costs: Track token usage and execution time
