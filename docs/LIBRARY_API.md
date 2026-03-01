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
```

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

## Extensions

Extensions are runtime code packages (tools, guardrails, workflows) loaded from the curated registry (`@framers/agentos-extensions-registry`). Each extension's tools are added to the agent's tool map.

### Load by name

```ts
const app = await createWunderland({
  llm: { providerId: 'openai' },
  extensions: {
    tools: ['web-search', 'web-browser', 'giphy'],
    voice: ['voice-synthesis'],
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
});
```

- `toolFailureMode`:
  - `fail_open`: continue after tool failures.
  - `fail_closed`: halt on first tool failure.
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
