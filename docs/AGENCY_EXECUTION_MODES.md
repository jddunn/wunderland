# Agency Execution Modes: Streaming vs Queue

## Overview

AgentOS supports **two execution paradigms** for multi-agent workflows, each optimized for different use cases:

1. **STREAMING MODE** (Default): Real-time, on-demand processing with immediate feedback
2. **QUEUE MODE**: Batch processing with dependency-aware execution and optimal parallelism

This document provides a comprehensive guide to both modes, including architecture, use cases, tradeoffs, and implementation details.

---

## Execution Mode Comparison

| Aspect | Streaming Mode | Queue Mode |
|--------|----------------|------------|
| **Processing** | Real-time, on-demand | Batch, pre-planned |
| **Feedback** | Immediate (SSE) | Only when complete |
| **Resource Usage** | Higher (open connections) | Lower (no long-lived connections) |
| **Complexity** | More complex | Simpler |
| **Parallelism** | Role-based (max 4 concurrent) | Dependency-based (optimal batches) |
| **Ordering** | No pre-analysis | Topological + optimized |
| **Cost** | Higher (overhead) | Lower (optimized) |
| **Latency** | Lower (starts faster) | Higher (analysis overhead) |
| **Best For** | Interactive UIs, exploratory tasks | Background jobs, batch processing |
| **Error Handling** | Per-seat retries | Per-batch retries + continue-on-failure |
| **Progress Updates** | Real-time SSE chunks | Optional callbacks |
| **Debugging** | Complex (async streams) | Easier (sequential batches) |

---

## STREAMING MODE

### When to Use

✅ **Use streaming when:**
- Building interactive UIs (chat, dashboards)
- Need real-time user feedback
- Tasks are exploratory or undefined
- Latency to first result is critical
- User can see/act on intermediate results

❌ **Don't use streaming when:**
- Processing large batches (100+ tasks)
- No user waiting for immediate feedback
- Cost optimization is priority
- Background/scheduled workflows

### How It Works

1. **All roles execute in parallel** immediately (up to concurrency limit)
2. **Results stream back** via SSE as each seat completes
3. **No pre-analysis** of dependencies (faster startup)
4. **Per-seat error handling** with configurable retries

### Architecture

```
User Request
     ↓
Spawn all GMI instances in parallel (max 4 concurrent)
     ↓
     ├─→ Seat 1 (researcher) ──→ Stream result 1
     ├─→ Seat 2 (analyst) ────→ Stream result 2
     ├─→ Seat 3 (writer) ─────→ Stream result 3
     └─→ Seat 4 (publisher) ──→ Stream result 4
     ↓
Consolidate final output
     ↓
Return aggregated result
```

### Example

```typescript
const executor = new MultiGMIAgencyExecutor({ agentOS, onChunk: streamToClient });

const result = await executor.executeAgency({
  goal: "Research quantum computing and publish",
  roles: [
    { roleId: "researcher", personaId: "research-specialist", instruction: "Research" },
    { roleId: "publisher", personaId: "communications-manager", instruction: "Publish" }
  ],
  userId: "user123",
  conversationId: "conv456",
  coordinationStrategy: 'emergent',
  executionMode: {
    mode: 'streaming', // Real-time processing
    onProgress: (update) => console.log('Progress:', update)
  }
});

// Results stream back as:
// - text_delta chunks (incremental output)
// - agency_update chunks (seat status changes)
// - final_response chunk (consolidated result)
```

### Performance

**Resource Usage:**
- Memory: ~50-100MB per GMI instance × concurrent seats
- Connections: 1 long-lived SSE connection per client
- CPU: Moderate (parallel GMI processing)

**Latency:**
- Time to first result: ~1-3s (GMI spawn)
- Time to completion: ~10-30s per seat (depends on task)

**Cost** (gpt-4o-mini, 2 seats):
- Per-seat: ~$0.003-0.008
- Streaming overhead: ~$0.001
- Total: ~$0.007-0.017

---

## QUEUE MODE

### When to Use

✅ **Use queue when:**
- Processing large batches (50+ tasks)
- Background/scheduled workflows
- Cost optimization is priority
- Tasks have complex dependencies
- Need optimal parallel execution
- No user waiting for immediate feedback

❌ **Don't use queue when:**
- Building interactive UIs
- Need real-time progress updates
- Tasks are simple/independent
- Latency to first result is critical

### How It Works

1. **Pre-analyze workflow** to build dependency graph
2. **Group tasks into batches** (by topological depth)
3. **Optimize batch ordering** (priority, cost, duration, or dependency strategy)
4. **Execute batches sequentially**, tasks within batch run in parallel
5. **Track batch-level metrics** (success/failure counts, costs)
6. **Return results** only when entire workflow completes

### Architecture

```
User Request
     ↓
Analyze goal → Build dependency graph
     ↓
Group into batches by depth:
  Batch 1 (depth 0): [task1, task2, task3] ─── All parallel
  Batch 2 (depth 1): [task4, task5] ────────── Waits for Batch 1
  Batch 3 (depth 2): [task6] ───────────────── Waits for Batch 2
     ↓
Optimize ordering within each batch
     ↓
Execute Batch 1 → Execute Batch 2 → Execute Batch 3
     ↓
Consolidate all results
     ↓
Return aggregated result + batch metadata
```

### Dependency Graph

**Example Tasks:**
```
task1: Research topic A (no deps)
task2: Research topic B (no deps)
task3: Fact-check (depends on task1, task2)
task4: Format report (depends on task3)
task5: Publish (depends on task4)
```

**Resulting Batches:**
```
Batch 1 (depth 0): [task1, task2] ← Both run in parallel
Batch 2 (depth 1): [task3] ← Runs after Batch 1 completes
Batch 3 (depth 2): [task4] ← Runs after Batch 2 completes
Batch 4 (depth 3): [task5] ← Runs after Batch 3 completes
```

**Critical Path**: `task1 → task3 → task4 → task5` (4 tasks, minimum duration)

### Example

```typescript
const executor = new MultiGMIAgencyExecutor({ agentOS });

const result = await executor.executeAgency({
  goal: "Process 100 research documents",
  roles: [
    { roleId: "researcher", personaId: "research-specialist", instruction: "Research" },
    { roleId: "analyst", personaId: "data-analyst", instruction: "Analyze" },
    { roleId: "writer", personaId: "technical-writer", instruction: "Format" }
  ],
  userId: "user123",
  conversationId: "conv456",
  coordinationStrategy: 'static',
  staticTasks: [
    { taskId: "research_1", description: "Research doc 1-50", assignedRoleId: "researcher", executionOrder: 1, dependencies: [] },
    { taskId: "research_2", description: "Research doc 51-100", assignedRoleId: "researcher", executionOrder: 2, dependencies: [] },
    { taskId: "analyze", description: "Analyze findings", assignedRoleId: "analyst", executionOrder: 3, dependencies: ["research_1", "research_2"] },
    { taskId: "write", description: "Write report", assignedRoleId: "writer", executionOrder: 4, dependencies: ["analyze"] }
  ],
  executionMode: {
    mode: 'queue', // Batch processing
    queueConfig: {
      maxParallelBatches: 3,
      batchOrderingStrategy: 'dependency',
      continueOnBatchFailure: true,
      batchDelayMs: 1000 // 1s delay between batches
    }
  }
});

// Execution plan:
// Batch 1: [research_1, research_2] ← parallel
// Batch 2: [analyze] ← waits for Batch 1
// Batch 3: [write] ← waits for Batch 2

console.log(result.queueMetadata);
// {
//   totalBatches: 3,
//   batchResults: [
//     { batchId: "...", taskIds: [...], successCount: 2, failureCount: 0, durationMs: 15000 },
//     { batchId: "...", taskIds: [...], successCount: 1, failureCount: 0, durationMs: 12000 },
//     { batchId: "...", taskIds: [...], successCount: 1, failureCount: 0, durationMs: 10000 }
//   ],
//   maxParallelism: 2,
//   criticalPathLength: 3
// }
```

### Performance

**Resource Usage:**
- Memory: ~50-100MB per GMI instance × batch size
- Connections: None (batch completes before returning)
- CPU: High during batch, idle between batches

**Latency:**
- Pre-analysis: ~2-5s (dependency graph building)
- Per-batch: ~10-30s (depends on task count and complexity)
- Total: analysis + (batch1 + batch2 + ... + batchN)

**Cost** (gpt-4o-mini, 4 tasks across 3 batches):
- Analysis overhead: ~$0.002
- Per-task: ~$0.003-0.008
- Total: ~$0.014-0.034 (20-30% cheaper than streaming due to optimal ordering)

---

## Configuration Options

### Queue Mode Config

```typescript
interface QueueExecutionConfig {
  /**
   * Maximum number of tasks to execute in parallel within a batch.
   * @default 3
   */
  maxParallelBatches?: number;

  /**
   * How to order tasks within a batch:
   * - 'priority': High-priority tasks first
   * - 'cost': Cheapest tasks first (budget optimization)
   * - 'duration': Fastest tasks first (throughput optimization)
   * - 'dependency': Tasks with most dependents first (unblock others)
   * @default 'dependency'
   */
  batchOrderingStrategy?: 'priority' | 'cost' | 'duration' | 'dependency';

  /**
   * Whether to continue if a batch fails.
   * @default true
   */
  continueOnBatchFailure?: boolean;

  /**
   * Delay between batches (ms).
   * Useful for rate limiting.
   * @default 0
   */
  batchDelayMs?: number;
}
```

### Streaming Mode Config

```typescript
interface ExecutionModeConfig {
  mode: 'streaming';
  
  /**
   * Callback for progress updates.
   * Called for each significant event.
   */
  onProgress?: (update: StreamingProgressUpdate) => void | Promise<void>;

  /**
   * Whether to pre-analyze workflow before execution.
   * If true, generates execution plan but still streams results.
   * @default false
   */
  preAnalyze?: boolean;
}
```

---

## Workflow Analysis API

### Pre-Analyze Before Execution

```typescript
// Generate execution plan without executing
const analysis = await executor.analyzeWorkflow({
  goal: "Complex research project",
  roles: [...],
  coordinationStrategy: 'emergent'
});

console.log(analysis.executionPlan);
// # Agency Execution Plan
// **Total Tasks**: 8
// **Batches**: 4
// **Max Parallelism**: 3 tasks
// **Critical Path**: 5 tasks
// **Estimated Duration**: 42.0s
//
// ## Execution Order
// **Batch 1** (3 tasks in parallel):
//   - task_1: Research topic A (role: researcher)
//   - task_2: Research topic B (role: researcher)
//   - task_3: Research topic C (role: researcher)
// ...

console.log(analysis.recommendations);
// [
//   "High parallelism (3 tasks). Consider increasing concurrency limit.",
//   "Estimated cost ($0.0400) is moderate."
// ]
```

---

## Dependency Graph Details

### Graph Structure

```typescript
interface DependencyGraph {
  nodes: Map<string, TaskNode>;
  roots: string[]; // Tasks with no dependencies
  leaves: string[]; // Tasks with no dependents
  maxDepth: number;
  criticalPath: string[]; // Longest path (minimum duration)
  parallelizableBatches: string[][]; // Tasks grouped by depth
}

interface TaskNode {
  task: EmergentTask | StaticTask;
  dependencies: Set<string>;
  dependents: Set<string>;
  depth: number; // Distance from roots
  estimatedCost?: number;
  estimatedDuration?: number;
  priority: number;
}
```

### Cycle Detection

The `DependencyGraphAnalyzer` uses depth-first search to detect cycles:

```typescript
// This will throw an error:
const invalid = [
  { taskId: "A", dependencies: ["B"] },
  { taskId: "B", dependencies: ["C"] },
  { taskId: "C", dependencies: ["A"] } // Cycle!
];

// Error: "Circular dependency detected: A → B → C → A"
```

### Depth Calculation

Tasks are assigned depths based on their distance from roots:

```
task1 (no deps) → depth 0
task2 (no deps) → depth 0
task3 (deps: task1, task2) → depth 1
task4 (deps: task3) → depth 2
```

All tasks at the same depth can execute in parallel.

---

## API Usage

### Backend Endpoint

**GET** `/api/agentos/agency/stream`

Query Parameters:
- `userId` (required)
- `conversationId` (required)
- `goal` (required)
- `roles` (required): JSON array
- `coordinationStrategy` (optional): `emergent` | `static`
- **`executionMode`** (optional): `streaming` | `queue` (default: `streaming`)
- **`queueConfig`** (optional): JSON object with queue configuration

**Example URLs:**

**Streaming:**
```
/api/agentos/agency/stream?
  userId=user123&
  conversationId=conv456&
  goal=Research%20and%20publish&
  roles=[...]&
  executionMode=streaming
```

**Queue:**
```
/api/agentos/agency/stream?
  userId=user123&
  conversationId=conv456&
  goal=Process%20batch&
  roles=[...]&
  coordinationStrategy=static&
  staticTasks=[...]&
  executionMode=queue&
  queueConfig={"maxParallelBatches":3,"batchOrderingStrategy":"dependency"}
```

### Programmatic Usage

```typescript
import { MultiGMIAgencyExecutor } from './MultiGMIAgencyExecutor';

const executor = new MultiGMIAgencyExecutor({
  agentOS,
  maxRetries: 2,
  retryDelayMs: 1000
});

// STREAMING MODE
const streamingResult = await executor.executeAgency({
  goal: "Interactive research task",
  roles: [...],
  userId: "user123",
  conversationId: "conv456",
  executionMode: {
    mode: 'streaming',
    onProgress: async (update) => {
      console.log(`[${update.type}] ${update.message}`);
      await sendToClient(update);
    }
  }
});

// QUEUE MODE
const queueResult = await executor.executeAgency({
  goal: "Batch processing job",
  roles: [...],
  staticTasks: [...],
  userId: "user123",
  conversationId: "conv456",
  executionMode: {
    mode: 'queue',
    queueConfig: {
      maxParallelBatches: 5,
      batchOrderingStrategy: 'cost',
      continueOnBatchFailure: true,
      batchDelayMs: 500
    }
  }
});

console.log(queueResult.queueMetadata);
// {
//   totalBatches: 4,
//   batchResults: [...],
//   maxParallelism: 3,
//   criticalPathLength: 5
// }
```

---

## Batch Ordering Strategies

### Priority Strategy

Orders tasks by priority (highest first):

```typescript
executionMode: {
  mode: 'queue',
  queueConfig: { batchOrderingStrategy: 'priority' }
}

// Batch execution order:
// 1. task_high_priority (priority: 10)
// 2. task_medium_priority (priority: 7)
// 3. task_low_priority (priority: 3)
```

**Use when:**
- Some tasks are more important than others
- Want to ensure critical tasks complete first
- Can accept suboptimal parallelism for priority

### Cost Strategy

Orders tasks by estimated cost (cheapest first):

```typescript
executionMode: {
  mode: 'queue',
  queueConfig: { batchOrderingStrategy: 'cost' }
}

// Batch execution order:
// 1. task_cheap (estimated: $0.001)
// 2. task_moderate (estimated: $0.005)
// 3. task_expensive (estimated: $0.020)
```

**Use when:**
- Budget constraints are tight
- Want to complete as many tasks as possible within budget
- Can tolerate longer overall duration

### Duration Strategy

Orders tasks by estimated duration (fastest first):

```typescript
executionMode: {
  mode: 'queue',
  queueConfig: { batchOrderingStrategy: 'duration' }
}

// Batch execution order:
// 1. task_fast (estimated: 5s)
// 2. task_medium (estimated: 15s)
// 3. task_slow (estimated: 45s)
```

**Use when:**
- Throughput is priority (complete more tasks faster)
- Want to show early progress
- Can accept longer critical path

### Dependency Strategy (Default)

Orders tasks by dependent count (most dependents first):

```typescript
executionMode: {
  mode: 'queue',
  queueConfig: { batchOrderingStrategy: 'dependency' } // or omit (default)
}

// Batch execution order:
// 1. task_A (3 dependents) ← Unblocks the most tasks
// 2. task_B (1 dependent)
// 3. task_C (0 dependents)
```

**Use when:**
- Want to minimize overall workflow duration
- Maximize downstream parallelism
- Default choice for most workflows

---

## Error Handling

### Streaming Mode

**Per-Seat Retries:**
- Each seat retries independently
- Configurable `maxRetries` (default: 2)
- Configurable `retryDelayMs` (default: 1000)
- Failures logged to database

**Failure Strategy:**
- Individual seat failures don't block others
- Agency marked "completed" if ≥50% seats succeed
- Partial results still returned

### Queue Mode

**Per-Batch Retries:**
- Entire batch retries on failure (not individual tasks)
- `continueOnBatchFailure`:
  - `true` (default): Skip failed batch, continue with next
  - `false`: Abort entire workflow on first batch failure

**Failure Strategy:**
- Batch failure = all tasks in batch marked as failed
- Results from successful batches still returned
- Detailed error tracking per batch

---

## Progress Updates

### Streaming Mode

Real-time updates via SSE:

```typescript
{
  "type": "text_delta",
  "textDelta": "Research findings: ...",
  "gmiInstanceId": "gmi-instance-xyz1"
}

{
  "type": "agency_update",
  "agency": {
    "seats": [
      { "roleId": "researcher", "status": "running" },
      { "roleId": "publisher", "status": "pending" }
    ]
  }
}

{
  "type": "final_response",
  "finalResponseText": "# Results\n\n...",
  "usage": { "totalCostUSD": 0.0105 }
}
```

### Queue Mode

Optional callback-based updates:

```typescript
executionMode: {
  mode: 'queue',
  onProgress: async (update) => {
    switch (update.type) {
      case 'batch_complete':
        console.log(`Batch ${update.metadata.batchIndex} complete`);
        break;
      case 'task_complete':
        console.log(`Task ${update.taskId} complete`);
        break;
      case 'agency_complete':
        console.log('All batches complete!');
        break;
    }
  }
}
```

---

## Best Practices

### When to Use Each Mode

**Interactive Dashboard** → Streaming
```typescript
// User clicks "Launch Agency" button
executionMode: { mode: 'streaming' }
// → Results appear in real-time
// → User can see intermediate outputs
// → Can cancel mid-execution
```

**Scheduled Batch Job** → Queue
```typescript
// Cron job triggers at 2 AM
executionMode: {
  mode: 'queue',
  queueConfig: {
    maxParallelBatches: 10, // Max out parallelism
    batchOrderingStrategy: 'cost' // Optimize for budget
  }
}
// → Pre-analyzes all dependencies
// → Executes in optimal order
// → Logs results to database
```

**Cost-Sensitive Workflow** → Queue + Cost Strategy
```typescript
executionMode: {
  mode: 'queue',
  queueConfig: {
    batchOrderingStrategy: 'cost', // Cheapest first
    continueOnBatchFailure: true, // Don't abort on errors
    maxParallelBatches: 2 // Limit resource usage
  }
}
```

**High-Throughput Processing** → Queue + Duration Strategy
```typescript
executionMode: {
  mode: 'queue',
  queueConfig: {
    batchOrderingStrategy: 'duration', // Fastest first
    maxParallelBatches: 10, // Max parallelism
    batchDelayMs: 0 // No delays
  }
}
```

---

## Testing

### Integration Tests

Location: `backend/src/__tests__/agency.integration.test.ts`

**Coverage:**
- ✅ Streaming mode with parallel execution
- ✅ Queue mode with dependency resolution
- ✅ Batch ordering strategies
- ✅ Cycle detection
- ✅ Error recovery in both modes

**Run:**
```bash
pnpm --filter voice-chat-assistant-backend test
```

### Manual Testing

**Test Streaming Mode:**
```bash
curl "http://localhost:3333/api/agentos/agency/stream?\
userId=test&\
conversationId=test123&\
goal=Test%20streaming&\
roles=%5B%7B%22roleId%22%3A%22test%22%2C%22personaId%22%3A%22generalist%22%2C%22instruction%22%3A%22Test%22%7D%5D&\
executionMode=streaming"
```

**Test Queue Mode:**
```bash
curl "http://localhost:3333/api/agentos/agency/stream?\
userId=test&\
conversationId=test123&\
goal=Test%20queue&\
roles=%5B...%5D&\
coordinationStrategy=static&\
staticTasks=%5B...%5D&\
executionMode=queue&\
queueConfig=%7B%22maxParallelBatches%22%3A3%7D"
```

---

## Troubleshooting

### Issue: Queue mode ignores maxParallelBatches

**Cause**: maxParallelBatches is per-batch, not total workflow

**Fix**: If batch has 10 tasks and maxParallelBatches=3, only 3 tasks from that batch run in parallel

### Issue: Streaming mode too slow

**Cause**: Low concurrency limit (default: 4)

**Fix**: Not configurable yet. Queue mode with high maxParallelBatches will be faster.

### Issue: Queue mode returns before all tasks complete

**Cause**: `continueOnBatchFailure=true` and early batches failed

**Fix**: Check `queueMetadata.batchResults` for failures. Set `continueOnBatchFailure=false` to abort on first failure.

---

## Future Enhancements

### Planned for v0.2.0

1. **Hybrid Mode**
   - Stream first batch results immediately
   - Queue remaining batches
   - Best of both worlds

2. **Dynamic Re-Planning**
   - Adjust batches based on actual task durations
   - Re-optimize if early tasks complete faster than expected

3. **Resource-Aware Scheduling**
   - Monitor system resources (CPU, memory)
   - Dynamically adjust parallelism

4. **Cost Prediction**
   - Estimate costs before execution
   - Abort if estimated cost exceeds budget

---

## Implementation Status

| Feature | Status | Tests | Docs |
|---------|--------|-------|------|
| Streaming Mode | ✅ Production | ✅ Integration | ✅ Complete |
| Queue Mode | ✅ Production | ✅ Integration | ✅ Complete |
| Dependency Graph Analyzer | ✅ Production | ✅ Integration | ✅ Complete |
| Cycle Detection | ✅ Production | ✅ Integration | ✅ Complete |
| Batch Ordering Strategies | ✅ Production | ✅ Integration | ✅ Complete |
| Workflow Analysis API | ✅ Production | ⏳ Pending | ✅ Complete |
| Progress Callbacks | ✅ Production | ⏳ Pending | ✅ Complete |

---

## Links

- [Emergent Agency System](./EMERGENT_AGENCY_SYSTEM.md)
- [Architecture Documentation](../packages/agentos/docs/ARCHITECTURE.md)
- [Backend API Reference](./BACKEND_API.md)
- [v0.1.0 Release Notes](./V0_1_0_RELEASE_NOTES.md)

---

**Status**: ✅ Production Ready for v0.1.0  
**Last Updated**: 2025-01-15  
**Maintainer**: AgentOS Core Team

