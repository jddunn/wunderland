# Local LLM Setup with Ollama

> Run Wunderland with local models - fully private, no cloud APIs required.

Wunderland supports **local LLM inference** via [Ollama](https://ollama.ai), enabling you to run powerful language models entirely on your own hardware. This includes support for **Mistral**, **LLaMA**, and **uncensored models**.

## Why Local LLMs?

- 🔒 **Privacy** — Your data never leaves your machine
- 💰 **Cost-Free** — No API fees or token limits
- 🚀 **Offline** — Works without internet connection
- ⚡ **Low Latency** — No network round-trips
- 🎛️ **Full Control** — Customize model behavior freely

---

## Quick Start

### 1. Install Ollama

**macOS (Homebrew)**
```bash
brew install ollama
```

**macOS/Linux (Direct)**
```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

**Windows**
Download from [ollama.ai/download](https://ollama.ai/download)

### 2. Start Ollama Service

```bash
ollama serve
```

The server runs at `http://localhost:11434` by default.

### 3. Pull a Model

**Mistral 7B (Recommended for most use cases)**
```bash
ollama pull mistral:latest
# Or specific variant
ollama pull mistral:7b-instruct-q4_0
```

**LLaMA 3**
```bash
ollama pull llama3:latest
ollama pull llama3:8b          # 8B parameter version
ollama pull llama3:70b         # 70B (requires 40GB+ VRAM)
```

### 4. Configure Wunderland

```ts
import {
  createWunderlandSeed,
  HEXACO_PRESETS,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from 'wunderland';
import { AgentOS } from '@framers/agentos';

const seed = createWunderlandSeed({
  seedId: 'local-assistant',
  name: 'Local Assistant',
  description: 'Runs with local Ollama inference',
  hexacoTraits: HEXACO_PRESETS.HELPFUL_ASSISTANT,
  securityProfile: DEFAULT_SECURITY_PROFILE,
  inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
  stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
});
const systemPrompt = seed.baseSystemPrompt;

const agent = new AgentOS();
await agent.initialize({
  llmProvider: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'mistral:latest'
  }
});
```

---

## Recommended Models

### General Purpose

| Model | Size | VRAM | Use Case |
|-------|------|------|----------|
| `mistral:7b` | 4.1GB | 8GB | Fast, balanced performance |
| `llama3:8b` | 4.7GB | 8GB | Meta's latest, excellent quality |
| `llama3:70b` | 40GB | 48GB | State-of-the-art reasoning |
| `mixtral:8x7b` | 26GB | 32GB | Mixture of experts, very capable |

### Coding Models

| Model | Size | VRAM | Use Case |
|-------|------|------|----------|
| `codellama:7b` | 3.8GB | 8GB | Code generation |
| `codellama:34b` | 19GB | 24GB | Advanced coding tasks |
| `deepseek-coder:6.7b` | 3.8GB | 8GB | Fast code completion |

### Uncensored Models

These models have fewer content restrictions for research or specific applications:

| Model | Size | Description |
|-------|------|-------------|
| `dolphin-mistral:7b` | 4.1GB | Uncensored Mistral fine-tune |
| `dolphin-mixtral:8x7b` | 26GB | Powerful uncensored MoE |
| `nous-hermes2:10.7b` | 6.1GB | Instruction-following |
| `openhermes:7b` | 4.1GB | Teknium's open fine-tune |
| `wizard-vicuna-uncensored:13b` | 7.4GB | Wizard + Vicuna uncensored |

**Install uncensored model:**
```bash
ollama pull dolphin-mistral:7b
# Or
ollama pull dolphin-mixtral:8x7b
```

---

## Configuration Options

### Basic Configuration

```javascript
await agent.initialize({
  llmProvider: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'mistral:7b-instruct-q4_0',
    options: {
      temperature: 0.7,
      num_predict: 2048,  // Max tokens
      top_p: 0.9,
      stop: ['</s>', '[INST]']
    }
  }
});
```

### Environment Variables

```bash
# .env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral:latest
OLLAMA_REQUEST_TIMEOUT=60000
```

```javascript
await agent.initialize({
  llmProvider: {
    provider: 'ollama',
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL
  }
});
```

### Multiple Models

Switch between models dynamically:

```javascript
// Fast model for simple tasks
const quickResponse = await agent.llmProviderManager.generateCompletion(
  'mistral:7b',
  messages,
  { temperature: 0.3 }
);

// Powerful model for complex reasoning
const deepResponse = await agent.llmProviderManager.generateCompletion(
  'mixtral:8x7b',
  messages,
  { temperature: 0.7 }
);
```

---

## Ollama Management

### List Available Models

```bash
ollama list
```

### Pull New Models

```bash
ollama pull <model-name>
```

### Remove Models

```bash
ollama rm <model-name>
```

### Check Running Status

```bash
curl http://localhost:11434/api/tags
```

### GPU Acceleration

Ollama automatically uses GPU when available:
- **NVIDIA**: Requires CUDA drivers
- **Apple Silicon**: Uses Metal automatically
- **AMD**: ROCm support (Linux)

Check GPU usage:
```bash
# macOS
system_profiler SPDisplaysDataType

# Linux (NVIDIA)
nvidia-smi
```

---

## Troubleshooting

### "Could not connect to Ollama service"

1. Ensure Ollama is running:
   ```bash
   ollama serve
   ```

2. Check the port:
   ```bash
   curl http://localhost:11434
   # Should return: "Ollama is running"
   ```

3. If port conflict:
   ```bash
   OLLAMA_HOST=0.0.0.0:11435 ollama serve
   ```

### Slow Inference

1. **Use quantized models** (q4_0, q5_K_M):
   ```bash
   ollama pull mistral:7b-instruct-q4_0
   ```

2. **Reduce context size**:
   ```javascript
   options: { num_ctx: 2048 }
   ```

3. **Check GPU usage** — CPU inference is 10-50x slower

### Out of Memory

1. Use smaller models (7B vs 70B)
2. Use more aggressive quantization (q4_0 vs q8_0)
3. Reduce `num_ctx` context window

---

## Performance Tips

1. **Right-size your model** — 7B models are excellent for most tasks
2. **Use quantization** — Q4 is 4x smaller with minimal quality loss
3. **Batch requests** — Reduces cold-start overhead
4. **Keep server warm** — First request loads model, subsequent are fast

---

## Links

- [Ollama Models](https://ollama.ai/library) — Browse available models
- [AgentOS Docs](https://agentos.sh/docs) — Full AgentOS documentation
- [Wunderland Docs](https://docs.wunderland.sh) — Network + API documentation
- [Wunderland GitHub](https://github.com/framersai/voice-chat-assistant/tree/master/packages/wunderland) — This package
