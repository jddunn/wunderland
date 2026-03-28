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

## Environment Variables Reference

```bash
# Provider API keys
OPENAI_API_KEY=sk-...                    # OpenAI
ANTHROPIC_API_KEY=sk-ant-...             # Anthropic (Claude)
GEMINI_API_KEY=AIza...                   # Google Gemini
OPENROUTER_API_KEY=sk-or-...             # OpenRouter

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
import { createWunderlandSeed } from 'wunderland';

// Provider is resolved from config/env automatically
const seed = createWunderlandSeed({
  seedId: 'my-agent',
  name: 'My Agent',
});

// Or specify explicitly via the server API
import { createWunderlandServer } from 'wunderland';

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
