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

## Diagnostics

```ts
const diag = app.diagnostics();
console.log(diag.llm, diag.policy, diag.tools);
```

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
