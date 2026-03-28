# CLI Tools for Wunderland Agents

Wunderland agents interact with the host system through the `cli-executor` extension pack (`@framers/agentos-ext-cli-executor`). This document covers how agents use CLI tools, how security tiers gate access, and best practices for configuration.

For full details on the underlying CLI discovery system, see the [AgentOS CLI Registry documentation](../../../agentos/docs/features/CLI_REGISTRY.md).

## Available Tools

The cli-executor extension provides six tools:

| Tool Name | Description | Side Effects |
|-----------|-------------|-------------|
| `shell_execute` | Execute a shell command and return stdout/stderr/exit code | Yes |
| `file_read` | Read contents of a file (with line/byte limits) | No |
| `file_write` | Write content to a file (create or append) | Yes |
| `list_directory` | List files and directories (recursive, glob patterns) | No |
| `create_spreadsheet` | Create an Excel (.xlsx) or CSV file from structured data | Yes |
| `create_document` | Create a Word document (.docx) from text or markdown | Yes |

### shell_execute

The primary tool for running arbitrary commands. Every call goes through a security check before execution.

```json
{
  "command": "git status",
  "cwd": "/path/to/repo",
  "timeout": 30000
}
```

Returns: `{ command, exitCode, stdout, stderr, duration, success, cwd, shell }`

### file_read

Reads file contents with optional line-count limits, byte-range reads, or tail-mode.

```json
{
  "path": "report.csv",
  "lines": 50,
  "fromEnd": false
}
```

### file_write

Writes or appends content to a file. Can auto-create parent directories.

```json
{
  "path": "output/summary.txt",
  "content": "Analysis complete.",
  "append": true,
  "createDirs": true
}
```

### list_directory

Lists directory contents with optional recursion, hidden files, and glob filtering.

```json
{
  "path": ".",
  "recursive": true,
  "maxDepth": 3,
  "pattern": "*.ts",
  "includeStats": true
}
```

### create_spreadsheet / create_document

Generate Office-format files (.xlsx, .csv, .docx) from structured data or markdown content. These tools do not require the ShellService and operate independently.

## Security Tier Configuration

Wunderland's five security tiers control whether agents can use CLI tools at all, and with what restrictions. The tier is set in `agent.config.json` or via `wunderland init`.

| Tier | CLI Execution | File Read | File Write | External APIs | Permission Set |
|------|--------------|-----------|------------|---------------|----------------|
| `dangerous` | Yes | Yes | Yes | Yes | `unrestricted` |
| `permissive` | Yes | Yes | Yes | Yes | `autonomous` |
| `balanced` | Yes | Yes | No | Yes | `supervised` |
| `strict` | No | Yes | No | Yes | `supervised` |
| `paranoid` | No | Yes (read only) | No | No | `minimal` |

Key points:
- **`balanced`** (the recommended default) allows CLI execution and file reads, but blocks file writes. Agents can request write access to specific folders through the HITL approval flow via the `request_folder_access` tool.
- **`strict`** and **`paranoid`** block `shell_execute` entirely. The `shell_execute` tool is removed from the agent's tool list at startup.
- Even within `dangerous` and `permissive`, the ShellService still blocks inherently destructive patterns (`rm -rf /`, `mkfs`, fork bombs, `shutdown`, etc.) unless `dangerouslySkipSecurityChecks` is enabled.

## The dangerouslySkipSecurityChecks Option

Setting `dangerouslySkipSecurityChecks: true` in the cli-executor extension options disables:

- Dangerous command pattern matching (14 regex patterns covering `rm -rf /`, `dd`, fork bombs, `shutdown`, `passwd`, etc.)
- The `blockedCommands` deny list
- The `allowedCommands` whitelist check

It does **not** bypass:

- Filesystem path root restrictions (`readRoots` / `writeRoots`)
- Symlink escape detection
- The security tier's decision to exclude `shell_execute` from the tool list entirely

This flag is injected by the wunderland runtime when the user passes `--dangerously-skip-command-safety` to `wunderland start` or `wunderland chat`. It maps directly to the extension's `ShellConfig.dangerouslySkipSecurityChecks` field.

## How the Runtime Configures cli-executor

When `wunderland start` or `wunderland chat` runs, the extension loader (`src/cli/commands/start/extension-loader.ts`) configures the cli-executor with:

```typescript
{
  'cli-executor': {
    options: {
      workingDirectory: process.cwd(),
      filesystem: {
        allowRead: permissions.filesystem.read,   // from security tier
        allowWrite: permissions.filesystem.write,  // from security tier
        readRoots: [workspaceDir, homeDir, cwd, '/tmp'],
        writeRoots: [workspaceDir, homeDir, cwd, '/tmp'],
      },
      agentWorkspace: {
        agentId: workspaceAgentId,
        baseDir: workspaceBaseDir,
        createIfMissing: true,
        subdirs: ['assets', 'exports', 'tmp'],
      },
      dangerouslySkipSecurityChecks: dangerouslySkipCommandSafety,
    },
  },
}
```

The `agentWorkspace` setting creates a per-agent directory structure under `~/Documents/AgentOS/<agentId>/` with `assets/`, `exports/`, and `tmp/` subdirectories. This is the default working directory when no explicit `cwd` is passed to `shell_execute`.

## Filesystem Access Policy

The `filesystem` config object controls path-level access:

| Field | Type | Description |
|-------|------|-------------|
| `allowRead` | `boolean` | Enable file reads and directory listings |
| `allowWrite` | `boolean` | Enable file writes |
| `readRoots` | `string[]` | Allowed root directories for read/list operations |
| `writeRoots` | `string[]` | Allowed root directories for write operations |

All paths are resolved to absolute paths and checked against the configured roots. Symlink targets are resolved before authorization to prevent escapes. If a path falls outside all allowed roots, the operation is rejected with an error.

### Dynamic folder grants

When the `request_folder_access` tool is available (non-dangerous tiers), agents can request access to folders outside the default roots. The request goes through HITL approval. On approval, the runtime calls `shellService.addReadRoot()` or `shellService.addWriteRoot()` to expand the allowed roots at runtime.

## CLI Discovery and wunderland doctor

The `wunderland doctor` command performs health checks including API key validation, channel configuration, connectivity, and voice provider detection. While it uses `which` directly for specific binary checks (e.g., `signal-cli`), the underlying `CLIRegistry` system from AgentOS provides the broader capability scan.

The registry's scan results feed into:
- Provider auto-detection (e.g., detecting `claude` or `gemini` binaries for CLI-based LLM providers)
- Capability discovery engine indexing
- Extension recommendation system

## Best Practices

### 1. Use the balanced tier for production agents

The `balanced` tier gives agents enough capability to be useful (CLI execution, file reads, web access) while preventing accidental damage (no file writes without approval).

### 2. Scope filesystem roots narrowly

Override `readRoots` and `writeRoots` in your `agent.config.json` to limit agents to specific project directories:

```json
{
  "extensionOverrides": {
    "cli-executor": {
      "options": {
        "filesystem": {
          "allowRead": true,
          "allowWrite": true,
          "readRoots": ["/home/user/project"],
          "writeRoots": ["/home/user/project/output"]
        }
      }
    }
  }
}
```

### 3. Use allowedCommands for narrow use cases

If your agent only needs to run specific commands, whitelist them:

```json
{
  "extensionOverrides": {
    "cli-executor": {
      "options": {
        "allowedCommands": ["git", "npm", "node", "python3"]
      }
    }
  }
}
```

When `allowedCommands` is non-empty, only commands whose base binary matches an entry in the list are permitted. All others are rejected.

### 4. Use blockedCommands for deny-listing

Add project-specific blocked patterns on top of the built-in dangerous pattern list:

```json
{
  "extensionOverrides": {
    "cli-executor": {
      "options": {
        "blockedCommands": ["deploy", "publish", "npm publish"]
      }
    }
  }
}
```

### 5. Set appropriate timeouts

The default timeout is 60 seconds. Long-running commands (builds, large file operations) may need higher limits:

```json
{
  "extensionOverrides": {
    "cli-executor": {
      "options": {
        "timeout": 300000
      }
    }
  }
}
```

### 6. Never use dangerouslySkipSecurityChecks in production

This flag exists for testing and development only. In production, rely on the security tier system and granular permission sets to control agent behavior.

## Configuration Reference

The full `ShellConfig` interface accepted by the cli-executor extension:

```typescript
interface ShellConfig {
  defaultShell?: 'bash' | 'powershell' | 'cmd' | 'zsh' | 'sh' | 'auto';
  timeout?: number;                          // default: 60000
  workingDirectory?: string;
  filesystem?: {
    allowRead?: boolean;
    allowWrite?: boolean;
    readRoots?: string[];
    writeRoots?: string[];
  };
  agentWorkspace?: {
    enabled?: boolean;                       // default: true
    baseDir?: string;                        // default: ~/Documents/AgentOS
    agentId: string;
    createIfMissing?: boolean;               // default: true
    subdirs?: string[];                      // default: ['assets','exports','tmp']
  };
  allowedCommands?: string[];
  blockedCommands?: string[];
  dangerouslySkipSecurityChecks?: boolean;   // default: false
  env?: Record<string, string>;
}
```
