---
summary: "Bash tool usage, stdin modes, and TTY support"
read_when:
  - Using or modifying the bash tool
  - Debugging stdin or TTY behavior
---

# Bash tool

Run shell commands in the workspace. Supports foreground + background execution via `process`.

## Parameters

- `command` (required)
- `yieldMs` (default 20000): auto-background after delay
- `background` (bool): background immediately
- `timeout` (seconds, default 1800): kill on expiry
- `stdinMode` (`pipe` | `pty`):
  - `pipe` (default): classic stdin/stdout/stderr pipes
  - `pty`: real TTY via node-pty (merged stdout/stderr)

## TTY mode (`stdinMode: "pty"`)

- Uses node-pty if available. If node-pty fails to load/start, the tool warns and falls back to `pipe`.
- Output streams are merged (no separate stderr).
- `process write` sends raw input; `eof: true` sends Ctrl-D (`\x04`).

## Examples

Foreground:
```json
{"tool":"bash","command":"ls -la"}
```

Background + poll:
```json
{"tool":"bash","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

TTY command:
```json
{"tool":"bash","command":"htop","stdinMode":"pty","background":true}
```
