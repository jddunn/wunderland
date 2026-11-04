# LLM Provider Setup

> Configure any of 5 supported tool-calling LLM providers: OpenAI, Anthropic, Google Gemini, Ollama (local), or OpenRouter.

Wunderland's CLI and SDK support multiple LLM providers out of the box. This guide covers setup for each.

---

## Quick Start

```bash
# Interactive — walks you through provider selection and API keys
wunderland init my-agent

# Or specify directly
wunderland init my-agent --provider openai
wunderland init my-agent --provider anthropic
wunderland init my-agent --provider gemini
wunderland init my-agent --provider ollama
wunderland init my-agent --provider openrouter
```

---

## Supported Providers

| Provider | ID | Auth | Default Model | Endpoint |
|----------|-----|------|---------------|----------|
| OpenAI | `openai` | API key or OAuth | `gpt-4o` | `api.openai.com` |
| Anthropic | `anthropic` | API key | `claude-sonnet-4-6` | `api.anthropic.com` |
| Google Gemini | `gemini` | API key | `gemini-2.0-flash` | `generativelanguage.googleapis.com` |
| Ollama | `ollama` | None | Auto-detected | `localhost:11434` (or remote) |
| OpenRouter | `openrouter` | API key | `auto` | `openrouter.ai` |

---

## OpenAI

### Get an API Key

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new secret key
3. Copy the key (starts with `sk-`)

### Configure

```bash
export OPENAI_API_KEY=sk-...
wunderland init my-agent --provider openai --model gpt-4o
```

Or during setup, paste the key when prompted.

### Models

| Model | Best For |
|-------|----------|
| `gpt-4o` | General purpose, tool calling (recommended) |
| `gpt-4o-mini` | Fast, cost-effective |
| `gpt-4-turbo` | Long context, complex reasoning |
| `o1` | Advanced reasoning, chain-of-thought |
| `o3-mini` | Reasoning at lower cost |

### OAuth (ChatGPT Subscription)

If you have a ChatGPT Plus/Pro subscription instead of an API key:

```bash
wunderland init my-agent --provider openai --oauth
wunderland login   # authenticate with your subscription
```

---

## Anthropic (Claude)

### Get an API Key

1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new API key
3. Copy the key (starts with `sk-ant-`)

### Configure

```bash
export ANTHROPIC_API_KEY=sk-ant-...
wunderland init my-agent --provider anthropic --model claude-sonnet-4-6
```

### Models

| Model | Best For |
|-------|----------|
| `claude-opus-4-6` | Maximum capability |
| `claude-sonnet-4-6` | Balanced performance (recommended) |
| `claude-haiku-4-5-20251001` | Fast, cost-effective |

### How It Works

Anthropic is called natively via the Messages API (`api.anthropic.com/v1/messages`), not through an OpenAI-compatible proxy. Tool calling, streaming, and all features work natively.

---

## Google Gemini

### Get an API Key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Create an API key
3. Copy the key (starts with `AIza`)

### Configure

```bash
export GEMINI_API_KEY=AIza...
wunderland init my-agent --provider gemini --model gemini-2.0-flash
```

### Models

| Model | Best For |
|-------|----------|
| `gemini-2.0-flash` | Fast, multimodal (recommended) |
| `gemini-2.5-pro` | Advanced reasoning |
| `gemini-2.5-flash` | Balanced speed/quality |

### How It Works

Gemini uses Google's OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai/`), so tool calling and standard features work seamlessly.

---

## Ollama (Local Inference)

Run models entirely on your machine. No API keys, no data leaves your system.

### Quick Setup

```bash
wunderland ollama-setup
```

This auto-detects your hardware, installs Ollama, recommends models, and configures everything.

### Manual Setup

```bash
# Install
brew install ollama          # macOS
curl -fsSL https://ollama.ai/install.sh | sh   # Linux
winget install Ollama.Ollama # Windows

# Start and pull a model
ollama serve
ollama pull dolphin-llama3:8b

# Configure
wunderland init my-agent --provider ollama --model dolphin-llama3:8b
```

### Remote Ollama

Ollama can run on a remote server:

```bash
export OLLAMA_BASE_URL=https://ollama.myserver.com
wunderland start
```

For the full guide, see [Local LLM Setup](./LOCAL_LLM_SETUP.md).

---

## OpenRouter (Unified Gateway)

Access 200+ models from all providers through a single API key with automatic fallback.

### Get an API Key

1. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
2. Create a key
3. Copy the key (starts with `sk-or-`)

### Configure

```bash
export OPENROUTER_API_KEY=sk-or-...
wunderland init my-agent --provider openrouter --model auto
```

### As Fallback

OpenRouter can be configured as an automatic fallback for your primary provider. If your primary provider fails, OpenRouter transparently retries:

```bash
export OPENAI_API_KEY=sk-...           # primary
export OPENROUTER_API_KEY=sk-or-...    # automatic fallback
wunderland start --provider openai     # uses OpenRouter if OpenAI fails
```

---

## Multi-Provider Setup

The `wunderland setup` wizard supports configuring multiple providers at once:

```bash
wunderland setup
# Select multiple providers when prompted
# Enter API keys for each
# Choose a default provider
```

Your keys are stored in `~/.wunderland/.env` and all configured providers are available.

---

## Provider base URLs

`wunderland start` sends its calls to OpenAI, Anthropic and OpenRouter to the URL in that provider's base-URL variable, so a proxy or gateway in front of the provider sees each call the list below names. With a variable unset or blank, the calls go to the provider's own endpoint.

```bash
export OPENAI_BASE_URL=https://gateway.example.com/openai/v1
export ANTHROPIC_BASE_URL=https://gateway.example.com/anthropic
export OPENROUTER_BASE_URL=https://gateway.example.com/openrouter/api/v1
wunderland start
```

| Variable | Unset, the calls go to | What the value names |
|----------|------------------------|----------------------|
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | The API root, as OpenAI's SDK reads it |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | The host root, as Anthropic's SDK reads it. Wunderland adds `/v1`, and a value that already ends in `/v1` keeps one |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | The API root |

Wunderland ignores spaces around a value and trailing slashes; the LLM judge, which AgentOS runs, reads the value as set, so give it without them. Every Anthropic request wunderland makes joins the value and the path with one helper (`anthropicApiUrl` in `src/platform/config/provider-base-urls.ts`), so `https://gateway.example.com/anthropic`, `https://gateway.example.com/anthropic/v1` and either with a trailing slash all reach `https://gateway.example.com/anthropic/v1/messages`.

The calls that follow the variables:

- **The primary provider's turns**: a `/chat` request, a channel message, and the turn a webhook in `agent.config.json` `webhooks` wakes (`mode: "turn"`). Anthropic's go to `<ANTHROPIC_BASE_URL>/v1/messages`, OpenAI's and OpenRouter's to `<base>/chat/completions`.
- **The fallback chain.** Each candidate goes to its own provider's variable. The Anthropic candidate uses Anthropic's OpenAI-compatible endpoint, `<ANTHROPIC_BASE_URL>/v1/chat/completions`. The `/chat` route and the webhook turn fall back for every primary; a channel message falls back only for an OpenAI primary.
- **The research classifier** that picks a chat request's research depth. It goes to the primary provider's base URL (`<base>/chat/completions`); an Anthropic primary's uses Anthropic's OpenAI-compatible endpoint with `claude-haiku-4-5-20251001`.
- **The local `memory_read` tool.** Query embeddings go to `<OPENAI_BASE_URL>/embeddings` with `OPENAI_API_KEY`; the HyDE hypothesis call goes to the primary provider's base URL.
- **The knowledge bootstrap** (the `knowledge/*.md` files seeded on start). Embeddings go to `<OPENAI_BASE_URL>/embeddings` with `OPENAI_API_KEY`.
- **The Discord welcome and curated picks posts** (`feeds.channels.welcome`, and the curated picks channel). Both use `OPENAI_API_KEY` and `gpt-4o`, so both go to `<OPENAI_BASE_URL>/chat/completions` whatever the primary provider is.
- **The capability discovery index.** An OpenAI or Anthropic primary embeds through OpenAI at `OPENAI_BASE_URL`; an OpenRouter primary embeds at `OPENROUTER_BASE_URL`. A `discovery.embeddingProvider` other than the primary provider embeds with that provider's own key and variable: `openai` with `OPENAI_API_KEY` at `OPENAI_BASE_URL`, `openrouter` with `OPENROUTER_API_KEY` at `OPENROUTER_BASE_URL`. With that key unset, the index is not built.
- **The LLM judge** (`hitl.mode: "llm-judge"`) with `judgeProvider` set to `openai` or `openrouter`. AgentOS reads those two variables itself.

Outside `start`, `wunderland mission` (the planner's `--planner-model` and `--execution-model` providers and its runtime default) and the Anthropic requests of `create`, `batch-create`, `spawn`, `agency`, `models` and `dashboard` read the same variables through the same helpers.

Calls that do not follow the variables:

- **An `anthropic` LLM judge** goes to `https://api.anthropic.com` whatever `ANTHROPIC_BASE_URL` says, because AgentOS's judge takes no base URL.
- **Tools from extension packs** make their own requests with their own settings; this section does not cover them.
- **Gemini and Ollama** have no base-URL variable here: Gemini's calls go to `https://generativelanguage.googleapis.com/v1beta/openai`, Ollama's to `OLLAMA_BASE_URL`.

### Operation id across retries

With `AGENTOS_OPERATION_ID_HEADER` naming a header, each provider request wunderland sends itself carries an operation id in that header, so a gateway can tell a retry of one call from a new call:

```bash
export AGENTOS_OPERATION_ID_HEADER=x-operation-id
```

- The id is a UUID made before a call's first attempt. When the primary attempt fails and the call goes to the fallback candidate, the fallback attempt sends the same id.
- The next call gets a new id: each turn round, each embedding request (each knowledge-bootstrap batch), the HyDE call, the research classifier, and the welcome, curated picks judge and curated picks copy requests.
- With the variable unset or blank, no header is sent.
- A value that is not an HTTP header name, or that names a header the requests set themselves (`Authorization`, `x-api-key`, `Content-Type`, `anthropic-version`, ...), stops `start` with an error before any request.

The requests that carry it: the primary provider's turns and their fallback attempts, the research classifier, the `memory_read` embedding and HyDE call, the knowledge bootstrap, and the Discord welcome and curated picks requests. The discovery index's embeddings and the LLM judge go through AgentOS's providers, which read the same variable in an AgentOS release that has the operation id option; with an older AgentOS they send no header.

### A used-up allowance

A gateway that meters an agent's model use answers a call past the agent's allowance with a 402 and this `error.code`:

```json
{ "error": { "code": "allowance_exhausted" } }
```

The turn ends there, with no retry and no request to the fallback chain, since the fallback goes through the same gateway and draws on the same allowance. The reply is what the model gave so far, then this line, or the line alone when the model gave nothing:

```text
This agent has reached its monthly model allowance.
```

- A channel gets the reply as a message, `POST /chat` answers 200 with it, and a webhook's turn is not recorded as a failure. The session's history ends with the reply.
- What the model gave so far passes the same output check a finished reply does. When the check blocks it, the line goes alone.
- Each such turn writes one warning line.
- A 402 with any other code, and any other status with that code, stays an ordinary provider error.
- With [hosted events](OBSERVABILITY.md#hosted-events) on, the turn reports `provider_error` with code `402`, then `turn_finished`.

---

## Environment Variables Reference

```bash
# Provider API keys
OPENAI_API_KEY=sk-...                    # OpenAI
ANTHROPIC_API_KEY=sk-ant-...             # Anthropic (Claude)
GEMINI_API_KEY=AIza...                   # Google Gemini
OPENROUTER_API_KEY=sk-or-...             # OpenRouter

# Provider base URLs (see Provider base URLs)
OPENAI_BASE_URL=https://api.openai.com/v1      # OpenAI API root
ANTHROPIC_BASE_URL=https://api.anthropic.com   # Anthropic host root
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
AGENTOS_OPERATION_ID_HEADER=x-operation-id     # Optional: header for the operation id

# Ollama
OLLAMA_BASE_URL=http://localhost:11434   # Ollama server URL (local or remote)
OLLAMA_MODEL=dolphin-llama3:8b           # Default Ollama model
OLLAMA_REQUEST_TIMEOUT_MS=60000          # Request timeout

# Model override (any provider)
OPENAI_MODEL=gpt-4o                      # Override default model
```

---

## Config File Reference

`~/.wunderland/config.json`:
```json
{
  "llmProvider": "openai",
  "llmModel": "gpt-4o",
  "llmAuthMethod": "api-key",
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "numCtx": 4096,
    "numGpu": -1
  }
}
```

`agent.config.json` (per-agent):
```json
{
  "llmProvider": "anthropic",
  "llmModel": "claude-sonnet-4-6"
}
```

---

## Programmatic API

```typescript
import { createWunderlandSeed } from 'wunderland/seed';

// Provider is resolved from config/env automatically
const seed = createWunderlandSeed({
  seedId: 'my-agent',
  name: 'My Agent',
});

// Or specify explicitly via the server API
import { createWunderlandServer } from 'wunderland/api';

const server = await createWunderlandServer({
  seedId: 'my-agent',
  llm: {
    providerId: 'gemini',
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-2.0-flash',
  },
});
```

---

## Troubleshooting

### "No API key found"

Set the appropriate environment variable for your provider. Check with:
```bash
echo $OPENAI_API_KEY
echo $ANTHROPIC_API_KEY
echo $GEMINI_API_KEY
```

### "Unsupported LLM provider"

Supported values: `openai`, `anthropic`, `gemini`, `ollama`, `openrouter`.

### Provider-Specific Issues

- **OpenAI 429 (rate limit)**: Set `OPENROUTER_API_KEY` as a fallback
- **Anthropic 401**: Ensure key starts with `sk-ant-` and has valid credits
- **Gemini 403**: Check API key permissions in Google Cloud console
- **Ollama connection refused**: Run `ollama serve` or check `OLLAMA_BASE_URL`
- **OpenRouter timeout**: Try specifying a model instead of `auto`
