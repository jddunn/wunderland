# Voice Coding Assistant: Agent Development Guide

This document provides a comprehensive overview of the agent architecture within the Voice Coding Assistant application. It details how agents function as modular "miniapps," manage data, interact with LLMs (including tool usage), and how you can develop and integrate new agents.

## I. Agent Architecture: The "Miniapp" Concept

Agents in the Voice Coding Assistant are self-contained modules, each designed to provide a specialized set of functionalities or a unique user interaction mode. Think of each agent as a "miniapp" within the broader application.

### A. Core Components of an Agent

Each agent typically consists of the following key pieces, usually organized within its own directory (e.g., `frontend/src/components/agents/catalog/[AgentName]Agent/`):

1.  **Agent Definition (`IAgentDefinition` in `frontend/src/services/agent.service.ts`):**
    * This is the central registry entry for an agent. It's an object defining:
        * `id`: A unique `AgentId` (e.g., `'diary_agent'`, `'tutor_agent'`).
        * `label`: A human-readable name (e.g., "Echo Diary," "Professor Astra").
        * `description`: A brief explanation of the agent's purpose.
        * `systemPromptKey`: The filename (without extension) of the Markdown file in `/prompts/` (or fetched via backend) that contains the agent's primary instructions for the LLM (e.g., `'diary'`, `'tutor'`).
        * `component`: An async Vue component reference for the agent's main UI view (e.g., `() => import('@/components/agents/catalog/DiaryAgent/DiaryAgentView.vue')`).
        * `iconComponent`, `iconPath`, `avatar`: Visual representation for the agent.
        * `themeColor`, `holographicElement`: Optional theming hints.
        * `defaultVoicePersona`: Default TTS voice settings for the agent.
        * `capabilities`: Flags indicating what the agent can do (e.g., `canGenerateDiagrams`, `usesPersistentStorage`).
        * `inputPlaceholder`: Default placeholder text for the `VoiceInput` component when this agent is active.
        * `isDefault`, `isPublic`: Flags for default selection and public accessibility.

2.  **Main Agent View (`[AgentName]AgentView.vue`):**
    * The top-level Vue component that renders the agent's user interface.
    * Orchestrates child UI components specific to the agent.
    * Receives the agent's `IAgentDefinition` as a prop.
    * Uses the agent-specific composable for its logic and state.
    * Example: `DiaryAgentView.vue`, `TutorAgentView.vue`.

3.  **Composable (`use[AgentName]Agent.ts`):**
    * The heart of the agent, containing its core client-side logic, state management, and interactions.
    * Typically located in a subdirectory (e.g., `frontend/src/components/agents/catalog/[AgentName]Agent/[AgentName]/use[AgentName]Agent.ts`).
    * Manages all reactive state specific to the agent (e.g., list of diary entries, current quiz data).
    * Handles interactions with LLMs via `chatAPI` (from `utils/api.ts`).
    * For agents utilizing LLM function calling (tool usage), the composable is responsible for:
        * Interpreting `tool_calls` received in an assistant's message from the backend.
        * Orchestrating any necessary UI interactions based on the tool's arguments (e.g., displaying a quiz, showing a modal with LLM-generated suggestions).
        * Capturing the outcome or user input as the "tool result."
        * Sending this result back to the LLM via the `chatAPI` by constructing and dispatching a message with `role: "tool"`.
    * Interacts with agent-specific services (like `diary.service.ts`) for data persistence or specialized business logic if applicable.
    * Exposes reactive data and action functions to the main agent view.
    * Example: `useDiaryAgent.ts`, `useTutorAgent.ts`.

4.  **Type Definitions (`[AgentName]AgentTypes.ts`):**
    * A TypeScript file defining all interfaces, types, enums, and constants specific to the agent.
    * Typically located alongside the composable.
    * Includes types for the agent's data structures (e.g., `RichDiaryEntry`, `QuizItem`), state, computed properties, actions, and configuration.
    * Example: `DiaryAgentTypes.ts`, `TutorAgentTypes.ts`.

5.  **Child UI Components (`.vue` files in agent's subdirectory):**
    * Reusable UI pieces tailored for the agent's functionality.
    * Examples: `DiaryEntryListPanel.vue`, UI for displaying a quiz question, custom modals, input areas, etc.
    * These components should be presentation-focused, receiving data via props and emitting events for actions.

6.  **Agent-Specific Service (`[agentName].service.ts`, optional):**
    * If an agent requires dedicated client-side data persistence beyond simple key-value stores (e.g., `diary.service.ts`).
    * Uses the generic `localStorageService` for data storage.
    * Defines data models for storage and methods for CRUD operations.

### B. Agent Interaction Flow

1.  **Selection:** The user selects an agent.
2.  **Global State Update:** `agent.store.ts` updates `activeAgentId`.
3.  **Rendering:** The main application layout dynamically renders the `component` from the active `IAgentDefinition`.
4.  **Initialization:** The `[AgentName]AgentView.vue` mounts, and its `use[AgentName]Agent` composable is initialized (loading prompts, data, etc.).
5.  **User Interaction:** The user interacts with the agent's UI.
6.  **Logic & State Update:** The composable processes actions, updates its state, interacts with services or `chatAPI`. The UI re-renders reactively. This includes the tool-calling flow described in V.3.
7.  **Context Management:** `agent.store.ts` can hold temporary, cross-session context relevant to the active agent.

---

## II. Agent Definitions & Service (`agent.service.ts`)

The `frontend/src/services/agent.service.ts` file is central:

* **Registration:** It contains an `availableAgents` array of `IAgentDefinition` objects.
* **Retrieval:** Provides functions like `getAgentById()`, `getDefaultAgent()` for accessing agent configurations.
* **Dynamic Loading:** Agent view components are loaded asynchronously.

---

## III. State Management for Agents

1.  **Global Active Agent State (`agent.store.ts`):**
    * Tracks `_activeAgentId`.
    * Provides computed properties for the `activeAgent` definition.
    * Manages a generic `currentAgentContextInternal` for temporary agent-specific context.

2.  **Agent-Specific Internal State (within Agent Composables):**
    * Each `use[AgentName]Agent.ts` manages its own detailed reactive state (e.g., `allEntries`, `currentQuizItem`).

---

## IV. Data Persistence: Local Services & Memory

Agents can persist data client-side:

* **`localStorageService.ts`:** A generic utility for key-value storage using `localforage`.
* **Agent-Specific Services (e.g., `diary.service.ts`):**
    * For structured data needs (e.g., `diary.service.ts`).
    * Use `localStorageService` internally with a unique `NAMESPACE` for data isolation (e.g., `DIARY_NAMESPACE = 'diaryEntries_v1.3'`).

---

## V. LLM Interaction

Agents leverage LLMs via the backend.

1.  **System Prompts:**
    * Defined in Markdown files (e.g., `diary.md`, `tutor.md`), referenced by `systemPromptKey` in `IAgentDefinition`.
    * Fetched by the agent's composable (e.g., via `promptAPI.getPrompt()`).
    * Placeholders (e.g., `{{CURRENT_DATE}}`, `{{AGENT_CONTEXT_JSON}}`) are dynamically replaced.

2.  **API Calls (`chatAPI.sendMessage`):**
    * The frontend sends requests to the backend `/api/chat` endpoint.
    * The agent's composable constructs a `ChatMessagePayloadFE`, including the system prompt, user messages, history, `mode`, etc.

3.  **Function Calling / Tool Usage (Client-Heavy V1 Orchestration):**
    * This describes the V1 approach where the frontend plays a significant role in orchestrating the tool-use flow after the LLM indicates a tool needs to be called.
    * **1. LLM Decides to Use a Tool:**
        * The frontend sends a user message to the backend `/chat` API.
        * The backend, interacting with the LLM, provides the LLM with definitions of tools available to the current agent (this is assumed to be handled by backend logic, e.g., `LlmConfigService`).
        * If the LLM decides to use one or more tools, the backend's response to the frontend will indicate this. This typically comes as an assistant message (`ChatResponseDataFE`) containing a `tool_calls` array (each item having a `tool_call_id`, `function.name`, and `function.arguments`) or as a `FunctionCallResponseDataFE` if the primary response is the function call itself.
    * **2. Frontend Processes `tool_calls`:**
        * The agent's composable (e.g., in its `_processLLMResponse` function) receives and parses these `tool_calls`.
        * For each tool call, it extracts the `tool_call_id`, `function.name`, and `function.arguments` (which is a JSON string).
    * **3. Frontend Handles Tool "Execution" (from a UI/Interaction Perspective):**
        * **Generative Tools (e.g., `suggestDiaryMetadata` for Diary Agent):**
            * The `arguments` received from the LLM (e.g., suggested title, tags, mood, summary) are often the direct "output" or result of the tool's generative purpose.
            * The frontend composable uses these arguments to update its internal state and the UI (e.g., populating fields in a modal for user review and confirmation).
            * The "tool result" for the LLM is then the user-confirmed (and possibly edited) data.
        * **UI-Interactive Tools (e.g., `createQuizItem` for Tutor Agent):**
            * The `arguments` (e.g., quiz question, options, correct answer index, explanation) are used by the frontend to render an interactive UI element (like a quiz form).
            * The user's interaction with this UI (e.g., selecting an answer, submitting the form) is captured.
            * This captured user interaction becomes the "tool result."
    * **4. Frontend Sends Tool Result(s) Back to LLM:**
        * Once the tool's output is determined on the frontend, the composable constructs one or more new `ChatMessageFE` objects. Each of these messages has:
            * `role: "tool"`
            * `tool_call_id`: The ID from the LLM's original `tool_calls` request that this result corresponds to.
            * `name`: The name of the function that was called (e.g., `suggestDiaryMetadata`, `createQuizItem`).
            * `content`: A JSON string representing the output of the tool (e.g., `"{ \"title\": \"Final Title\", ... }"` for diary metadata, or `"{ \"userAnswerIndex\": 1, \"isCorrect\": true }"` for a quiz item).
        * These "tool" messages are then sent back to the backend `/chat` API, typically in a new call to `chatAPI.sendMessage`. This call must include the up-to-date conversation history, which now includes the assistant message that requested the `tool_calls` and these new `role: "tool"` messages.
    * **5. LLM Continues:**
        * The backend passes these tool results to the LLM.
        * The LLM processes the tool outputs and generates the next assistant message (a textual response), which is then sent back to the frontend.
    * **Note:** This client-side orchestration of tool interactions and results is characteristic of the V1 "client-heavy" approach. Future backend iterations might internalize more of the actual tool execution logic.

---

## VI. Creating a New Agent 🚀

1.  **Define Agent Concept & Scope:**
    * **Purpose & Functionalities.**
    * **Agent ID** (e.g., `code_reviewer_agent`, snake\_case).
    * **Label** (e.g., "Code Reviewer").

2.  **Create Agent-Specific Types (`.../[NewAgentName]Types.ts`):**
    * Data structures (e.g., `CodeReviewSession`), State, Computeds, Actions (`[NewAgentName]Composable`), Config.
    * If using LLM function calls, define types for tool arguments and outputs.

3.  **Implement the Core Logic Composable (`.../use[NewAgentName]Agent.ts`):**
    * Implement `[NewAgentName]Composable`.
    * Initialize reactive state.
    * Implement actions:
        * `initialize()`: Fetch system prompt, load persisted data.
        * `cleanup()`: Perform cleanup.
        * **LLM interaction functions:** (`_callNewAgentLLM`, `_processLLMResponse`):
            * Manage communication with `chatAPI`.
            * Handle `TextResponseDataFE` and `FunctionCallResponseDataFE` (which might contain `tool_calls`).
            * If `tool_calls` are received:
                * Parse `tool_call_id`, `function.name`, and `function.arguments`.
                * Update state to drive UI for the tool (e.g., show a modal, render a quiz).
                * Capture user interaction or confirmed data as the tool's output.
                * Construct and send a `role: "tool"` message back to `chatAPI` with the `tool_call_id` and stringified tool output.
        * Service interaction functions for data CRUD.
    * Implement computed properties.

4.  **Develop UI Components (`.../[ChildComponent].vue`):**
    * Create presentational child components.

5.  **Create the Main Agent View (`.../[NewAgentName]AgentView.vue`):**
    * Top-level component for the agent.
    * Props: `agentId: AgentId`, `agentConfig: IAgentDefinition`.
    * Script: Use your `use[NewAgentName]Agent` composable. Implement event handlers delegating to composable actions. Call `initialize()` on mount, `cleanup()` on unmount.
    * Template: Lay out UI, use child components.

6.  **Define System Prompt (`/prompts/[your_system_prompt_key].md`):**
    * Write LLM instructions, persona, output format, tool usage guidelines. Match `systemPromptKey`.

7.  **Register the Agent (`frontend/src/services/agent.service.ts`):**
    * Import the agent's main view component.
    * Add a new `IAgentDefinition` to `availableAgents`.

8.  **Styling & Theming:**
    * Integrate with the application's existing theming system.

---

## VII. Creating a New Service (e.g., `[newAgentName].service.ts`)

If your agent requires dedicated client-side data persistence:

1.  **Purpose & Scope.**
2.  **Location:** `frontend/src/services/`.
3.  **Data Model Interface(s)** for storage (e.g., `Storage[NewAgentName]Item`).
4.  **Use `localStorageService`:** Define a unique, versioned `NAMESPACE`.
5.  **Implement Service Class/Object** (CRUD methods, using the namespace).
6.  **Integration:** The agent's composable imports and uses this service.

---

## VIII. Theming and UI Consistency

* Integrate with existing themes (Sakura Sunset, Twilight Neo, etc.).
* Use HSL-based CSS variables.
* Leverage global utility classes and common UI patterns.

---

## IX. General Best Practices

* **Modularity:** Keep components/functions focused (for V1, primarily within the agent's composable).
* **Type Safety:** Use TypeScript rigorously.
* **Documentation (JSDoc):** Document files, classes, interfaces, types, functions, props.
* **Immutability:** Favor for state management where practical.
* **Error Handling:** Implement robust error handling. Use `toast` notifications.
* **Accessibility (a11y):** Design for accessibility.
* **Performance:** Be mindful of performance.

---

This guide reflects the V1 client-heavy architecture with frontend orchestration for LLM tool interactions. Adherence to these patterns will aid in developing a scalable and maintainable Voice Coding Assistant.