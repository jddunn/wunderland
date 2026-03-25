# Wunderland Library API (Golden Path)

Wunderland’s root import (`wunderland`) is the **library-first** API designed for embedding Wunderland in Node.js apps.

If you need lower-level modules (security, inference, social, jobs, etc.), use `wunderland/advanced/*`.

## Quick start (in-process chat)

```ts
import { createWunderland } from 'wunderland';

// Uses env defaults (OPENAI_API_KEY, OPENAI_MODEL, etc.)
const app = await createWunderland({ llm: { providerId: 'openai' } });

const session = app.session();
const out = await session.sendText('Hello!');

console.log(out.text);
console.log(await session.usage());
```

You can inspect durable usage totals at either level:

```ts
const appUsage = await app.usage();
const sessionUsage = await session.usage();
```

These totals come from the shared append-only usage ledger at `~/.framers/usage-ledger.jsonl` by default, so they survive across separate CLI commands and server processes. Set `AGENTOS_USAGE_LEDGER_PATH` or `WUNDERLAND_USAGE_LEDGER_PATH` when you want a different shared file, or pass an explicit config-dir override when you want Wunderland-specific isolation.

When the app is running from a config-backed agent directory, Wunderland also writes dated plain-text session logs under `./logs/YYYY-MM-DD/*.log` by default. Disable that with `observability.textLogs.enabled=false`, or move it with `observability.textLogs.directory`.

## Why Wunderland does not wrap AgentOS `agent()`

`@framers/agentos` now exposes streamlined helpers like `generateText()`, `streamText()`, and `agent()` for lightweight app embedding.

Wunderland intentionally keeps `createWunderland()` as its golden path because it layers additional runtime features on top:

- curated tool loading
- skills injection and discovery indexing
- capability discovery and narrowed per-turn tool exposure
- approvals and adaptive execution policy
- extension loading, workspace policy, and preset-driven configuration

So Wunderland should document the AgentOS high-level API, but it should not replace `createWunderland()` with `agent()` unless the helper reaches feature parity with Wunderland’s runtime needs.

## Orchestration

Author graphs with the AgentOS builders exposed at `wunderland/workflows`, then execute them through Wunderland with `app.runGraph(...)` or `app.streamGraph(...)`.

```ts
import { createWunderland } from 'wunderland';
import { workflow } from 'wunderland/workflows';

const app = await createWunderland({
  llm: { providerId: 'openai' },
  tools: 'curated',
});

const compiled = workflow('content-pipeline')
  .input({
    type: 'object',
    required: ['topic'],
    properties: { topic: { type: 'string' } },
  })
  .returns({
    type: 'object',
    properties: { finalSummary: { type: 'string' } },
  })
  .step('research', {
    gmi: {
      instructions: 'Research the topic and return JSON like {"scratch":{"research":{...}}}.',
    },
  })
  .then('judge', {
    gmi: {
      instructions: 'Return JSON like {"scratch":{"judge":{"score":8,"verdict":"ship","reasoning":"..."}}}.',
    },
  })
  .compile();

const result = await app.runGraph(compiled, { topic: 'AgentOS orchestration' });
console.log(result);
```

Use these layers intentionally:

- `workflow()` for deterministic DAGs and explicit step order
- `AgentGraph` for loops, routers, and custom graph control
- `mission()` for planner-driven orchestration that still compiles to the same graph IR

Judge pattern:

- Keep judge outputs structured in `scratch.judge`
- Branch on `state.scratch.judge.score` or `state.scratch.judge.verdict`
- Prefer concise rationale fields, not requests for raw hidden chain-of-thought

## Tools

### No tools (default)

```ts
const app = await createWunderland({ llm: { providerId: 'openai' }, tools: 'none' });
```

### Curated tools

```ts
import { createWunderland } from 'wunderland';

const app = await createWunderland({
  llm: { providerId: 'openai' },
  tools: 'curated',
});
```

### Custom tools

Provide AgentOS `ITool` instances:

```ts
import { createWunderland } from 'wunderland';
import type { ITool } from '@framers/agentos';

const echoTool: ITool = {
  id: 'demo.echo',
  name: 'echo',
  displayName: 'Echo',
  description: 'Echo back the provided text',
  inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  hasSideEffects: false,
  async execute(args) {
    return { success: true, output: { text: String((args as any).text ?? '') } };
  },
};

const app = await createWunderland({
  llm: { providerId: 'openai' },
  tools: { custom: [echoTool] },
});
```

## Skills

Skills are prompt-level modules (`SKILL.md`) that teach an agent _when_ and _how_ to use tools. They're loaded from the curated registry (`@framers/agentos-skills-registry`) and injected into the system prompt.

### Load by name

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  skills: ['github', 'web-search', 'summarize'],
});
```

### Load all curated skills

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  skills: 'all',
});
```

### Load from directories + names

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  skills: {
    names: ['github', 'coding-agent'],
    dirs: ['./my-custom-skills'],
    includeDefaults: true,  // also scan ./skills/, ~/.codex/skills/
  },
});
```

Skills are indexed by the Capability Discovery Engine alongside tools, enabling semantic search across all capabilities.

### Discovery recall profiles

By default, Wunderland uses **aggressive** discovery recall (higher TopK and token budgets) and narrows per-turn tool schemas to discovered capabilities.

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  discovery: {
    recallProfile: 'aggressive', // default
    // recallProfile: 'balanced',
    // recallProfile: 'precision',
  },
});
```

## Tool function-name compatibility (OpenAI-safe)

OpenAI-compatible tool calling requires `function.name` to match `^[a-zA-Z0-9_-]+$`.

Wunderland now normalizes outbound tool function names automatically:
- Canonical names are derived from loaded tool map keys.
- Non-compliant names are sanitized and collision-resolved deterministically.
- Tool calls are mapped back to original tool instances before execution.

Enable fail-fast strict mode when you want CI/release-time enforcement:

```ts
const app = await createWunderland({
  agentConfig: {
    toolCalling: {
      strictToolNames: true,
    },
  },
});
```

Environment override:

```bash
WUNDERLAND_STRICT_TOOL_NAMES=true
```

In strict mode, runtime startup/turn execution fails if rewrites or collisions are required.

## Extensions

Extensions are runtime code packages (tools, guardrails, workflows) loaded from the curated registry (`@framers/agentos-extensions-registry`). Each extension's tools are added to the agent's tool map.

### Load by name

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  extensions: {
    tools: ['web-search', 'web-browser', 'giphy'],
    voice: ['speech-runtime'],
  },
});
```

Extensions require their respective API keys to be set in environment variables (e.g., `SERPER_API_KEY` for web-search).

### Combine with curated tools

Extensions merge with the `tools` option — they don't replace it:

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  tools: 'curated',
  extensions: { tools: ['deep-research', 'content-extraction'] },
});
```

## Presets

Presets auto-configure tools, skills, extensions, and personality in a single option. Eight presets are available: `research-assistant`, `customer-support`, `creative-writer`, `code-reviewer`, `data-analyst`, `security-auditor`, `devops-assistant`, `personal-assistant`.

### Use a preset

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  preset: 'research-assistant',
});
```

### Override preset defaults

Explicit `skills` and `extensions` merge with (and take precedence over) preset values:

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  preset: 'research-assistant',
  skills: ['github'],  // adds to preset's suggested skills
  extensions: { tools: ['content-extraction'] },  // adds to preset's extensions
});
```

## OAuth Authentication (OpenAI Subscription)

Use your ChatGPT Plus/Pro subscription instead of a separate API key. The `llm.getApiKey` option allows dynamic token resolution, which the OAuth system uses to transparently inject fresh tokens into every LLM request.

`apiKey` and `getApiKey` are resolved defensively at runtime:
- supports static strings, promise values, and lazy async resolvers
- rejects non-string/empty resolved values with clear errors
- prevents accidental `[object Promise]` authorization headers

### With `agentConfig` (reads from `agent.config.json`)

```ts
const app = await createWunderland({
  agentConfig: {
    llmProvider: 'openai',
    llmModel: 'gpt-4o',
    llmAuthMethod: 'oauth',  // triggers OAuth token resolution
  },
  tools: 'none',
});
```

When `llmAuthMethod: 'oauth'` is set, `createWunderland()` dynamically imports `@framers/agentos/auth`, instantiates an `OpenAIOAuthFlow` with a `FileTokenStore`, and wires `getApiKey` into the LLM provider config. No `OPENAI_API_KEY` env var is needed.

### With explicit `getApiKey`

```ts
import { OpenAIOAuthFlow, FileTokenStore } from '@framers/agentos/auth';

const flow = new OpenAIOAuthFlow({ tokenStore: new FileTokenStore() });

const app = await createWunderland({
  llm: {
    providerId: 'openai',
    apiKey: '',  // not used when getApiKey is set
    model: 'gpt-4o',
    getApiKey: () => flow.getAccessToken(),  // dynamic token
  },
});
```

### Provider support

Only OpenAI is currently supported for OAuth. Anthropic, Google, and other providers do not offer equivalent consumer OAuth flows — using session tokens from their consumer products violates their Terms of Service. The auth module uses generic `IOAuthFlow` / `IOAuthTokenStore` interfaces designed for future provider extensibility.

## Approvals (safe by default)

By default, Wunderland denies **side-effect** tools and auto-approves read-only tools:

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  approvals: { mode: 'deny-side-effects' },
});
```

### Fully autonomous (approve everything)

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  approvals: { mode: 'auto-all' },
});
```

### Custom approver (prompt your user, log, etc.)

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  approvals: {
    mode: 'custom',
    onRequest: async ({ tool, preview }) => {
      console.log('Approve tool?', tool.name, preview);
      return false; // decide in your app
    },
  },
});
```

## Adaptive Execution + Task Outcome Telemetry

`createWunderland()` supports rolling task-outcome KPI telemetry and adaptive runtime policy:

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  toolFailureMode: 'fail_open', // default
  taskOutcomeTelemetry: {
    enabled: true,
    scope: 'tenant_persona',
    rollingWindowSize: 100,
    persist: true,
    storage: { priority: ['better-sqlite3', 'sqljs'] },
  },
  adaptiveExecution: {
    enabled: true,
    minSamples: 5,
    minWeightedSuccessRate: 0.7,
    forceAllToolsWhenDegraded: true,
    forceFailOpenWhenDegraded: true,
  },
});
```

Per-turn overrides are available via `session.sendText()`:

```ts
const session = app.session('support-thread');
await session.sendText('Handle this request', {
  userId: 'user-123',
  tenantId: 'acme',
  toolFailureMode: 'fail_closed',
  toolSelectionMode: 'discovered', // or 'all'
});
```

- `toolFailureMode`:
  - `fail_open`: continue after tool failures.
  - `fail_closed`: halt on first tool failure.
- `toolSelectionMode`:
  - `discovered`: expose only discovery-selected tools for that turn (default when discovery results exist).
  - `all`: expose all loaded tools.
- If KPI is degraded, adaptive mode can force `discovered -> all` tool schema exposure and force fail-open unless the request explicitly pins `fail_closed`.

## Diagnostics

```ts
const diag = app.diagnostics();
console.log(diag.llm, diag.policy, diag.tools, diag.skills, diag.discovery);
```

The diagnostics object includes:
- `llm` — provider, model, API key status
- `policy` — security tier, permission set, tool access profile
- `tools` — loaded tools, dropped-by-policy list
- `skills` — loaded skill count and names
- `discovery` — capability count, graph edges, initialization status

## Advanced modules

Examples:

```ts
import { SECURITY_TIERS } from 'wunderland/advanced/security';
import { WonderlandNetwork } from 'wunderland/advanced/social';
```

### TypeScript note

If you import subpath exports like `wunderland/advanced/*`, ensure your app’s `tsconfig.json` uses a modern resolver that understands `package.json#exports`:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"
  }
}
```

(`node16` / `nodenext` also work.)
