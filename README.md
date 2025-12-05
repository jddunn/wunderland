# 🦞 CLAWDIS — WhatsApp Gateway for AI Agents

<p align="center">
  <img src="docs/whatsapp-clawd.jpg" alt="CLAWDIS" width="400">
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/steipete/warelay/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/steipete/warelay/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/warelay"><img src="https://img.shields.io/npm/v/warelay.svg?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**CLAWDIS** (formerly Warelay) is a WhatsApp-to-AI gateway. Send a message, get an AI response. It's like having a genius lobster in your pocket 24/7.

```
┌─────────────┐      ┌──────────┐      ┌─────────────┐
│  WhatsApp   │ ───▶ │ CLAWDIS  │ ───▶ │  AI Agent   │
│  (You)      │ ◀─── │  🦞⏱️💙   │ ◀─── │   (Pi/Tau)  │
└─────────────┘      └──────────┘      └─────────────┘
```

## Why "CLAWDIS"?

**CLAWDIS** = CLAW + TARDIS

Because every space lobster needs a time-and-space machine. The Doctor has a TARDIS. [Clawd](https://clawd.me) has a CLAWDIS. Both are blue. Both are chaotic. Both are loved.

## Features

- 📱 **WhatsApp Integration** — Personal WhatsApp Web or Twilio
- 🤖 **AI Agent Gateway** — Pi/Tau only (Pi CLI in RPC mode)
- 💬 **Session Management** — Per-sender conversation context
- 🔔 **Heartbeats** — Periodic check-ins for proactive AI
- 👥 **Group Chat Support** — Mention-based triggering
- 📎 **Media Support** — Images, audio, documents, voice notes
- 🎤 **Voice Transcription** — Whisper integration
- 🔧 **Tool Streaming** — Real-time display (💻📄✍️📝)

Only the Pi/Tau CLI is supported now; legacy Claude/Codex/Gemini paths have been removed.

## Quick Start

```bash
# Install
npm install -g warelay  # (still warelay on npm for now)

# Link your WhatsApp
clawdis login

# Send a message
clawdis send --to +1234567890 --message "Hello from the CLAWDIS!"

# Talk directly to the agent (no WhatsApp send)
clawdis agent --to +1234567890 --message "Ship checklist" --thinking high

# Start the relay
clawdis relay --verbose
```

## Configuration

Create `~/.clawdis/clawdis.json`:

```json5
{
  inbound: {
    allowFrom: ["+1234567890"],
    reply: {
      mode: "command",
      command: ["tau", "--mode", "json", "{{BodyStripped}}"],
      session: {
        scope: "per-sender",
        idleMinutes: 1440
      },
      heartbeatMinutes: 10
    }
  }
}
```

## Documentation

- [Configuration Guide](./docs/configuration.md)
- [Agent Integration](./docs/agents.md)
- [Group Chats](./docs/group-messages.md)
- [Security](./docs/security.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [The Lore](./docs/lore.md) 🦞

## Clawd

CLAWDIS was built for **Clawd**, a space lobster AI assistant. See the full setup in [`docs/clawd.md`](./docs/clawd.md).

- 🦞 **Clawd's Home:** [clawd.me](https://clawd.me)
- 📜 **Clawd's Soul:** [soul.md](https://soul.md)
- 👨‍💻 **Peter's Blog:** [steipete.me](https://steipete.me)
- 🐦 **Twitter:** [@steipete](https://twitter.com/steipete)

## Providers

### WhatsApp Web (Recommended)
```bash
clawdis login      # Scan QR code
clawdis relay      # Start listening
```

### Twilio
```bash
# Set environment variables
export TWILIO_ACCOUNT_SID=...
export TWILIO_AUTH_TOKEN=...
export TWILIO_WHATSAPP_FROM=whatsapp:+1234567890

clawdis relay --provider twilio
```

## Commands

| Command | Description |
|---------|-------------|
| `clawdis login` | Link WhatsApp Web via QR |
| `clawdis send` | Send a message |
| `clawdis agent` | Talk directly to the agent (no WhatsApp send) |
| `clawdis relay` | Start auto-reply loop |
| `clawdis status` | Show recent messages |
| `clawdis heartbeat` | Trigger a heartbeat |

## Credits

- **Peter Steinberger** ([@steipete](https://twitter.com/steipete)) — Creator
- **Mario Zechner** ([@badlogicgames](https://twitter.com/badlogicgames)) — Tau/Pi, security testing
- **Clawd** 🦞 — The space lobster who demanded a better name

## License

MIT — Free as a lobster in the ocean.

---

*"We're all just playing with our own prompts."*

🦞💙
