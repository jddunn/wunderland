# Emergent Agency System for AgentOS v0.1.0

## Overview

The Emergent Agency System enables **dynamic multi-agent coordination** where agents can:
- Decompose complex goals into subtasks
- Spawn new roles adaptively based on task requirements
- Coordinate through shared context
- Produce structured, actionable outputs

This document describes the full implementation for AgentOS v0.1.0.

---

## Architecture

### Core Components

1. **EmergentAgencyCoordinator**
   - Analyzes goals and decomposes them into concrete tasks
   - Assigns tasks to roles (existing or newly spawned)
   - Manages shared context for inter-agent coordination
   - Location: `backend/src/integrations/agentos/EmergentAgencyCoordinator.ts`

2. **MultiGMIAgencyExecutor**
   - Orchestrates parallel execution of multiple GMI instances
   - Handles error recovery with configurable retry logic
   - Aggregates costs and usage across all agents
   - Streams real-time progress updates
   - Location: `backend/src/integrations/agentos/MultiGMIAgencyExecutor.ts`

3. **Agency Persistence Layer**
   - Persists agency execution state to database
   - Tracks individual seat progress and retries
   - Stores emergent metadata (decomposed tasks, spawned roles)
   - Location: `backend/src/integrations/agentos/agencyPersistence.service.ts`

4. **Agency Stream Router**
   - Provides SSE endpoint for real-time agency streaming
   - Supports emergent behavior via query parameter
   - Location: `backend/src/integrations/agentos/agentos.agency-stream-router.ts`

---

## How It Works

### 1. Goal Decomposition

When `enableEmergentBehavior=true`, the system:

1. Sends the goal to a planner persona
2. Receives a structured list of tasks with:
   - Description
   - Dependencies (which tasks must complete first)
   - Priority (1-10 scale)
   - Required capabilities

**Example:**
```json
[
  {
    "description": "Research current quantum computing breakthroughs",
    "dependencies": [],
    "priority": 9,
    "requiredCapabilities": ["webSearch", "factCheck"]
  },
  {
    "description": "Format findings into publishable report",
    "dependencies": ["task_1"],
    "priority": 7,
    "requiredCapabilities": ["contentFormatting"]
  }
]
```

### 2. Adaptive Role Assignment

The coordinator then:

1. Analyzes available roles vs. task requirements
2. Assigns tasks to existing roles where capabilities match
3. **Spawns new roles** if existing ones lack required capabilities
4. Returns an updated role list with task assignments

**Example:**
```json
{
  "assignments": [
    { "taskId": "task_1", "roleId": "researcher", "reason": "Has webSearch capability" },
    { "taskId": "task_2", "roleId": "communicator", "reason": "Handles formatting" }
  ],
  "newRoles": []
}
```

### 3. Parallel Execution

Each role:
- Spawns a dedicated GMI instance with the assigned persona
- Receives its specific instruction + shared goal context
- Executes independently with automatic retry on failure
- Streams progress updates back to the coordinator

### 4. Structured Output

Results are formatted based on `outputFormat`:
- **markdown**: Consolidated report with sections per role
- **json**: Structured data for programmatic consumption
- **csv**: Tabular format for data analysis
- **text**: Plain text summary

---

## Usage

### API Endpoint

**GET** `/api/agentos/agency/stream`

Query Parameters:
- `userId` (required): User ID
- `conversationId` (required): Conversation/session ID
- `goal` (required): The high-level objective
- `roles` (required): JSON array of role configurations
- `outputFormat` (optional): `markdown` | `json` | `csv` | `text`
- `workflowDefinitionId` (optional): Workflow to follow
- **`enableEmergent`** (optional): `"true"` to enable emergent behavior

**Example:**
```bash
curl "http://localhost:3333/api/agentos/agency/stream?\
userId=user123&\
conversationId=conv456&\
goal=Research%20quantum%20computing%20and%20publish%20to%20Telegram&\
roles=%5B%7B%22roleId%22%3A%22researcher%22%2C%22personaId%22%3A%22research-specialist%22%2C%22instruction%22%3A%22Research%20technical%20info%22%7D%5D&\
outputFormat=markdown&\
enableEmergent=true"
```

### Response Stream (SSE)

The endpoint streams `AgentOSResponse` chunks:

```typescript
{
  "type": "agency_update",
  "streamId": "conv456",
  "gmiInstanceId": "agency:agency_abc123",
  "personaId": "agency:agency_abc123",
  "isFinal": false,
  "timestamp": "2025-01-15T10:30:00Z",
  "agency": {
    "agencyId": "agency_abc123",
    "workflowId": "workflow:agency_abc123",
    "conversationId": "conv456",
    "seats": [
      {
        "roleId": "researcher",
        "personaId": "research-specialist",
        "gmiInstanceId": "gmi-instance-xyz789",
        "metadata": { "status": "running" }
      }
    ],
    "metadata": { "goal": "...", "status": "pending" }
  }
}
```

Final chunk includes:
```typescript
{
  "type": "final_response",
  "finalResponseText": "# Research Findings\n\n## RESEARCHER\n...",
  "usage": {
    "promptTokens": 1500,
    "completionTokens": 2000,
    "totalTokens": 3500,
    "totalCostUSD": 0.0105
  },
  "metadata": {
    "agencyId": "agency_abc123",
    "roleCount": 2,
    "outputFormat": "markdown",
    "emergentBehavior": {
      "tasksDecomposed": 3,
      "rolesSpawned": 2,
      "coordinationEvents": 5
    }
  }
}
```

---

## Configuration

### Retry Logic

Configured in `MultiGMIAgencyExecutorDependencies`:

```typescript
const executor = new MultiGMIAgencyExecutor({
  agentOS: agentosInstance,
  onChunk: streamCallback,
  maxRetries: 2,         // Default: 2
  retryDelayMs: 1000,    // Default: 1000
});
```

### Concurrency

Tasks execute in parallel with a concurrency limit of **min(4, roleCount)**.

### Cost Tracking

Automatically aggregates:
- Prompt tokens
- Completion tokens
- Total cost in USD (based on model pricing)
- Per-seat usage breakdowns

---

## Database Schema

### `agency_executions`

Stores top-level agency execution metadata:

```sql
CREATE TABLE agency_executions (
  agency_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  workflow_definition_id TEXT,
  status TEXT NOT NULL,  -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  total_cost_usd REAL,
  total_tokens INTEGER,
  output_format TEXT,
  consolidated_output TEXT,
  formatted_output TEXT,
  emergent_metadata TEXT,  -- JSON string with decomposed tasks and spawned roles
  error TEXT,
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
);
```

### `agency_seats`

Tracks individual role execution:

```sql
CREATE TABLE agency_seats (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  gmi_instance_id TEXT,
  status TEXT NOT NULL,  -- 'pending' | 'running' | 'completed' | 'failed'
  started_at INTEGER,
  completed_at INTEGER,
  output TEXT,
  error TEXT,
  usage_tokens INTEGER,
  usage_cost_usd REAL,
  retry_count INTEGER DEFAULT 0,
  metadata TEXT,
  FOREIGN KEY (agency_id) REFERENCES agency_executions(agency_id) ON DELETE CASCADE
);
```

---

## API Endpoints

### List Agency Executions

**GET** `/api/agentos/agency/executions?userId=<userId>&limit=<limit>`

Returns historical agency executions for a user.

**Response:**
```json
{
  "executions": [
    {
      "agency_id": "agency_abc123",
      "user_id": "user123",
      "goal": "Research and publish quantum computing news",
      "status": "completed",
      "started_at": 1705315800000,
      "completed_at": 1705316100000,
      "duration_ms": 300000,
      "total_cost_usd": 0.0105,
      "total_tokens": 3500,
      "emergent_metadata": "{\"tasksDecomposed\":[...],\"rolesSpawned\":[...]}"
    }
  ]
}
```

### Get Specific Agency Execution

**GET** `/api/agentos/agency/executions/:agencyId`

Returns detailed execution with all seats.

**Response:**
```json
{
  "execution": { /* AgencyExecutionRecord */ },
  "seats": [
    {
      "id": "seat_agency_abc123_researcher",
      "agency_id": "agency_abc123",
      "role_id": "researcher",
      "persona_id": "research-specialist",
      "gmi_instance_id": "gmi-instance-xyz789",
      "status": "completed",
      "output": "Research findings...",
      "usage_tokens": 1500,
      "usage_cost_usd": 0.0045,
      "retry_count": 0
    }
  ]
}
```

---

## Workbench UI

### AgencyHistoryView Component

Location: `apps/agentos-client/src/components/AgencyHistoryView.tsx`

**Features:**
- Lists all agency executions for the current user
- Expandable cards showing:
  - Goal and status
  - Duration and cost
  - Seat breakdown with individual outputs
  - Emergent behavior insights (tasks decomposed, roles spawned)
  - Retry counts and error messages
- Real-time updates via SSE integration

**Usage:**
```typescript
import { AgencyHistoryView } from '@/components/AgencyHistoryView';

<AgencyHistoryView userId="user123" />
```

---

## Best Practices

### When to Enable Emergent Behavior

✅ **Use emergent behavior when:**
- Goal is complex and multi-faceted
- Optimal role distribution is unclear
- Tasks have dependencies
- You want the system to adapt dynamically

❌ **Don't use emergent behavior when:**
- Goal is simple and single-step
- Roles are well-defined upfront
- You need predictable, fixed execution
- Latency/cost must be minimized

### Output Format Selection

- **markdown**: Human-readable reports, documentation
- **json**: API integrations, data pipelines
- **csv**: Data analysis, spreadsheet import
- **text**: Simple summaries, notifications

### Error Handling

The system automatically:
- Retries failed seats up to `maxRetries` times
- Logs errors to database with full stack traces
- Continues execution even if some seats fail
- Marks overall agency as "completed" if ≥50% seats succeed

---

## Example: Research & Publish Workflow

### Input

```json
{
  "goal": "Research quantum computing breakthroughs in 2024 and publish to Telegram",
  "roles": [
    {
      "roleId": "researcher",
      "personaId": "research-specialist",
      "instruction": "Find and verify latest quantum computing news",
      "priority": 10
    },
    {
      "roleId": "communicator",
      "personaId": "communications-manager",
      "instruction": "Format findings and publish to Telegram",
      "priority": 8
    }
  ],
  "userId": "user123",
  "conversationId": "conv456",
  "outputFormat": "markdown",
  "enableEmergentBehavior": true
}
```

### Emergent Decomposition

System analyzes and might produce:

```json
{
  "tasksDecomposed": [
    {
      "taskId": "task_1",
      "description": "Search for quantum computing news from 2024",
      "dependencies": [],
      "priority": 10,
      "assignedRoleId": "researcher"
    },
    {
      "taskId": "task_2",
      "description": "Fact-check and verify sources",
      "dependencies": ["task_1"],
      "priority": 9,
      "assignedRoleId": "researcher"
    },
    {
      "taskId": "task_3",
      "description": "Format as Telegram-ready message",
      "dependencies": ["task_2"],
      "priority": 7,
      "assignedRoleId": "communicator"
    },
    {
      "taskId": "task_4",
      "description": "Publish to Telegram channel",
      "dependencies": ["task_3"],
      "priority": 8,
      "assignedRoleId": "communicator"
    }
  ],
  "rolesSpawned": [
    /* Existing roles + any new ones */
  ]
}
```

### Output

Consolidated markdown report:

```markdown
# Agency Coordination Results

## RESEARCHER
*Persona: research-specialist*

Found 5 major quantum computing breakthroughs in 2024:
1. IBM's 1000+ qubit processor announcement
2. Google's quantum error correction milestone
... (detailed findings)

---

## COMMUNICATOR
*Persona: communications-manager*

Successfully formatted and published findings to @quantum_tech_news.
Message ID: msg_xyz789
Published at: 2025-01-15 10:45:00 UTC
Reach: ~15K subscribers
```

---

## Testing

### Integration Tests

Location: `backend/src/__tests__/agency.integration.test.ts`

**Coverage:**
- Agency execution persistence
- Seat progress tracking
- Retry logic validation
- Emergent metadata storage

**Run:**
```bash
pnpm --filter voice-chat-assistant-backend test
```

### Manual Testing

1. Start backend:
```bash
pnpm --filter voice-chat-assistant-backend dev
```

2. Start workbench:
```bash
pnpm --filter @framersai/agentos-client dev
```

3. Navigate to Agency Manager
4. Click "History" button to view past executions
5. Launch new agency with emergent behavior enabled

---

## Performance Characteristics

### Resource Usage

- **Memory**: ~50-100MB per spawned GMI instance
- **Latency**: Initial decomposition adds ~2-5s overhead
- **Cost**: 2-3x higher token usage vs non-emergent (due to planning steps)

### Scaling Limits

- Max concurrent seats: 4 (configurable)
- Max tasks per decomposition: Unlimited (LLM-constrained)
- Max retries per seat: 2 (configurable)

---

## Future Enhancements

Planned for v0.2.0:

1. **Inter-Agent Messaging**
   - Agents can communicate mid-execution
   - Share intermediate results
   - Request clarifications

2. **Hierarchical Agencies**
   - Agencies can spawn sub-agencies
   - Recursive task delegation

3. **Learning & Optimization**
   - Track successful role/task assignments
   - Optimize future decompositions based on history

4. **Visual Workflow Editor**
   - Drag-and-drop agency composition
   - Real-time dependency graph visualization

---

## Troubleshooting

### Issue: Foreign key constraint error

**Cause**: User doesn't exist in `app_users` table

**Fix**: Ensure user is created before launching agency:
```sql
INSERT INTO app_users (id, email, password_hash, created_at, updated_at)
VALUES ('user123', 'user@example.com', 'hash', 1705315800000, 1705315800000);
```

### Issue: Emergent behavior not triggering

**Cause**: `enableEmergent` query parameter missing or not `"true"`

**Fix**: Ensure URL includes `&enableEmergent=true`

### Issue: Seats stuck in "running" status

**Cause**: GMI instance failed without retry catching it

**Fix**: Check backend logs for unhandled errors. Increase `maxRetries` or add better error boundaries.

---

## API Reference

### EmergentAgencyCoordinator

#### `decomposeGoal(goal: string, userId: string): Promise<EmergentTask[]>`

Analyzes a goal and returns decomposed tasks.

#### `assignRolesToTasks(tasks: EmergentTask[], existingRoles: AgentRoleConfig[], goal: string, userId: string): Promise<EmergentRole[]>`

Assigns tasks to roles and spawns new ones as needed.

#### `transformToEmergentAgency(input: AgencyExecutionInput): Promise<{ tasks, roles, context }>`

End-to-end transformation from basic input to emergent agency.

### MultiGMIAgencyExecutor

#### `executeAgency(input: AgencyExecutionInput): Promise<AgencyExecutionResult>`

Main entry point for agency execution.

**Input:**
```typescript
interface AgencyExecutionInput {
  goal: string;
  roles: AgentRoleConfig[];
  userId: string;
  conversationId: string;
  workflowDefinitionId?: string;
  outputFormat?: 'json' | 'csv' | 'markdown' | 'text';
  metadata?: Record<string, unknown>;
  enableEmergentBehavior?: boolean;
}
```

**Output:**
```typescript
interface AgencyExecutionResult {
  agencyId: string;
  goal: string;
  gmiResults: GmiExecutionResult[];
  consolidatedOutput: string;
  formattedOutput?: { format, content };
  durationMs: number;
  totalUsage: CostAggregator;
  emergentMetadata?: {
    tasksDecomposed: EmergentTask[];
    rolesSpawned: EmergentRole[];
    coordinationLog: Array<{...}>;
  };
}
```

---

## Links

- [Multi-GMI Implementation Plan](./MULTI_GMI_IMPLEMENTATION_PLAN.md)
- [AgentOS Architecture](./ARCHITECTURE.md)
- [Backend API Reference](./BACKEND_API.md)

---

**Status**: ✅ Fully Implemented for v0.1.0  
**Last Updated**: 2025-01-15  
**Maintainer**: AgentOS Core Team

