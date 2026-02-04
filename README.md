# Wunderland

> AI-powered personal assistant framework built on [AgentOS](https://agentos.sh)

[![npm version](https://badge.fury.io/js/wunderland.svg)](https://www.npmjs.com/package/wunderland)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Status: Coming Soon**

Wunderland is a personal AI assistant framework built on the AgentOS ecosystem. Think OpenClaw, but as a modular npm package you can build on.

## Features (Planned)

- **Multi-channel communication** - Telegram, Discord, Slack, WhatsApp, iMessage, Signal
- **Persistent memory** - Long-term context that follows you across conversations
- **Proactive task scheduling** - Cron jobs, reminders, heartbeats
- **Self-building skills** - Agent can create its own capabilities
- **Human takeover support** - Seamless handoff to human operators

## Installation

```bash
npm install wunderland
```

## Quick Start

```javascript
const { WunderlandAgent } = require('wunderland');

const agent = new WunderlandAgent({
  channels: ['telegram', 'discord'],
  memory: { persistent: true },
  scheduler: { enabled: true }
});

await agent.initialize();
```

## Built on AgentOS

Wunderland leverages the [AgentOS](https://agentos.sh) ecosystem:

- `@framers/agentos` - Core orchestration runtime
- `@framers/sql-storage-adapter` - Persistent storage
- `@framers/agentos-extensions` - Community extensions

## Local LLM Support (Ollama)

Wunderland fully supports **local LLM inference** via [Ollama](https://ollama.ai) — run AI models entirely on your hardware with no cloud APIs required.

**Quick start:**
```bash
# Install Ollama
brew install ollama

# Start service
ollama serve

# Pull a model
ollama pull mistral:latest
# Or uncensored:
ollama pull dolphin-mistral:7b
```

**Configure Wunderland:**
```javascript
await agent.initialize({
  llmProvider: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'mistral:latest'  // or 'dolphin-mistral:7b'
  }
});
```

📖 **[Full Local LLM Setup Guide →](./docs/LOCAL_LLM_SETUP.md)**

## Links

- [GitHub](https://github.com/jddunn/wunderland)
- [AgentOS](https://agentos.sh)
- [npm](https://www.npmjs.com/package/wunderland)
- [Local LLM Guide](./docs/LOCAL_LLM_SETUP.md)


## License

MIT
