# Workflow Engine & Automation Guide

AgentOS now exposes a workflow engine so hosts can define automations, task graphs, and multi-GMI collaborations without hard-coding orchestration logic. Workflows are delivered as extensions, enabling packs to bundle reusable automations alongside tools or guardrails.

---

## 1. Concepts

- **Workflow Definition** â€“ Declarative description of goals, roles, tasks, guardrail tags, and optional schemas.
- **Workflow Instance** â€“ Runtime state of a definition (status, assignments, task progress, linked conversation, metadata).
- **Task Graph** â€“ Directed acyclic graph of tasks with dependency edges, executors, retry policies, and output schemas.
- **Workflow Store** â€“ Pluggable persistence layer responsible for saving instances, tasks, and audit events.
- **Workflow Engine** â€“ Runtime that loads workflow descriptors from the extension registry, creates instances, coordinates progression, and emits streaming updates.
### Agency telemetry baked into workflow instances

- `WorkflowInstance.agencyState` now records a `WorkflowAgencySeatSnapshot` per role. Each snapshot includes the latest `gmiInstanceId`, persona assignment, metadata (e.g., last output preview, status), and a bounded seat history sourced from the `AgencyRegistry`.
- `WorkflowRuntime.syncWorkflowAgencyState` persists that structure so the workflow store can serve rich telemetry even if the client reconnects mid-run.
- The `WORKFLOW_UPDATE` payloads echo the same structure, enabling the Session Inspector, Workflow Overview, and backend exports to show per-seat progress without extra APIs.


---

## 2. Extension Descriptors

Workflow packs register descriptors through the extension manager, just like tools or guardrails.

```ts
import type { WorkflowDescriptor } from '@framers/agentos/extensions';
import { EXTENSION_KIND_WORKFLOW } from '@framers/agentos/extensions';

export const codeReviewWorkflow: WorkflowDescriptor = {
  id: 'workflow.code_review.v1',
  kind: EXTENSION_KIND_WORKFLOW,
  payload: {
    definition: {
      id: 'code_review',
      version: '1.0.0',
      displayName: 'Code Review',
      goalSchema: {/* JSON schema */},
      roles: [
        {
          roleId: 'reviewer',
          displayName: 'Reviewer',
          personaId: 'code_pilot',
          evolutionRules: [{ id: 'stay-focused', trigger: 'always', patch: { mood: 'focused' } }],
          personaCapabilityRequirements: ['code.review'],
        },
      ],
      tasks: [
        {
          id: 'analyze_diff',
          name: 'Analyze Diff',
          executor: { type: 'gmi', roleId: 'reviewer' },
          dependsOn: [],
          inputSchema: {/* JSON schema */},
          outputSchema: {/* JSON schema */},
          policyTags: ['guardrail.secure_outputs'],
          handoff: { summary: true },
        },
        // ...
      ],
      requiresConversationContext: false,
    },
    metadata: {
      pack: '@framers/automation-samples',
      documentationUrl: 'https://example.com/docs/code-review',
    },
  },
  priority: 0,
};
```

Descriptors may specify:
- `goalSchema` and `finalOutputSchema` (JSON Schema objects validated at runtime).
- `roles` with persona/tool capability requirements.
- Task-level `policyTags` to reuse guardrail stacks or permission policies.
- `requiresConversationContext` to indicate whether a conversation must exist before instantiation.
- `roles[*].personaId` / `personaTraits` and `roles[*].evolutionRules` so Agencies can adapt persona behaviour over time.
- `metadata.requiredSecrets` listing the secret IDs (API keys) a workflow depends on. AgentOS and the client workbench surface these requirements and block execution when the user has not provided the necessary keys.

---

## 3. Configuration Surface

Add workflow support through `AgentOSConfig` (TypeScript snippets assume the upcoming implementation exports the relevant properties):

```ts
const config: AgentOSConfig = {
  // ...existing fields...
  workflowEngineConfig: {
    maxConcurrentWorkflows: 32,
    defaultWorkflowTimeoutSeconds: 3600,
  },
  workflowStore: new InMemoryWorkflowStore(), // or injected adapter
  extensionManifest: {
    packs: [
      {
        identifier: 'automation.samples',
        factory: async () => import('@framers/automation-samples'),
      },
    ],
  },
};
```

Key pieces:

- **`workflowEngineConfig`** â€“ runtime knobs (concurrency, timeouts).
- **`workflowStore`** â€“ optional injected persistence adapter. Defaults to the in-memory implementation if omitted.
- **Extension registries** â€“ workflows share the extension manager and manifest alongside tools/guardrails, so `extensionOverrides` apply uniformly.

---

## 4. Storage Strategy

Workflows use the `IWorkflowStore` interface. Implementations provide:

- `createInstance`, `updateInstance`, `updateTasks`, `appendEvents`
- `listInstances`, `buildProgressUpdate`

AgentOS ships with:
- `InMemoryWorkflowStore` (default, zero dependencies)
- `PrismaWorkflowStore` (optional adapter with migrations under `packages/agentos-workflows-adapters/prisma`)

Hosts can implement their own stores (SQL, document DB, Redis) by respecting the interface.

Instances may link to conversations through `conversationId`, but the link is optional: tasks can originate from a conversation turn yet run entirely outside the chat loop.

---

## 5. Streaming & Telemetry

Workflow progress is surfaced via a new streaming chunk type:
- When a workflow carries `conversationId`, AgentOSOrchestrator automatically emits updates on the corresponding stream so clients stay in sync.

```ts
AgentOSResponseChunkType.WORKFLOW_UPDATE
```

Payloads include the current `WorkflowProgressUpdate` plus optional recent events so clients can render dashboards or notify users asynchronously. Guardrail metadata (`metadata.guardrail`) is preserved when workflows trigger output evaluations.

The workflow engine accepts an `ILogger` in its dependencies. It defaults to the global AgentOS logger, but hosts can inject namespaced loggers for dedicated telemetry or compliance pipelines.

---

## 6. Access Patterns

### Start a workflow

```ts
const definitions = agentos.listWorkflowDefinitions();

const instance = await agentos.startWorkflow(
  'code_review',
  agentOsInput, // original interaction input
  {
    workflowId: 'workflow-123',
    conversationId: 'session-123', // optional
    context: { repoUrl: 'https://github.com/wearetheframers/voice-chat-assistant', prNumber: 42 },
    roleAssignments: { reviewer: 'gmi-primary' },
  },
);
```


### Advance tasks

```ts
await agentos.applyWorkflowTaskUpdates(instance.workflow.workflowId, [
  { taskId: 'analyze_diff', status: 'completed', output: reviewNotes },
]);
```
Use `applyWorkflowTaskUpdates` to mark progress or surface task outputs; the engine schedules dependent tasks automatically based on the graph.

### Trigger from chat input

> **Tip:** Attach `agencyRequest` alongside `workflowRequest` when you want AgentOS to spin up or join a multi-seat Agency. Each participant entry can supply `roleId` + optional `personaId`.


Include `workflowRequest` in the `AgentOSInput` payload to launch workflows as part of a turn:

```ts
await agentos.processRequest({
  userId: 'user-1',
  sessionId: 'session-1',
  textInput: 'Launch the onboarding workflow',
  workflowRequest: {
    definitionId: 'customer_onboarding',
    context: { customerId: currentCustomerId },
  },
});
```

### Observe progress

- Subscribe to streaming updates (server-sent events / websockets).
- Inspect state directly:
  ```ts
  const active = await agentos.getWorkflow(instance.workflowId);
  const updates = await agentos.getWorkflowProgress(instance.workflowId, lastTimestamp);
  const openWorkflows = await agentos.listWorkflows({ conversationId: 'session-123' });
  ```

### REST endpoints

AgentOS exposes helper endpoints so hosts can drive workflows without touching the runtime directly:

```http
GET /agentos/workflows/definitions
```

Returns `{ definitions: WorkflowDefinition[] }` describing every descriptor loaded by the extension manager.

```http
POST /agentos/workflows/start
Content-Type: application/json

{
  "definitionId": "code_review",
  "userId": "frontend_user_123",
  "conversationId": "session-123",   // optional
  "workflowId": "workflow-123",      // optional
  "context": { "repoUrl": "https://example.com" }
}
```

Returns `{ workflow }` representing the new instance. The streaming API (`/agentos/stream`) then emits `WORKFLOW_UPDATE` chunks as the automation progresses.

The private console in the Voice Chat Assistant now includes a workflow launcher so authenticated users can choose a definition, start it, and monitor progress inline.

---

## 7. Guardrails & Policy

- Workflow definitions reference guardrail stacks via `policyTags`.
- Guardrail descriptors can specifically target workflow outputs or task-level actions.
- When multiple GMIs collaborate, guardrail metadata is appended to streaming chunks so hosts can audit combined decisions.

---

## 8. Authoring Guidelines

1. Keep task graphs acyclic and granularâ€”prefer smaller tasks with explicit dependencies.
2. Document assets: include instructions, metadata links, and guardrail expectations in the descriptor.
3. Provide Vitest coverage for pack descriptors (registration, schema validation, basic execution path).
4. Use the extension manifest to ship versioned packs (`@framers/agentos-pack-automation`) rather than embedding workflows directly in host code.

---

## 9. Roadmap

- Native scheduling hooks and cron-style triggers.
- Built-in escalations for human approval tasks.
- Richer dependency semantics (conditional branches, parallel joins).
- Telemetry exports (OpenTelemetry spans, metrics).
- Additional storage adapters (DynamoDB, Firestore, Redis streams).

Use this guide alongside `docs/ARCHITECTURE.md` and the API reference to integrate workflows safely. Contributions are welcomeâ€”see `packages/agentos/docs/CONTRIBUTING.md` for standards.


