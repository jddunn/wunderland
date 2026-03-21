# Email Intelligence

## Overview

Connect Gmail accounts to your Wunderbot for AI-powered email intelligence.
Thread reconstruction, project detection, natural language search, and
structured reports — all from the CLI or the Rabbithole dashboard.

## Quick Start

```bash
wunderland connect gmail    # One-time OAuth (opens browser, PKCE — no keys needed)
wunderland chat             # Ask about your emails naturally
```

## Features

- **Full email sync** — incremental sync every 5 minutes via Gmail push + polling
- **Thread hierarchy** — rebuilds conversation threads from RFC 2822 In-Reply-To / References headers
- **Project auto-detection** — clusters threads by participant overlap, subject similarity, and label co-occurrence
- **Multimodal attachment extraction** — indexes content from PDF, DOCX, XLSX, and image attachments
- **Full-text search with RAG** — semantic search across all email content and attachments
- **Reports** — export project summaries as PDF, Markdown, or JSON
- **Scheduled digests** — periodic summaries delivered to your preferred channel (Slack, Discord, Telegram, etc.)
- **Multi-account** — connect multiple Gmail accounts to a single Wunderbot

## CLI Commands

### Connection

```bash
wunderland connect gmail        # Connect account (OAuth + PKCE, opens browser)
wunderland doctor               # Check Gmail connection status
```

### Chat Commands

Inside `wunderland chat`, use these slash commands:

| Command | Description |
|---------|-------------|
| `/email inbox` | View inbox (thread-centric) |
| `/email projects` | View auto-detected project groupings |
| `/email search <query>` | Semantic search across all email |
| `/email thread <id>` | Show thread detail with full hierarchy |
| `/email report <project> <format>` | Generate report (pdf, md, json) |

### Natural Language

You can also just ask questions in plain English:

- "What's happening with Project Alpha?"
- "Any new emails from Sarah?"
- "Summarize the API redesign thread"
- "Export Project Alpha as PDF"
- "What did the team discuss about the Q3 launch?"
- "Are there any unread emails about the contract?"

## Dashboard (Rabbithole)

Navigate to `/app/dashboard/[seedId]/email/` in the Rabbithole web dashboard.

### Tabs

| Tab | Description |
|-----|-------------|
| **Inbox** | Thread-centric view with search and detail panel |
| **Projects** | Auto-detected project groupings with thread counts and participants |
| **Intelligence** | Stats, stale thread detection, and an AI chat widget for email questions |
| **Settings** | Manage connected accounts, digest schedules, and SMTP configuration |

## Architecture

| Layer | Location | Description |
|-------|----------|-------------|
| Backend module | `backend/src/modules/wunderland/email-intelligence/` | NestJS module: sync, indexing, project detection, search |
| Extension pack | `packages/agentos-extensions/.../email-intelligence/` | 12 ITool implementations for the agent runtime |
| UI components | `apps/rabbithole/src/components/email/` | 14 React components for the dashboard |
| Design spec | `docs/superpowers/specs/2026-03-19-email-intelligence-assistant-design.md` | Full feature specification |

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Custom OAuth client ID (optional — a default is embedded) |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret (optional for PKCE desktop flow) |
| `GOOGLE_REFRESH_TOKEN` | Set automatically by `wunderland connect gmail` |

### Config File

Tokens are stored in `~/.wunderland/config.json` under the `google` key:

```json
{
  "google": {
    "clientId": "...",
    "refreshToken": "...",
    "accessToken": "...",
    "email": "user@gmail.com",
    "expiresAt": 1711000000000
  }
}
```

Access tokens are refreshed automatically. The refresh token persists across
sessions.

## Self-Hosted

`wunderland connect gmail` works on any machine with a browser. The OAuth
flow uses PKCE (Proof Key for Code Exchange), so there is no need to
configure API keys or client secrets manually. A temporary local HTTP
server receives the callback, exchanges the code for tokens, and shuts down.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Gmail: not connected" in `wunderland doctor` | Run `wunderland connect gmail` |
| OAuth window doesn't open | Copy the URL from the terminal and paste it into your browser |
| "Token exchange failed" | Check your network connection; Google OAuth requires internet access |
| Sync not updating | Tokens may have expired — run `wunderland connect gmail` again to re-authorize |

## Help

```bash
wunderland help email       # Quick reference
wunderland help gmail       # Same as above (alias)
```
