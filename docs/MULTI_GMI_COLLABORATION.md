# Multi-GMI Collaboration & Evolution Notes

> Working notes that sit alongside `docs/ARCHITECTURE.md`. Focus: coordinating multiple GMIs asynchronously inside a single Agency identity, evolving their roles, and doing it with the current AgentOS building blocks.

---

## 1. Objectives & Non-Goals
- Enable small Agencies (a handful of coordinated GMIs) to pursue a shared goal asynchronously while the host streams progress (`AgentOSResponseChunkType.WORKFLOW_UPDATE` in `packages/agentos/src/api/types/AgentOSResponse.ts:34`).
- Keep the conversational façade responsive so an Agency can appear as a single “assistant” even when multiple GMIs collaborate behind the scenes.
- Let persona personality and goals evolve mid-run using existing hooks (`TaskContext`, working memory, `metaPrompts`).
- Deliver the feature as a pack-friendly surface so extension bundles can ship new automation Agencies.
- Non-goal: build a full-blown agent society. The design targets up to five GMIs per Agency with host-managed guardrails.

## 2. Current Baseline
- **Single active GMI per session** - `GMIManager.getOrCreateGMIForSession` (packages/agentos/src/cognitive_substrate/GMIManager.ts:286) ties a session to one persona; switching personas destroys the existing instance.
- **Workflows exist but do not run** - `WorkflowDefinition` lives in `packages/agentos/src/core/workflows/WorkflowTypes.ts:77` and `AgentOS.startWorkflow` (packages/agentos/src/api/AgentOS.ts:917) persists instances, yet there is no executor loop (`WorkflowEngine.startWorkflow`, packages/agentos/src/core/workflows/WorkflowEngine.ts:182`).
- **Streaming already exposes workflow updates** - chunk type is present (`AgentOSResponseChunkType.WORKFLOW_UPDATE`, packages/agentos/src/api/types/AgentOSResponse.ts:156).
- **Agency snapshots stream alongside workflows** - `AgentOSResponseChunkType.AGENCY_UPDATE` surfaces roster changes so dashboards can show seat state in real time.
- **Personas are rich** - `IPersonaDefinition` includes mood, traits, and `metaPrompts`, but nothing mutates them during a session.
- **Launch quotas (optional)** - The reference backend enforces weekly limits via `agency_usage_log`; adjust or disable this logic for your own deployment.

Conclusion: we mostly need orchestration glue plus a place to store Agency state.

## 3. Proposed Core Concepts
### 3.1 Agency Session
Create a light `AgencySession` record:
- Stores `agencyId`, root `conversationId`, shared `goal`, and resolved `roleAssignments`.
- Keeps a roster mapping `roleId` to active `gmiInstanceId` so multiple GMIs can coexist for one session.
- Reuses `ConversationManager` but namespaces contexts (`conversationId:sessionId:roleId`) to hold per-seat and shared scratchpads.

### 3.2 Workflow-Driven Dispatch Loop
Add a `WorkflowRuntime` companion to the engine:
1. Subscribe to `WorkflowEngine.onEvent`.
2. When a task becomes `READY`, inspect `executor.type`.
   - `gmi`: ensure the role has an active GMI (spawn through `GMIManager`) and enqueue an internal `AgentOSInput` turn with the task payload.
   - `human`: mark the task as `AWAITING_INPUT` and emit a `WORKFLOW_UPDATE`.
   - `tool` or `extension`: call the relevant handler (either `ToolOrchestrator` or a pack-supplied executor).
3. On completion, capture outputs, advance dependents, and stream updates through the existing `StreamingManager`.

The runtime can run in-process for v1 and respect `WorkflowEngineConfig.maxConcurrentWorkflows`. Hosts that need stronger guarantees can swap in a job queue later.

### 3.3 Role & Goal Evolution
Attach evolution policies to roles:
- Extend `WorkflowRoleDefinition` with optional `evolution` rules (trigger plus patch directives for persona traits, preferred tools, or meta-prompts).
- When a task completes, evaluate rules (pure JSON policies or LLM-evaluated heuristics via `LLMUtilityAI`) and store the resulting overrides in a persona overlay.
- Persist overlays in `WorkflowInstance.metadata` so restarts replay the same state.

Persona overlays are applied when creating or updating a GMI, leaving the original persona JSON untouched.

## 4. API & Schema Touch Points
| Area | Proposed change |
|------|-----------------|
| `AgentOSInput` (`packages/agentos/src/api/types/AgentOSInput.ts:58`) | Optional `agencyRequest` block so a chat turn can create or join an Agency-backed workflow. |
| `AgentOSResponse` | Either extend the existing `WORKFLOW_UPDATE` payload or introduce `AGENCY_UPDATE` chunks that carry roster, goals, and per-seat state. |
| `WorkflowDefinition` | Allow `roles[*].personaId` or trait descriptors plus `roles[*].evolutionRules`. |
| `WorkflowTaskDefinition` | Add `handoff` metadata describing what context to pass to downstream executors. |
| Extension manifest | Support packs that bundle personas, tools, and workflows for Agency scenarios. |

All additions are optional, so existing definitions continue to work.

## 5. Execution Flow Example
**Use case:** "Ship a Nebula launch design doc" with three GMIs: Researcher, Architect, Scribe.

1. User triggers `workflowRequest.definitionId = 'nebula.discovery.v1'`.
2. Runtime creates an Agency, instantiates three GMIs, and schedules parallel tasks for Researcher and Architect.
3. As each task resolves, the runtime streams `WORKFLOW_UPDATE` chunks with status and outputs. The Scribe starts when both inputs are ready and composes the final document.
4. A role evolution rule notices the Architect repeatedly asking for clarity, adjusts its mood to "focused", and an `AGENCY_UPDATE` chunk reports the change.
5. The workflow completes, returning the document while leaving the Agency active for follow-up questions or tearing it down automatically. `AGENCY_UPDATE` chunks keep the UI in sync with seat status the whole time.

**Definition sketch**
```ts
export const nebulaDiscovery: WorkflowDescriptor = {
  id: 'nebula.discovery.v1',
  kind: EXTENSION_KIND_WORKFLOW,
  payload: {
    definition: {
      id: 'nebula_discovery',
      displayName: 'Nebula Discovery Agency',
      roles: [
        {
          roleId: 'researcher',
          displayName: 'Researcher',
          personaId: 'v_researcher',
          evolutionRules: [{ trigger: 'task_output.contains:niche', patch: { mood: 'curious' } }],
        },
        {
          roleId: 'architect',
          displayName: 'Systems Architect',
          personaId: 'systems_architect',
        },
        {
          roleId: 'scribe',
          displayName: 'Technical Writer',
          personaTraits: { tone: 'executive_summary', detailLevel: 'medium' },
        },
      ],
      tasks: [
        { id: 'collect_context', executor: { type: 'gmi', roleId: 'researcher' } },
        { id: 'architecture_outline', dependsOn: ['collect_context'], executor: { type: 'gmi', roleId: 'architect' } },
        { id: 'compose_doc', dependsOn: ['collect_context', 'architecture_outline'], executor: { type: 'gmi', roleId: 'scribe' } },
      ],
    },
  },
};
```

## 6. Personality & Goal Evolution Mechanics
1. Maintain a `PersonaStateOverlay` per role capturing applied patches (mood, prompt fragments, tool allowances).
2. Record overlays in the workflow instance metadata so the state survives restarts.
3. Feed overlays into GMI initialization and update flows (e.g., when a rule fires, call a `GMIManager.applyPersonaOverlay` helper).
4. Capture reasoning signals (`ReasoningTraceEntry` values) and guardrail outcomes to trigger evolution rules responsibly.
5. Share key findings through a dedicated Agency notebook so each GMI can pull context without polluting private working memory.

## 7. Implementation Roadmap
1. **Runtime foundation** - add `WorkflowRuntime`, update `GMIManager` to support multiple GMIs per session (key maps by `sessionId:roleId`), and expose a shutdown hook to clean Agencies.
2. **Schema & API** - extend workflow/response/input types, update TypeDoc, and add validation helpers.
3. **Evolution overlay** - implement rule evaluation, persona overlays, and persistence.
4. **Observability** - stream per-role stats, guardrail metadata, and expose a backend API to inspect Agencies.
5. **Packs & tests** - ship sample packs (code review duo, research triad) plus Vitest coverage for runtime orchestration and rule evaluation.

## 8. Open Questions
- Do we need a durable queue for long-running tasks or is in-process scheduling enough for v1?
- How do we allocate usage costs per role when billing and BYO keys are involved?
- Should persona overlays be persisted back to the persona catalogue or remain ephemeral?
- How do guardrails reconcile conflicting actions across multiple agents?
- What is the best UX for human approval steps (pause a task, adjust a persona, resume)?

---
These notes outline how to extend the current `@framers/agentos` runtime to support asynchronous multi-GMI Agencies without rewriting the core architecture. They should evolve into a formal spec once a prototype proves out the runtime loop.


