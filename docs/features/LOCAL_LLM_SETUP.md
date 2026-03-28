# Local LLM Setup with Ollama

> Run Wunderland with local models - fully private, no cloud APIs required.

Wunderland supports **local LLM inference** via [Ollama](https://ollama.ai), enabling you to run powerful language models entirely on your own hardware. Ollama can run **locally** or on a **remote server** — both are fully supported.

## Why Local LLMs?

- **Privacy** — Your data never leaves your machine
- **Cost-Free** — No API fees or token limits
- **Offline** — Works without internet connection
- **Low Latency** — No network round-trips
- **Full Control** — Customize model behavior freely

---

## Quick Start (Automated)

The fastest way to get started:

```bash
wunderland ollama-setup
```

This single command will:
1. **Detect or install** Ollama (macOS via Homebrew, Linux via curl, Windows via winget)
2. **Analyze your hardware** (RAM, GPU, VRAM) for optimal model selection
3. **Recommend a model tier** (low/mid/high) based on your system
4. **Download recommended models** with progress tracking
5. **Configure Wunderland** to use Ollama as the default provider

### Flags

```bash
wunderland ollama-setup --yes          # Non-interactive (auto-accept all)
wunderland ollama-setup --tier mid     # Force a specific tier (low/mid/high)
wunderland ollama-setup --skip-pull    # Configure without downloading models
wunderland ollama-setup mistral:7b     # Override the primary model
```

---

## Manual Setup

### 1. Install Ollama

**macOS (Homebrew)**
```bash
brew install ollama
```

**macOS/Linux (Direct)**
```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

**Windows (winget)**
```bash
winget install --id Ollama.Ollama
```

**Windows (Manual)**
Download from [ollama.ai/download](https://ollama.ai/download)

### 2. Start Ollama Service

```bash
ollama serve
```

The server runs at `http://localhost:11434` by default.

### 3. Pull a Model

```bash
ollama pull llama3.2:3b        # Lightweight, fast
ollama pull dolphin-llama3:8b  # Balanced, uncensored
ollama pull llama3.1:70b       # Maximum quality (requires 48GB+ RAM)
```

### 4. Configure Wunderland

**CLI**
```bash
wunderland init my-agent --provider ollama
# or
wunderland config set llmProvider ollama
wunderland config set llmModel dolphin-llama3:8b
```

**Programmatic API**
```ts
import { createWunderlandSeed, HEXACO_PRESETS, DEFAULT_SECURITY_PROFILE, DEFAULT_INFERENCE_HIERARCHY, DEFAULT_STEP_UP_AUTH_CONFIG } from 'wunderland/advanced';
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

const agent = new AgentOS();
await agent.initialize({
  llmProvider: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'dolphin-llama3:8b'
  }
});
```

---

## Hardware-Aware Model Selection

`wunderland ollama-setup` detects your hardware and recommends the optimal configuration:

### Tier Breakdown

| Tier | RAM | GPU Required | Router | Primary | Auditor |
|------|-----|-------------|--------|---------|---------|
| **Low** | &lt;8 GB | No | `llama3.2:1b` | `llama3.2:3b` | `llama3.2:1b` |
| **Mid** | 8-16 GB | No | `llama3.2:3b` | `dolphin-llama3:8b` | `llama3.2:3b` |
| **High** | 16+ GB | Yes* | `llama3.2:3b` | `llama3.1:70b` or `dolphin-llama3:8b` | `llama3.2:3b` |

*70B models require 48GB+ unified memory (Apple Silicon) or 40GB+ VRAM (discrete GPU). Systems with less VRAM fall back to 8B models.

### GPU Auto-Configuration

The setup command detects your GPU and configures optimal offloading:

| Platform | Detection Method | Offload Strategy |
|----------|-----------------|------------------|
| **Apple Silicon** | `system_profiler` | Full offload (`num_gpu=-1`), unified memory = VRAM |
| **NVIDIA** | `nvidia-smi` | Full offload if VRAM sufficient, partial otherwise |
| **AMD (ROCm)** | `rocm-smi` | VRAM-based offload calculation |
| **Windows** | PowerShell `Win32_VideoController` | VRAM-based offload |
| **No GPU** | — | CPU-only (`num_gpu=0`) |

### Context Window Tuning

The `num_ctx` (context window) is automatically sized based on available memory:

| Model Size | &lt;8 GB available | 8-16 GB | 16+ GB |
|-----------|----------------|---------|--------|
| 1B/3B | 4096 | 8192 | 8192 |
| 8B | 2048 | 4096 | 8192 |
| 70B | 2048 | 2048 | 2048-8192 |

These values are written to `~/.wunderland/config.json` and used automatically by `wunderland start` and `wunderland chat`.

---

## Remote Ollama Server

Ollama doesn't have to run on the same machine. You can point Wunderland at a remote Ollama instance:

### Via Environment Variable

```bash
export OLLAMA_BASE_URL=https://ollama.myserver.com
wunderland start
```

### Via Config

```bash
# During setup
wunderland ollama-setup
# When prompted: "Use a custom Ollama server URL?" → yes → enter URL

# Or manually
wunderland config set ollama.baseUrl https://ollama.myserver.com
```

### Via Programmatic API

```ts
await agent.initialize({
  llmProvider: {
    provider: 'ollama',
    baseUrl: 'https://ollama.myserver.com',
    model: 'llama3.1:70b'
  }
});
```

### Via Cloudflare Tunnel (expose local to internet)

```bash
# On the machine running Ollama:
cloudflared tunnel --url http://localhost:11434

# Use the generated URL in Wunderland:
export OLLAMA_BASE_URL=https://abc123.trycloudflare.com
wunderland start
```

### URL Resolution Priority

1. `OLLAMA_BASE_URL` environment variable (highest priority)
2. `~/.wunderland/config.json` → `ollama.baseUrl`
3. `http://localhost:11434` (default)

---

## Recommended Models

### General Purpose

| Model | Size | VRAM | Use Case |
|-------|------|------|----------|
| `llama3.2:1b` | 0.7GB | 2GB | Ultra-fast routing/classification |
| `llama3.2:3b` | 1.9GB | 4GB | Fast, lightweight tasks |
| `dolphin-llama3:8b` | 4.7GB | 8GB | Balanced, uncensored |
| `llama3:8b` | 4.7GB | 8GB | Meta's latest, excellent quality |
| `llama3.1:70b` | 40GB | 48GB | State-of-the-art reasoning |
| `mixtral:8x7b` | 26GB | 32GB | Mixture of experts, very capable |

### Coding Models

| Model | Size | VRAM | Use Case |
|-------|------|------|----------|
| `codellama:7b` | 3.8GB | 8GB | Code generation |
| `codellama:34b` | 19GB | 24GB | Advanced coding tasks |
| `deepseek-coder:6.7b` | 3.8GB | 8GB | Fast code completion |

### Uncensored Models

| Model | Size | Description |
|-------|------|-------------|
| `dolphin-mistral:7b` | 4.1GB | Uncensored Mistral fine-tune |
| `dolphin-mixtral:8x7b` | 26GB | Powerful uncensored MoE |
| `nous-hermes2:10.7b` | 6.1GB | Instruction-following |
| `openhermes:7b` | 4.1GB | Teknium's open fine-tune |
| `wizard-vicuna-uncensored:13b` | 7.4GB | Wizard + Vicuna uncensored |

**Install uncensored model:**
```bash
ollama pull dolphin-llama3:8b
# Or
ollama pull dolphin-mixtral:8x7b
```

---

## Configuration Reference

### Config File (`~/.wunderland/config.json`)

```json
{
  "llmProvider": "ollama",
  "llmModel": "dolphin-llama3:8b",
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "numCtx": 4096,
    "numGpu": -1
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ollama.baseUrl` | `string` | `http://localhost:11434` | Ollama server URL (local or remote) |
| `ollama.numCtx` | `number` | Auto-detected | Context window size |
| `ollama.numGpu` | `number` | Auto-detected | GPU layers (-1=all, 0=CPU) |

### Environment Variables

```bash
OLLAMA_BASE_URL=http://localhost:11434   # Server URL (overrides config)
OLLAMA_MODEL=dolphin-llama3:8b           # Default model
OLLAMA_REQUEST_TIMEOUT_MS=60000          # Request timeout (ms)
OLLAMA_HOST=0.0.0.0:11434               # Ollama listen address (for serving)
```

### Multiple Models

Switch between models dynamically:

```javascript
// Fast model for simple tasks
const quickResponse = await agent.llmProviderManager.generateCompletion(
  'llama3.2:3b',
  messages,
  { temperature: 0.3 }
);

// Powerful model for complex reasoning
const deepResponse = await agent.llmProviderManager.generateCompletion(
  'dolphin-llama3:8b',
  messages,
  { temperature: 0.7 }
);
```

### Streaming

The Ollama service supports streaming responses for real-time output:

```typescript
// Backend usage (OllamaLlmService)
const service = new OllamaLlmService({
  providerId: 'ollama',
  apiKey: undefined,
  baseUrl: 'http://localhost:11434',
  defaultModel: 'llama3:8b',
});

for await (const chunk of service.generateChatCompletionStream(messages, 'llama3:8b')) {
  process.stdout.write(chunk.text);
  if (chunk.done && chunk.usage) {
    console.log(`\nTokens: ${chunk.usage.total_tokens}`);
  }
}
```

---

## Ollama Management

### List Available Models

```bash
ollama list
```

### Pull New Models

```bash
ollama pull MODEL_NAME
```

### Remove Models

```bash
ollama rm MODEL_NAME
```

### Check Running Status

```bash
curl http://localhost:11434/api/tags
```

### Version Check

```bash
ollama --version
# Minimum required: 0.1.24 (for OpenAI-compatible /v1 endpoints)
```

### GPU Acceleration

Ollama automatically uses GPU when available:
- **NVIDIA**: Requires CUDA drivers
- **Apple Silicon**: Uses Metal automatically (unified memory)
- **AMD**: ROCm support (Linux)

Check GPU usage:
```bash
# macOS
system_profiler SPDisplaysDataType

# Linux (NVIDIA)
nvidia-smi

# Linux (AMD)
rocm-smi

# Windows
powershell -Command "Get-CimInstance Win32_VideoController | Select Name, AdapterRAM"
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

4. If using a remote server, verify the URL:
   ```bash
   curl https://your-remote-ollama.com/api/tags
   ```

### Slow Inference

1. **Use quantized models** (q4_0, q5_K_M):
   ```bash
   ollama pull mistral:7b-instruct-q4_0
   ```

2. **Reduce context size**:
   ```bash
   wunderland config set ollama.numCtx 2048
   ```

3. **Check GPU usage** — CPU inference is 10-50x slower

4. **Verify GPU offload** — ensure `numGpu` is not 0:
   ```bash
   wunderland config get ollama.numGpu
   ```

### Out of Memory

1. Use smaller models (3B vs 8B vs 70B)
2. Use more aggressive quantization (q4_0 vs q8_0)
3. Reduce `numCtx` context window
4. Run `wunderland ollama-setup --tier low` to force lightweight models

### Version Issues

```bash
# Check version
ollama --version

# Update Ollama
# macOS:
brew upgrade ollama
# Linux:
curl -fsSL https://ollama.ai/install.sh | sh
# Windows:
winget upgrade Ollama.Ollama
```

---

## Performance Tips

1. **Right-size your model** — 3B-8B models are excellent for most tasks
2. **Use quantization** — Q4 is 4x smaller with minimal quality loss
3. **Let the CLI optimize** — `wunderland ollama-setup` tunes numCtx/numGpu for your hardware
4. **Keep server warm** — First request loads model, subsequent are fast
5. **Use remote Ollama** — Run on a powerful server, connect from anywhere

---

## Links

- [Ollama Models](https://ollama.ai/library) — Browse available models
- [AgentOS Docs](https://agentos.sh/docs) — Full AgentOS documentation
- [Wunderland Docs](https://docs.wunderland.sh) — Network + API documentation
