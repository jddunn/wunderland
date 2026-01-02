---
summary: "Group chat behavior across surfaces (WhatsApp/Telegram/Discord/iMessage)"
read_when:
  - Changing group chat behavior or mention gating
---
# Groups

Clawdis treats group chats consistently across surfaces: WhatsApp, Telegram, Discord, iMessage.

## Session keys
- Group sessions use `group:<id>` in `ctx.From`.
- Direct chats use the main session (or per-sender if configured).
- Heartbeats are skipped for group sessions.

## Mention gating (default)
Group messages require a mention unless overridden per group.

```json5
{
  routing: {
    groupChat: {
      requireMention: true,
      mentionPatterns: ["@clawd", "clawdbot", "\\+15555550123"],
      historyLimit: 50
    }
  }
}
```

Notes:
- `mentionPatterns` are case-insensitive regexes.
- Surfaces that provide explicit mentions still pass; patterns are a fallback.

## Activation (owner-only)
Group owners can toggle per-group activation:
- `/activation mention`
- `/activation always`

Owner is determined by `routing.allowFrom` (or the bot’s default identity when unset).

## Context fields
Group inbound payloads set:
- `ChatType=group`
- `GroupSubject` (if known)
- `GroupMembers` (if known)
- `WasMentioned` (mention gating result)

The agent system prompt includes a group intro on the first turn of a new group session.

## iMessage specifics
- Prefer `chat_id:<id>` when routing or allowlisting.
- List chats: `imsg chats --limit 20`.
- Group replies always go back to the same `chat_id`.

## WhatsApp specifics
See `docs/group-messages.md` for WhatsApp-only behavior (history injection, mention handling details).
