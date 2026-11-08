# Safe Guardrails & Folder Permissions

This guide covers Wunderland's folder-level permissions and safe guardrails system, which provides fine-grained access control and pre-execution validation for agent tool calls.

## Table of Contents

- [Overview](#overview)
- [Folder-Level Permissions](#folder-level-permissions)
- [Safe Guardrails System](#safe-guardrails-system)
- [Security Tier Integration](#security-tier-integration)
- [Audit Logging](#audit-logging)
- [Notifications](#notifications)
- [Configuration Examples](#configuration-examples)
- [Troubleshooting](#troubleshooting)

## Overview

The Safe Guardrails system provides defense-in-depth security for Wunderland agents:

1. **Folder-Level Permissions**: Fine-grained access control per folder with glob pattern support
2. **Pre-Execution Validation**: Validates tool calls before execution
3. **Violation Detection**: Catches unauthorized access attempts
4. **Audit Trail**: Structured logging of all security violations
5. **Real-Time Notifications**: Webhooks and email alerts for high-severity violations

### Architecture

```
Tool Call Request
    ↓
Safe Guardrails (Validation)
    ↓
Folder Permission Check
    ├─ Match glob patterns
    ├─ Check read/write access
    └─ Inherit from security tier
    ↓
[ALLOWED] → Execute Tool
[DENIED] → Log Violation → Notify → Return Error
```

---

## Folder-Level Permissions

Folder permissions define which directories an agent can access and what operations it can perform.

### Permission Model

Each folder access rule specifies:
- **Pattern**: Glob pattern matching paths (`/home/**`, `~/workspace/*`, `!/sensitive/*`)
- **Read**: Boolean - can the agent read from this folder?
- **Write**: Boolean - can the agent write/modify/delete in this folder?
- **Description**: Optional human-readable description for audit logs

### Folder Permission Config

```typescript
interface FolderPermissionConfig {
  /** Default policy when path not matched */
  defaultPolicy: 'allow' | 'deny';

  /** Ordered list of rules (first match wins) */
  rules: FolderAccessRule[];

  /** Inherit security tier's filesystem permissions as fallback */
  inheritFromTier: boolean;
}
```

### Glob Pattern Syntax

**Supported patterns:**
- `*` - Match single level: `/home/user/*` matches `/home/user/file.txt` but NOT `/home/user/subdir/file.txt`
- `**` - Match recursively: `/home/**` matches all files under `/home` at any depth
- `!` - Negation: `!/sensitive/*` blocks all files under `/sensitive`
- `~` - Home directory: `~/workspace/**` expands to `/home/user/workspace/**`

**Examples:**
```json
{
  "pattern": "~/workspace/**",
  "read": true,
  "write": true,
  "description": "Full access to agent workspace"
}
```

```json
{
  "pattern": "/var/log/**",
  "read": true,
  "write": false,
  "description": "Read-only access to logs"
}
```

```json
{
  "pattern": "!/home/user/.ssh/*",
  "read": false,
  "write": false,
  "description": "Block SSH keys"
}
```

### Rule Evaluation Logic

1. Rules are evaluated in order (first to last)
2. **First matching rule wins** (even if later rules also match)
3. If no rule matches, apply `defaultPolicy`
4. If `defaultPolicy` is `deny` and `inheritFromTier` is `true`, fall back to security tier permissions

**Example evaluation:**
```json
{
  "defaultPolicy": "deny",
  "inheritFromTier": true,
  "rules": [
    { "pattern": "~/workspace/**", "read": true, "write": true },
    { "pattern": "!/workspace/sensitive/*", "read": false, "write": false },
    { "pattern": "/tmp/**", "read": true, "write": true }
  ]
}
```

- `/home/user/workspace/file.txt` → Rule 1 matches → ALLOW (read + write)
- `/home/user/workspace/sensitive/secret.txt` → Rule 2 matches (negation) → DENY
- `/tmp/test.txt` → Rule 3 matches → ALLOW (read + write)
- `/etc/passwd` → No match → Inherit from tier → Depends on tier permissions

---

## Safe Guardrails System

The Safe Guardrails engine validates all tool calls before execution to prevent unauthorized access.

### Validation Flow

```typescript
async function validateBeforeExecution(request: GuardrailsRequest): Promise<GuardrailsResult> {
  // 1. Check if tool requires filesystem access
  if (!isFilesystemTool(request.toolId)) return { allowed: true };

  // 2. Get agent's folder permissions; an agent with none is denied
  const folderConfig = this.folderPermissions.get(request.agentId);
  if (!folderConfig) {
    if (config.requireFolderPermissionsForFilesystemTools) return { allowed: false, reason, violations };
    return { allowed: true }; // The host opted out
  }

  // 3. Extract file paths from arguments
  const paths = extractFilePaths(request.toolId, request.args);
  if (paths.length === 0) return { allowed: true };

  // 4. Determine operation type (read vs write)
  const operation = getOperation(request.toolId, request.args);

  // 5. Validate each path against folder permissions
  for (const path of paths) {
    const result = checkFolderAccess(path, operation, folderConfig, tierPermissions);

    if (!result.allowed) {
      // VIOLATION DETECTED
      await logViolation(violation);
      await notifyViolation(violation);
      return { allowed: false, reason: result.reason, violations: [violation] };
    }
  }

  return { allowed: true };
}
```

`requireFolderPermissionsForFilesystemTools` defaults to `true`. A host that wants the permissive behavior for agents with no folder permissions passes `false`.

### Supported Tools

**Filesystem tools:**
- `file_read`, `file_write`, `file_append`, `file_delete`
- `list_directory`
- `shell_execute` (parses command for file paths)
- Extension tools: `git_clone`, `obsidian_read`, `obsidian_write`, `apple_notes_save`

**Path extraction:**
- Tool arguments: `file_path`, `path`, `directory`, `destination`, `filePath`
- Shell commands: Parses `rm`, `cp`, `mv`, `cat`, `touch`, `mkdir` commands

### Operation Type Detection

**Read operations:**
- `file_read`, `list_directory`, `obsidian_read`, `cat`, `ls`

**Write operations:**
- `file_write`, `file_append`, `file_delete`, `obsidian_write`
- `rm`, `mv`, `cp`, `touch`, `mkdir`, `echo >`, redirection

Default: Write (safer to assume write when uncertain)

---

## Security Tier Integration

The SDK ships tier-aligned folder permission presets (see `createDefaultFolderConfig()` in `wunderland/security`).

In the CLI runtime (`wunderland chat` / `wunderland start`):

- If `security.folderPermissions` is **unset**, a conservative default sandbox is applied at runtime (agent workspace only). This default is not written into `agent.config.json`.
- If you set `security.folderPermissions.inheritFromTier=true`, the guardrails fall back to the agent’s **permission set / tier filesystem flags** when a path is unmatched and `defaultPolicy='deny'`.

### Tier Default Folder Permissions

#### Dangerous
```json
{
  "defaultPolicy": "allow",
  "inheritFromTier": false,
  "rules": []
}
```
**Use case:** Testing only. Allow everything.

#### Permissive
```json
{
  "defaultPolicy": "allow",
  "inheritFromTier": true,
  "rules": [
    { "pattern": "!/etc/**", "read": false, "write": false, "description": "Block system config" },
    { "pattern": "!/root/**", "read": false, "write": false, "description": "Block root home" }
  ]
}
```
**Use case:** Development. Allow most access except critical system paths.

#### Balanced (Recommended)
```json
{
  "defaultPolicy": "deny",
  "inheritFromTier": true,
  "rules": [
    { "pattern": "~/workspace/**", "read": true, "write": true, "description": "Agent workspace" },
    { "pattern": "/tmp/**", "read": true, "write": true, "description": "Temp files" },
    { "pattern": "/var/log/**", "read": true, "write": false, "description": "Read-only logs" }
  ]
}
```
**Use case:** Production. Deny by default, allow specific safe paths.

#### Strict
```json
{
  "defaultPolicy": "deny",
  "inheritFromTier": true,
  "rules": [
    { "pattern": "~/workspace/**", "read": true, "write": true },
    { "pattern": "/tmp/agents/**", "read": true, "write": true }
  ]
}
```
**Use case:** High-security production. Minimal access.

#### Paranoid
```json
{
  "defaultPolicy": "deny",
  "inheritFromTier": true,
  "rules": [
    { "pattern": "~/workspace/**", "read": true, "write": true, "description": "Agent workspace only" }
  ]
}
```
**Use case:** Maximum security. Workspace only.

### Agent-Specific Overrides

Agents can override their security tier's default folder permissions in `agent.config.json`:

```json
{
  "seedId": "seed_research_assistant",
  "displayName": "Research Assistant",
  "security": {
    "tier": "balanced",
    "folderPermissions": {
      "defaultPolicy": "deny",
      "inheritFromTier": true,
      "rules": [
        { "pattern": "~/workspace/**", "read": true, "write": true },
        { "pattern": "~/Documents/research/**", "read": true, "write": false },
        { "pattern": "/data/public/**", "read": true, "write": false }
      ]
    }
  },
  "permissionSet": "autonomous"
}
```

---

## Audit Logging

All permission violations are logged to structured JSON files for compliance and debugging.

### Log Format

**Location:** `~/.wunderland/security/violations.log`

**Format:** JSON Lines (one JSON object per line)

```json
{"timestamp":"2026-02-09T10:30:00Z","level":"SECURITY_VIOLATION","agentId":"agent-research-bot","toolId":"file_write","operation":"file_write","attemptedPath":"/etc/passwd","reason":"Path /etc not in allowed folders","severity":"critical"}
{"timestamp":"2026-02-09T10:31:15Z","level":"SECURITY_VIOLATION","agentId":"agent-support-bot","toolId":"shell_execute","operation":"shell_execute","attemptedPath":"/usr/bin/sudo","reason":"CLI execution not permitted","severity":"high"}
```

### Severity Levels

**Critical:** System-critical paths (`/etc`, `/root`, `/boot`, `passwd`, `shadow`)
**High:** System paths (`/usr`, `/var`, `/sys`) or sensitive data (`.ssh`, `.aws`, credentials)
**Medium:** Write operations to non-critical paths
**Low:** Read operations to non-critical paths

### Log Rotation

- Automatic rotation when log file exceeds 10MB
- Keeps 5 rotated logs (`.log.1`, `.log.2`, ..., `.log.5`)
- Oldest log is deleted when rotating

### Querying Violations

```typescript
import { AuditLogger } from 'wunderland/security';

const logger = new AuditLogger();

// Query by agent
const violations = await logger.queryViolations({
  agentId: 'agent-research-bot',
  limit: 100,
});

// Query by severity
const criticalViolations = await logger.queryViolations({
  severity: 'critical',
  startTime: new Date('2026-02-09T00:00:00Z'),
  endTime: new Date('2026-02-09T23:59:59Z'),
});

// Get statistics
const stats = await logger.getStats({
  start: new Date('2026-02-01'),
  end: new Date('2026-02-28'),
});
console.log(stats.total); // 42
console.log(stats.bySeverity); // { critical: 5, high: 12, medium: 20, low: 5 }
console.log(stats.byAgent); // { 'agent-1': 10, 'agent-2': 32 }
```

---

## Notifications

High-severity violations trigger real-time notifications via webhooks and/or email.

### Webhook Notifications

**Format:** HTTP POST with JSON payload

```json
{
  "event": "security.violation",
  "severity": "critical",
  "agent": "agent-research-bot",
  "user": "user-123",
  "tool": "file_write",
  "operation": "file_write",
  "path": "/etc/passwd",
  "reason": "Path /etc not in allowed folders",
  "timestamp": "2026-02-09T10:30:00Z"
}
```

**Configuration:**
```typescript
const guardrails = new SafeGuardrails({
  notificationWebhooks: [
    'https://hooks.slack.com/services/YOUR/WEBHOOK/URL',
    'https://discord.com/api/webhooks/YOUR/WEBHOOK'
  ],
});
```

Or via environment variable:
```bash
export WUNDERLAND_VIOLATION_WEBHOOKS="https://hooks.slack.com/...,https://discord.com/..."
```

### Email Notifications

Every alert email goes to one recipient and ends with an Unsubscribe link; a recipient whose server refuses it does not stop the others. It also carries the two headers mail clients use for their own unsubscribe button (RFC 8058):

```text
List-Unsubscribe: <https://agents.example.com/mail/unsubscribe/Ae3f...>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

**Configuration:**
```typescript
import { SafeGuardrails } from 'wunderland/security';

const guardrails = new SafeGuardrails({
  emailConfig: {
    to: 'security@example.com',            // several recipients: separate them with commas
    from: 'wunderland@example.com',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'your-smtp-user',
    smtpPass: 'your-smtp-password',
    unsubscribeUrl: 'https://agents.example.com/mail/unsubscribe',
  },
});
```

Without an https `unsubscribeUrl` (or `WUNDERLAND_MAIL_UNSUBSCRIBE_URL`) no email is sent: the console says `[EMAIL] Not sent: no unsubscribe address ...`, and webhooks and the audit log are unaffected. With no SMTP host and user and no `transport`, the alert is written to the console instead, as before.

**Serve the unsubscribe links** on the host and path `unsubscribeUrl` names. `createMailUnsubscribeHandler` takes Node's request and response, so it mounts on a `node:http` server, Express or Nest:

```typescript
import { createServer } from 'node:http';
import { createMailUnsubscribeHandler } from 'wunderland/security';

const unsubscribe = createMailUnsubscribeHandler({
  unsubscribeUrl: 'https://agents.example.com/mail/unsubscribe',
});

createServer(async (req, res) => {
  if (await unsubscribe(req, res)) return;
  // ...the rest of your routes
}).listen(8080);
```

| Request to `<path>/<token>` | Answer |
|---|---|
| GET or HEAD | A page that asks, with an Unsubscribe button. Nothing changes, so a link scanner that opens the link unsubscribes no one. |
| POST (the mail client's one-click request, or the page's button) | The address goes on the suppression list at once and the next alert skips it. No confirmation email is sent. |
| A token this deployment did not issue | 404 |
| The suppression list cannot be written | 503, so the client tries again |
| Any other method | 405 |

Paths other than `<path>/<token>` resolve `false` and are left to your server; at the host root (`https://alerts.example.com/`) that includes every path not shaped like a token. Behind a proxy that rewrites paths, pass `basePath` with the path the request arrives at.

**How the link works.** The token is the recipient's address sealed with AES-256-GCM under a key derived from the unsubscribe secret: a reader of the link cannot tell whose it is, it works for that one address, and it can only unsubscribe it. The secret is `unsubscribeSecret` or `WUNDERLAND_MAIL_UNSUBSCRIBE_SECRET` (32 characters or more); without one, a key is generated once into `mail-unsubscribe.key` beside the suppression list, with mode 0600. Changing the secret voids every link already sent. When the process that sends alerts and the server that answers the links run on different machines, give both the same secret and the same suppression list.

**The suppression list** is `~/.wunderland/security/mail-suppressions.jsonl` unless `suppressionFile` or `WUNDERLAND_MAIL_SUPPRESSION_FILE` names another. It keeps SHA-256 hashes of the addresses, never the addresses, and it is read again before each recipient's email. Addresses in `doNotContact` or `WUNDERLAND_MAIL_DO_NOT_CONTACT` (separated by commas) are never mailed either. To act on a request made outside the link, or to send the alerts to someone again:

```typescript
import { isMailRecipientSuppressed, resumeMailRecipient, suppressMailRecipients } from 'wunderland/security';

await suppressMailRecipients(['former-admin@example.com']);
await resumeMailRecipient('former-admin@example.com');   // after that person asks for the alerts again
await isMailRecipientSuppressed('security@example.com');
```

**DKIM.** RFC 8058 section 4 asks for a DKIM signature that covers both list headers. When your mail server or relay signs, check the `h=` list of a received alert's `DKIM-Signature`. To sign in this process, pass nodemailer's DKIM options as `dkim` in `emailConfig`: both headers are added to the signed list, which nodemailer's default list of signed headers does not complete on its own (it holds `List-Unsubscribe` but not `List-Unsubscribe-Post`).

**Other transports.** `transport` takes a nodemailer transporter, or anything with the same `sendMail`, in place of the SMTP settings. nodemailer is not a dependency of this package: install it beside it to send through SMTP.

These alerts tell the people who run a deployment about its agents. They carry no advertisement or promotion, so they are not commercial email under CAN-SPAM's primary-purpose rule (16 CFR 316.3), and their footer says why the recipient gets them.

---

## Configuration Examples

### Example 1: Development Agent

```json
{
  "seedId": "seed_dev_agent",
  "displayName": "Development Agent",
  "security": {
    "tier": "permissive",
    "folderPermissions": {
      "defaultPolicy": "allow",
      "inheritFromTier": true,
      "rules": [
        { "pattern": "!/etc/**", "read": false, "write": false },
        { "pattern": "!/root/**", "read": false, "write": false },
        { "pattern": "~/.ssh/**", "read": false, "write": false }
      ]
    }
  },
  "permissionSet": "autonomous"
}
```

### Example 2: Production Research Agent

```json
{
  "seedId": "seed_research_agent",
  "displayName": "Research Agent",
  "security": {
    "tier": "balanced",
    "folderPermissions": {
      "defaultPolicy": "deny",
      "inheritFromTier": true,
      "rules": [
        { "pattern": "~/workspace/**", "read": true, "write": true, "description": "Agent workspace" },
        { "pattern": "~/Documents/research/**", "read": true, "write": false, "description": "Read research docs" },
        { "pattern": "/data/public/**", "read": true, "write": false, "description": "Public datasets" },
        { "pattern": "/tmp/research-*/**", "read": true, "write": true, "description": "Temp research files" }
      ]
    }
  },
  "permissionSet": "supervised"
}
```

### Example 3: High-Security Agent

```json
{
  "seedId": "seed_secure_agent",
  "displayName": "Secure Agent",
  "security": {
    "tier": "paranoid",
    "folderPermissions": {
      "defaultPolicy": "deny",
      "inheritFromTier": false,
      "rules": [
        { "pattern": "~/workspace/allowed/**", "read": true, "write": true, "description": "Allowed workspace only" }
      ]
    }
  },
  "permissionSet": "minimal"
}
```

---

## Troubleshooting

### Issue: Guardrails not catching violations

**Symptoms:** Agents can access files they shouldn't

**Solutions:**
1. Check if folder permissions are configured:
   ```bash
   cat agent.config.json | grep -A 10 folderPermissions
   ```

2. Verify guardrails are enabled in CLI:
   ```typescript
   // In tool-calling.ts, check if getGuardrails() is being called
   ```

3. Check agent ID matches:
   ```typescript
   guardrails.setFolderPermissions('your-agent-id', config);
   ```

### Issue: False positives (legitimate access denied)

**Symptoms:** Agent can't access needed files

**Solutions:**
1. Review folder permission rules:
   ```bash
   cat ~/.wunderland/security/violations.log | tail -n 50
   ```

2. Check rule order (first match wins):
   ```json
   {
     "rules": [
       { "pattern": "/home/user/**", "read": true, "write": false },
       { "pattern": "/home/user/workspace/**", "read": true, "write": true }
       // ❌ Second rule never matches because first rule matches first!
     ]
   }
   ```

   Fix: Reorder rules (most specific first):
   ```json
   {
     "rules": [
       { "pattern": "/home/user/workspace/**", "read": true, "write": true },
       { "pattern": "/home/user/**", "read": true, "write": false }
       // ✅ Correct order
     ]
   }
   ```

3. Use `validateFolderConfig()` to check for conflicts:
   ```typescript
   import { validateFolderConfig } from 'wunderland/security';

   const result = validateFolderConfig(config);
   if (!result.valid) {
     console.error('Errors:', result.errors);
   }
   if (result.warnings) {
     console.warn('Warnings:', result.warnings);
   }
   ```

### Issue: Violations not logged

**Symptoms:** No entries in `~/.wunderland/security/violations.log`

**Solutions:**
1. Check audit logging is enabled:
   ```typescript
   const guardrails = new SafeGuardrails({
     enableAuditLogging: true, // Make sure this is true
   });
   ```

2. Check log file permissions:
   ```bash
   ls -la ~/.wunderland/security/
   ```

3. Check disk space:
   ```bash
   df -h ~
   ```

### Issue: Notifications not sending

**Symptoms:** Webhooks/emails not received for violations

**Solutions:**
1. Check notification configuration:
   ```typescript
   const guardrails = new SafeGuardrails({
     enableNotifications: true,
     notificationWebhooks: ['https://...'],
   });
   ```

2. Test webhook manually:
   ```bash
   curl -X POST https://hooks.slack.com/... \
     -H 'Content-Type: application/json' \
     -d '{"text":"Test from Wunderland"}'
   ```

3. Check severity level (only high/critical trigger notifications):
   ```typescript
   // Notifications only sent for severity === 'high' || severity === 'critical'
   ```

4. For email, check that `unsubscribeUrl` is an https address with no query string, and that the recipient is not on the suppression list or the do-not-contact list. The console says which: `[EMAIL] Not sent: ...` or `[EMAIL] Skipped 1 recipient(s): unsubscribed`.

---

## API Reference

### FolderPermissions

```typescript
// Check folder access
import { checkFolderAccess } from 'wunderland/security';

const result = checkFolderAccess(
  '/home/user/file.txt',
  'write',
  folderConfig,
  tierPermissions
);

if (!result.allowed) {
  console.error(result.reason);
}
```

### SafeGuardrails

```typescript
import { SafeGuardrails } from 'wunderland/security';

const guardrails = new SafeGuardrails({
  auditLogPath: '~/.wunderland/security/violations.log',
  notificationWebhooks: ['https://...'],
  enableAuditLogging: true,
  enableNotifications: true,
});

// Set folder permissions for an agent. Without them its filesystem tools are denied.
guardrails.setFolderPermissions('agent-id', folderConfig);

// Validate before execution
const result = await guardrails.validateBeforeExecution({
  toolId: 'file_write',
  toolName: 'file_write',
  args: { file_path: '/etc/passwd' },
  agentId: 'agent-id',
});

if (!result.allowed) {
  console.error(result.reason);
}
```

### AuditLogger

```typescript
import { AuditLogger } from 'wunderland/security';

const logger = new AuditLogger({
  logFilePath: '~/.wunderland/security/violations.log',
  rotationSize: 10 * 1024 * 1024, // 10MB
  maxRotatedFiles: 5,
});

// Query violations
const violations = await logger.queryViolations({
  agentId: 'agent-id',
  severity: 'critical',
  limit: 100,
});

// Get statistics
const stats = await logger.getStats();
```

---

## Best Practices

1. **Start with deny-by-default**: Use `defaultPolicy: 'deny'` and explicitly allow needed paths
2. **Order rules carefully**: Most specific patterns first, general patterns last
3. **Use descriptive labels**: Add `description` to each rule for audit clarity
4. **Monitor violations regularly**: Review `violations.log` to catch misconfigurations
5. **Test with --dry-run**: Validate folder permissions before deploying to production
6. **Inherit from tier**: Use `inheritFromTier: true` for consistent baseline security
7. **Review tier defaults**: Understand what your security tier allows by default
8. **Alert on critical violations**: Configure webhooks for real-time alerts
9. **Rotate logs regularly**: Monitor log file size and adjust rotation settings
10. **Document overrides**: Comment why agent-specific overrides are needed

---

## Further Reading

- [Security Tiers Guide](./PRESETS_AND_PERMISSIONS.md#security-tiers)
- [Permission Sets](./PRESETS_AND_PERMISSIONS.md#permission-sets)
- [Tool Access Profiles](./PRESETS_AND_PERMISSIONS.md#tool-access-profiles)
- [Wunderland README](../README.md)
