# Channel Integrations

## Overview

Connect your Wunderbot to messaging platforms so users can interact with your agent wherever they already are. Each channel adapter normalizes inbound messages into a common format and routes replies back through the platform's API.

## Quick Start

```bash
wunderland connect gmail
wunderland connect whatsapp
wunderland connect slack
wunderland connect signal
```

The `connect` command walks you through OAuth or credential setup for each platform. Once connected, chat commands work the same across all channels.

---

## WhatsApp

WhatsApp supports two providers. Choose based on your needs:

| | Twilio | Meta Cloud API |
|---|---|---|
| **Cost** | Paid (per-message pricing) | Free tier (1,000 conversations/month) |
| **Reliability** | Production-grade, SLA-backed | Reliable, requires app review for production |
| **Setup** | Quick — API keys only | Requires Facebook app + business verification |

### Twilio Setup

1. Create a [Twilio account](https://www.twilio.com/try-twilio) and purchase a WhatsApp-enabled phone number.
2. In the Twilio Console, navigate to **Messaging > Try it out > Send a WhatsApp message** to activate the sandbox (or request a production number).
3. Set environment variables:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

4. Run `wunderland connect whatsapp` and select **Twilio** as the provider.

### Meta Cloud API Setup

1. Create an app at [developers.facebook.com](https://developers.facebook.com/).
2. Add the **WhatsApp** product to your app.
3. Generate a permanent access token and note your Phone Number ID.
4. Set environment variables:

```bash
META_WHATSAPP_TOKEN=EAAxxxxxxx
META_WHATSAPP_PHONE_ID=1234567890
META_WHATSAPP_VERIFY_TOKEN=your_verify_secret
```

5. Run `wunderland connect whatsapp` and select **Meta Cloud API** as the provider.

### Webhook Configuration

Configure your webhook URL in the provider's dashboard:

```
https://your-server/wunderland/channels/inbound/whatsapp/{seedId}
```

Replace `{seedId}` with your agent's seed ID (visible in `wunderland doctor` or on your dashboard).

---

## Slack

### CLI Setup

```bash
wunderland connect slack
```

This routes through **rabbithole.inc OAuth** — no manual Slack app creation is needed. The command opens your browser to authorize the Wunderbot Slack app in your workspace.

For self-hosted deployments, set these environment variables and create your own Slack app:

```bash
SLACK_OAUTH_CLIENT_ID=your_client_id
SLACK_OAUTH_CLIENT_SECRET=your_client_secret
SLACK_BOT_TOKEN=xoxb-your-bot-token
```

### Auto-Reply Modes

Control when your Wunderbot responds in Slack:

| Mode | Behavior |
|---|---|
| `off` | Bot does not reply automatically |
| `dm` | Reply only to direct messages |
| `mentions` | Reply when @mentioned in channels |
| `all` | Reply to every message in configured channels |

Set the mode:

```bash
wunderland config set slack.autoReply mentions
```

The webhook is already configured via the **Slack Events API** — no manual URL setup is required.

---

## Signal

### Prerequisites (signal-cli)

Signal integration requires [signal-cli](https://github.com/AsamK/signal-cli), a command-line interface for the Signal protocol.

**Install:**

```bash
# macOS
brew install signal-cli

# Linux (manual)
# See https://github.com/AsamK/signal-cli/releases
```

### Setup Wizard

```bash
wunderland connect signal
```

The wizard walks you through:

1. **Link or register** a phone number with signal-cli
2. **Verify** via SMS or voice call
3. **Test** the connection by sending a message
4. **Save** the configuration to your agent config

### Running the Daemon

signal-cli runs as a JSON-RPC daemon that forwards messages to your Wunderbot. The webhook URL for the daemon is:

```
http://localhost:{port}/wunderland/channels/inbound/signal/{seedId}
```

Start the daemon:

```bash
signal-cli -a +1234567890 daemon --json
```

The Wunderbot server listens on this endpoint and processes incoming Signal messages the same way as any other channel.

---

## Telegram (Already Live)

### Bot Token from BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to create your bot.
3. Copy the bot token and set it:

```bash
TELEGRAM_BOT_TOKEN=123456:ABCdef...
TELEGRAM_BOT_ENABLED=true
```

4. Run `wunderland connect telegram` or start your server — the bot auto-registers.

---

## Discord (Already Live)

### OAuth Connect via Dashboard

1. Go to your Wunderbot dashboard at **rabbithole.inc**.
2. Navigate to **Settings > Channels > Discord**.
3. Click **Connect** to authorize the bot in your server.
4. Configure roles and channels in the setup wizard.

Or set environment variables for self-hosted:

```bash
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_APPLICATION_ID=your_app_id
DISCORD_GUILD_ID=your_server_id
DISCORD_BOT_ENABLED=true
```

---

## All Channels

### Auto-Reply Configuration

Every channel supports auto-reply modes. Set them per-channel:

```bash
wunderland config set slack.autoReply mentions
wunderland config set whatsapp.autoReply all
wunderland config set signal.autoReply dm
wunderland config set telegram.autoReply all
wunderland config set discord.autoReply mentions
```

### Agency Mode (Multi-Persona)

In Agency Mode, multiple Wunderbots can share a single channel. Each bot responds based on its personality and skill set. Configure this in your `agent.config.json`:

```json
{
  "agency": {
    "enabled": true,
    "agents": ["agent-alpha", "agent-beta"],
    "routing": "round-robin"
  }
}
```

### Checking Channel Status

```bash
wunderland doctor
```

The doctor command shows the connection status for all configured channels, including provider details and phone numbers where applicable.

### Help

```bash
wunderland help whatsapp
wunderland help slack
wunderland help signal
wunderland help email
```
