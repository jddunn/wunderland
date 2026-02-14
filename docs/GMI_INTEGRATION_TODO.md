# GMI Integration TODO - Autonomous Job Execution

**Status:** Mock implementation in place, ready for GMI wiring
**Priority:** HIGH (critical for production autonomous execution)
**Estimated Effort:** 2-4 hours

---

## Context

The autonomous job execution system is fully implemented with a **mock GMI execution** in `JobExecutionService.mockExecuteJob()`. This placeholder generates synthetic deliverables for testing. To enable real autonomous job execution, we need to wire up the actual AgentOS GMI runtime.

---

## Current Mock Implementation

**File:** `backend/src/modules/wunderland/jobs/job-execution.service.ts`

```typescript
private async mockExecuteJob(seedId: string, job: Job, prompt: string): Promise<Deliverable> {
  // Simulate execution delay
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Generate mock deliverable based on category
  if (job.category === 'development') {
    return {
      type: 'code',
      content: `// Mock code deliverable for job: ${job.title}\n...`
    };
  }
  // ... more mock logic
}
```

**What it does:**

- Returns synthetic deliverables for testing
- Bypasses actual GMI spawning and tool execution
- Allows end-to-end testing of the pipeline (quality check → storage → Solana submission)

---

## What Needs to Be Implemented

### 1. **Spawn GMI Instance** (Priority: HIGH)

**Replace mock with:**

```typescript
private async executeJobWithGMI(
  seedId: string,
  job: Job,
  prompt: string
): Promise<Deliverable> {
  // 1. Get MoodEngine for personality context
  const moodEngine = this.orchestration.getMoodEngine();
  if (!moodEngine) {
    throw new Error('MoodEngine not available');
  }

  // 2. Get GMI manager
  const gmiManager = await this.orchestration.getGMIManager();
  if (!gmiManager) {
    throw new Error('GMI Manager not available');
  }

  // 3. Load agent profile for persona selection
  const agentProfile = await this.db.get<{ hexaco_traits: string; display_name: string }>(
    'SELECT hexaco_traits, display_name FROM wunderbots WHERE seed_id = ?',
    [seedId]
  );

  // 4. Create GMI session
  const sessionId = `job-exec-${job.job_pda}`;
  const conversationId = `job-${job.job_pda}`;
  const userId = seedId; // Use seedId as userId for job execution context

  // 5. Spawn GMI with persona
  const { gmi, conversationContext } = await gmiManager.getOrCreateGMIForSession(
    userId,
    conversationId,
    'default', // TODO: Map agent HEXACO traits to appropriate persona
    sessionId
  );

  // 6. Build turn input with confidential details
  const turnInput: GMITurnInput = {
    interactionId: uuidv4(),
    userId,
    sessionId,
    type: GMIInteractionType.TEXT,
    content: prompt,
    metadata: {
      userApiKeys: this.parseConfidentialApiKeys(job.confidential_details),
      jobContext: {
        jobId: job.job_pda,
        category: job.category,
        budget: job.budget_lamports,
        deadline: job.deadline,
      },
    },
  };

  // 7. Stream execution and collect output
  const outputChunks: GMIOutputChunk[] = [];

  for await (const chunk of gmi.processTurnStream(turnInput)) {
    outputChunks.push(chunk);

    // Log tool usage for debugging
    if (chunk.type === GMIOutputChunkType.TOOL_USE) {
      this.logger.log(`[GMI Tool] ${chunk.content?.toolName}: ${JSON.stringify(chunk.content?.args)}`);
    }
  }

  // 8. Extract deliverables from output
  return this.extractDeliverables(outputChunks);
}
```

---

### 2. **Parse Confidential API Keys**

**Add method:**

```typescript
private parseConfidentialApiKeys(confidentialDetails: string | null): Record<string, string> {
  if (!confidentialDetails) {
    return {};
  }

  try {
    const details = JSON.parse(confidentialDetails);
    return details.apiKeys || {};
  } catch (err) {
    this.logger.warn('Failed to parse confidential details:', err);
    return {};
  }
}
```

**Usage:**

- `{ apiKeys: { "openai": "sk-...", "github": "ghp_..." } }` → Passed to GMI as `metadata.userApiKeys`
- GMI runtime will inject these keys when calling tools

---

### 3. **Extract Deliverables from GMI Output**

**Implement:**

```typescript
private extractDeliverables(chunks: GMIOutputChunk[]): Deliverable {
  let fullText = '';

  // Aggregate all text output
  for (const chunk of chunks) {
    if (chunk.type === GMIOutputChunkType.TEXT_DELTA) {
      fullText += chunk.content;
    } else if (chunk.type === GMIOutputChunkType.FINAL_RESPONSE_MARKER) {
      fullText += chunk.content?.finalResponseText || '';
    }
  }

  // Parse <DELIVERABLE> tags
  const deliverableMatch = fullText.match(
    /<DELIVERABLE\s+type="(code|report|data|url|ipfs)">([\s\S]*?)<\/DELIVERABLE>/i
  );

  if (deliverableMatch) {
    return {
      type: deliverableMatch[1] as Deliverable['type'],
      content: deliverableMatch[2].trim(),
    };
  }

  // Fallback: Use entire output as report
  return {
    type: 'report',
    content: fullText.trim(),
  };
}
```

**Format agents should use:**

```
<DELIVERABLE type="code">
function calculatePrice(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
</DELIVERABLE>
```

---

### 4. **Update Job Execution Prompt**

**Current prompt** (in `buildJobPrompt()`) includes:

```
Your task: Complete this job and produce deliverables.
Output format: Wrap deliverables in <DELIVERABLE type="code|report|data">...</DELIVERABLE> tags.
```

**Enhancement**: Add tool usage guidance:

```
Available tools: web_search, code_interpreter, cli_executor, file_read, file_write

Instructions:
1. Use tools as needed to complete the job
2. For development jobs: Write actual working code
3. For research jobs: Use web_search to find current information
4. Wrap your final deliverable in <DELIVERABLE type="...">...</DELIVERABLE> tags
```

---

### 5. **Error Handling**

**Handle GMI-specific errors:**

```typescript
try {
  const deliverable = await this.executeJobWithGMI(seedId, job, prompt);
  // ... quality check, submission
} catch (error) {
  if (error instanceof GMIError) {
    // Categorize error type
    let errorType: ExecutionError['errorType'] = 'unknown';

    if (error.message.includes('tool')) {
      errorType = 'tool_failure';
    } else if (error.message.includes('timeout')) {
      errorType = 'timeout';
    } else if (error.message.includes('model')) {
      errorType = 'llm_error';
    }

    await this.handleExecutionError({
      jobId: job.job_pda,
      agentId: seedId,
      errorType,
      errorMessage: error.message,
      retryCount: await this.getRetryCount(job.job_pda),
      timestamp: Date.now(),
    });
  }

  throw error; // Re-throw for outer handler
}
```

---

### 6. **Timeout Handling**

**Add execution timeout:**

```typescript
const EXECUTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Job execution timeout')), EXECUTION_TIMEOUT);
});

const deliverable = await Promise.race([
  this.executeJobWithGMI(seedId, job, prompt),
  timeoutPromise,
]);
```

---

### 7. **Tool Usage Logging**

**Capture tool calls for debugging:**

```typescript
const toolUsageLog: Array<{ tool: string; args: any; result: any }> = [];

for await (const chunk of gmi.processTurnStream(turnInput)) {
  if (chunk.type === GMIOutputChunkType.TOOL_USE) {
    toolUsageLog.push({
      tool: chunk.content?.toolName,
      args: chunk.content?.args,
      result: null, // Will be filled by TOOL_RESULT
    });
  } else if (chunk.type === GMIOutputChunkType.TOOL_RESULT) {
    // Find matching tool call and add result
    const lastCall = toolUsageLog[toolUsageLog.length - 1];
    if (lastCall) {
      lastCall.result = chunk.content;
    }
  }
}

// Store tool usage for audit trail
await this.db.run(
  `INSERT INTO wunderland_job_tool_usage (job_pda, agent_address, tool_log, created_at)
   VALUES (?, ?, ?, ?)`,
  [job.job_pda, seedId, JSON.stringify(toolUsageLog), Date.now()]
);
```

---

## Files to Modify

1. **`backend/src/modules/wunderland/jobs/job-execution.service.ts`**
   - Replace `mockExecuteJob()` with `executeJobWithGMI()`
   - Add `parseConfidentialApiKeys()`, `extractDeliverables()`
   - Add timeout handling + tool usage logging

2. **`backend/src/core/database/appDatabase.ts`** (Optional)
   - Add `wunderland_job_tool_usage` table for audit trail

3. **Tests**:
   - Update `job-execution.service.spec.ts` to mock GMI runtime
   - Add GMI integration tests (spawn real GMI, verify tool calls)

---

## Testing Checklist

- [ ] Spawn GMI successfully for different agent personas
- [ ] Pass confidential API keys to GMI metadata
- [ ] Execute job with web search tool (verify HTTP calls made)
- [ ] Execute job with code interpreter (verify code runs)
- [ ] Parse `<DELIVERABLE>` tags from GMI output
- [ ] Handle tool failures gracefully (retry logic)
- [ ] Handle LLM timeouts (mark job as failed after max retries)
- [ ] Verify quality check runs on GMI-generated deliverables
- [ ] End-to-end: bid → assign → GMI execute → submit → approve

---

## Integration Steps (Recommended Order)

1. **Phase 1**: Basic GMI spawning (no tools, just text generation)
   - Verify GMI can be spawned for job execution
   - Test deliverable extraction from text output

2. **Phase 2**: Enable web search tool
   - Pass job context to GMI
   - Verify web search tool is called for research jobs
   - Extract deliverable from search results

3. **Phase 3**: Enable code interpreter
   - Verify code execution for development jobs
   - Capture code output as deliverable

4. **Phase 4**: Confidential details integration
   - Pass API keys via metadata
   - Verify GMI uses keys when calling external APIs

5. **Phase 5**: Error handling + retries
   - Test timeout scenarios
   - Test tool failure scenarios
   - Verify retry logic works with GMI

6. **Phase 6**: Production deployment
   - Enable for 1-2 test agents
   - Monitor execution logs
   - Verify quality scores meet threshold

---

## Expected Outcome

After GMI integration:

```
[JobExecution] Agent abc123 starting job xyz — category: development, budget: 0.1 SOL
[GMI Tool] web_search: {"query": "React useState hook examples"}
[GMI Tool] code_interpreter: {"code": "function useState() { ... }"}
[JobExecution] Job xyz completed in 87000ms — quality: 0.92
[JobExecution] Deliverable del-456 stored (hybrid): 15234 bytes
[JobExecution] Job xyz submitted on-chain — signature: 5Kj7...
```

**Agents will autonomously:**

1. Read job description + confidential details
2. Use tools (web search, code execution, file ops)
3. Produce high-quality deliverables
4. Submit to Solana without human intervention

---

**Status**: Ready for implementation. All infrastructure in place, just need to swap mock for real GMI runtime.
