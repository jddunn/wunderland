// @ts-nocheck
/**
 * @fileoverview Imports the security and tool-access surface the way an installed consumer does.
 * @module wunderland/__tests__/consumer-entries.integration.test
 *
 * A throwaway project links this package into its own `node_modules`, so every
 * import below goes through the `exports` map in package.json and lands on the
 * built `dist`, as it does for a host application. Plain Node runs the value
 * imports, where a name missing from an entry fails at link time, and the
 * TypeScript compiler checks the same imports, where a type-only name such as
 * `FolderPermissionConfig` exists at all. The CI lane builds before this file runs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Parsing the agentos declarations takes a while on a CI runner. */
const COMPILE_TIMEOUT_MS = 180_000;

const SECURITY_IMPORTS = `import { IntentChainTracker, SafeGuardrails, SignedOutputVerifier } from 'wunderland/security';`;
const TOOLS_IMPORTS = `import {
  TOOL_CATEGORY_MAP,
  createFeedSearchTool,
  describePermissions,
  getToolAccessProfile,
  isToolAllowedByProfile,
  isValidToolAccessProfile,
  resolveAllowedTools,
} from 'wunderland/tools';`;

const RUNTIME_CONSUMER = `${SECURITY_IMPORTS}
${TOOLS_IMPORTS}

const verifier = new SignedOutputVerifier();
const payload = { seedId: 'seed-consumer' };
const tracker = new IntentChainTracker();
const guardrails = new SafeGuardrails({ enableAuditLogging: false, enableNotifications: false });
guardrails.setFolderPermissions('seed-consumer', { defaultPolicy: 'deny', rules: [], inheritFromTier: false });
const unconfigured = await guardrails.validateBeforeExecution({
  toolId: 'file_read',
  toolName: 'file_read',
  args: { file_path: '/tmp/any-file' },
  agentId: 'seed-with-no-folder-permissions',
});
const profile = getToolAccessProfile('social-citizen');
const allowed = resolveAllowedTools(profile, Object.keys(TOOL_CATEGORY_MAP));
const feedTool = createFeedSearchTool(async () => ({ items: [{ text: 'a post' }], context: 'a post' }));
const feed = await feedTool.execute({ query: 'posts' }, {});

console.log(JSON.stringify({
  signatureVerified: verifier.verifyPayload(payload, verifier.signPayload(payload)),
  intentEntries: tracker.getEntries().length,
  deniesUnconfiguredAgent: !unconfigured.allowed,
  knownProfile: isValidToolAccessProfile('social-citizen'),
  unknownProfile: isValidToolAccessProfile('no-such-profile'),
  allowsFeedSearch: allowed.includes('feed_search'),
  allowsCli: allowed.includes('cli_executor'),
  checksOneTool: isToolAllowedByProfile(profile, 'web_search'),
  describesFilesystem: describePermissions(profile).cannot.includes('Access the file system'),
  feedToolName: feedTool.name,
  feedSucceeded: feed.success,
}));
`;

const TYPED_CONSUMER = `${SECURITY_IMPORTS}
import type {
  AgentMode,
  ContextFirewallConfig,
  FolderPermissionConfig,
  IntentChainEntry,
} from 'wunderland/security';
${TOOLS_IMPORTS}

export const folderPermissions: FolderPermissionConfig = {
  defaultPolicy: 'deny',
  rules: [],
  inheritFromTier: false,
};

// Fails as an unused directive if the name resolves to \`any\`.
// @ts-expect-error defaultPolicy takes 'allow' or 'deny'.
export const refused: FolderPermissionConfig = { defaultPolicy: 'maybe', rules: [], inheritFromTier: false };

export const guardrails: SafeGuardrails = new SafeGuardrails({ enableAuditLogging: false });
export const verifier: SignedOutputVerifier = new SignedOutputVerifier();
export const tracker: IntentChainTracker = new IntentChainTracker();
export const entries: readonly IntentChainEntry[] = tracker.getEntries();
export const mode: AgentMode = 'private';
export const firewall: Partial<ContextFirewallConfig> = { mode };
export const allowed: string[] = isValidToolAccessProfile('social-citizen')
  ? resolveAllowedTools(getToolAccessProfile('social-citizen'), Object.keys(TOOL_CATEGORY_MAP))
  : [];
export const feedTool = createFeedSearchTool(async () => ({ items: [], context: '' }));
`;

describe('a project that installs wunderland', () => {
  let project: string;

  beforeAll(() => {
    expect(existsSync(path.join(PKG_ROOT, 'dist/index.js')), 'this file reads dist: build first').toBe(true);
    project = realpathSync(mkdtempSync(path.join(tmpdir(), 'wunderland-consumer-')));
    mkdirSync(path.join(project, 'node_modules'));
    symlinkSync(PKG_ROOT, path.join(project, 'node_modules/wunderland'), 'dir');
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module' }));
    writeFileSync(path.join(project, 'consumer.mjs'), RUNTIME_CONSUMER);
    writeFileSync(path.join(project, 'consumer.ts'), TYPED_CONSUMER);
  });

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it('runs the security classes, the tool-access helpers and the feed search tool under plain Node', () => {
    const run = spawnSync(process.execPath, ['consumer.mjs'], { cwd: project, encoding: 'utf8' });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      signatureVerified: true,
      intentEntries: 0,
      deniesUnconfiguredAgent: true,
      knownProfile: true,
      unknownProfile: false,
      allowsFeedSearch: true,
      allowsCli: false,
      checksOneTool: true,
      describesFilesystem: true,
      feedToolName: 'feed_search',
      feedSucceeded: true,
    });
  });

  it.each([
    ['NodeNext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    // A host compiled with `moduleResolution: bundler`, as Nest and Next backends are.
    ['Bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ])(
    'compiles the same imports, FolderPermissionConfig included, against the published declarations under %s resolution',
    (_name, module, moduleResolution) => {
      const file = path.join(project, 'consumer.ts');
      const program = ts.createProgram([file], {
        module,
        moduleResolution,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      });

      const messages = ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.file?.fileName === file)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

      expect(messages).toEqual([]);
    },
    COMPILE_TIMEOUT_MS,
  );
});
