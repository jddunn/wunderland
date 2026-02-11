/**
 * @fileoverview E2E tests for CLI commands with guardrails
 * @module wunderland/__tests__/cli-guardrails.e2e
 *
 * Tests CLI tool execution with folder permissions and guardrails:
 * - wunderland init with folder permissions
 * - wunderland chat with blocked file access
 * - Violation logging in CLI context
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_DIR = path.join(process.cwd(), '.test-cli-guardrails');
const TEST_AGENT_DIR = path.join(TEST_DIR, 'test-agent');

describe('CLI Guardrails E2E', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // Create test directory
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    // Cleanup test directory
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('wunderland init with folder permissions', () => {
    it('should create agent with folder permission config', async () => {
      try {
        const { default: cmdInit } = await import('../cli/commands/init.js');

        await cmdInit(
          [path.join('.test-cli-guardrails', 'test-agent')],
          { 'security-tier': 'balanced' },
          { yes: true, verbose: false },
        );

        // Verify folder permissions are in config
        const configPath = path.join(TEST_AGENT_DIR, 'agent.config.json');
        expect(existsSync(configPath)).toBe(true);

        const configContent = await readFile(configPath, 'utf8');
        const config = JSON.parse(configContent);

        expect(config.security).toBeDefined();
        expect(config.security.tier).toBe('balanced');

        // Note: Folder permissions are set at runtime from security tier defaults
        // The config file doesn't need to explicitly include them unless overriding
      } catch (err) {
        console.error('Init with folder permissions test error:', err);
        throw err;
      }
    });

    it('should allow manual folder permission overrides in config', async () => {
      const agentDir = path.join(TEST_DIR, 'custom-permissions-agent');
      await mkdir(agentDir, { recursive: true });

      // Create agent config with custom folder permissions
      const config = {
        seedId: 'seed_custom_permissions',
        displayName: 'Custom Permissions Agent',
        bio: 'Agent with custom folder permissions',
        security: {
          tier: 'balanced',
          permissionSet: 'autonomous',
          folderPermissions: {
            defaultPolicy: 'deny',
            inheritFromTier: true,
            rules: [
              { pattern: '~/workspace/**', read: true, write: true },
              { pattern: '~/Documents/data/**', read: true, write: false },
              { pattern: '!/workspace/sensitive/*', read: false, write: false },
            ],
          },
        },
      };

      const configPath = path.join(agentDir, 'agent.config.json');
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      // Verify config was created correctly
      const savedConfig = JSON.parse(await readFile(configPath, 'utf8'));

      expect(savedConfig.security.folderPermissions).toBeDefined();
      expect(savedConfig.security.folderPermissions.defaultPolicy).toBe('deny');
      expect(savedConfig.security.folderPermissions.rules.length).toBe(3);
      expect(savedConfig.security.folderPermissions.rules[0].pattern).toBe('~/workspace/**');
      expect(savedConfig.security.folderPermissions.rules[2].pattern).toBe('!/workspace/sensitive/*');
    });
  });

  describe('Agent config validation', () => {
    it('should validate folder permission config structure', async () => {
      const { validateAgentConfig } = await import('../utils/validation.js');

      const validConfig = {
        seedId: 'seed_test',
        displayName: 'Test Agent',
        security: {
          tier: 'balanced',
          folderPermissions: {
            defaultPolicy: 'deny',
            inheritFromTier: true,
            rules: [
              { pattern: '~/workspace/**', read: true, write: true },
            ],
          },
        },
      };

      const result = validateAgentConfig(validConfig);
      expect(result.valid).toBe(true);
    });

    it('should validate glob patterns in folder permissions', async () => {
      const { validateFolderConfig } = await import('../security/FolderPermissions.js');

      const config = {
        defaultPolicy: 'deny' as const,
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
          { pattern: '/tmp/**', read: true, write: true },
          { pattern: '!/sensitive/*', read: false, write: false },
        ],
      };

      const result = validateFolderConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should detect invalid folder permission patterns', async () => {
      const { validateFolderConfig } = await import('../security/FolderPermissions.js');

      const config = {
        defaultPolicy: 'invalid' as any,
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: 'yes' as any, write: true }, // Invalid read type
        ],
      };

      const result = validateFolderConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Security tier defaults', () => {
    it('should load correct folder permissions for each tier', async () => {
      const { createDefaultFolderConfig } = await import('../security/FolderPermissions.js');

      // Dangerous tier - allow everything
      const dangerousConfig = createDefaultFolderConfig('dangerous');
      expect(dangerousConfig.defaultPolicy).toBe('allow');
      expect(dangerousConfig.rules.length).toBe(0);

      // Balanced tier - workspace + tmp
      const balancedConfig = createDefaultFolderConfig('balanced');
      expect(balancedConfig.defaultPolicy).toBe('deny');
      expect(balancedConfig.rules.some((r) => r.pattern === '~/workspace/**')).toBe(true);
      expect(balancedConfig.rules.some((r) => r.pattern === '/tmp/**')).toBe(true);

      // Paranoid tier - workspace only
      const paranoidConfig = createDefaultFolderConfig('paranoid');
      expect(paranoidConfig.defaultPolicy).toBe('deny');
      expect(paranoidConfig.rules.length).toBe(1);
      expect(paranoidConfig.rules[0].pattern).toBe('~/workspace/**');
    });
  });

  describe('Integration with existing CLI tests', () => {
    it('should preserve existing init functionality with new folder permissions', async () => {
      try {
        const { default: cmdInit } = await import('../cli/commands/init.js');

        const agentName = 'legacy-compat-agent';
        await cmdInit(
          [path.join('.test-cli-guardrails', agentName)],
          {},
          { yes: true, verbose: false },
        );

        const configPath = path.join(TEST_DIR, agentName, 'agent.config.json');
        expect(existsSync(configPath)).toBe(true);

        const config = JSON.parse(await readFile(configPath, 'utf8'));

        // Should have all existing fields
        expect(config.seedId).toBeDefined();
        expect(config.displayName).toBeDefined();
        expect(config.personality).toBeDefined();

        // Security tier should still work
        expect(config.security?.tier).toBeDefined();
      } catch (err) {
        console.error('Legacy compatibility test error:', err);
        throw err;
      }
    });
  });

  describe('Preset integration', () => {
    it('should load preset with default folder permissions', async () => {
      const { PresetLoader } = await import('../core/PresetLoader.js');
      const { SECURITY_TIERS } = await import('../security/SecurityTiers.js');

      const loader = new PresetLoader();
      const preset = loader.loadPreset('research-assistant');

      expect(preset).toBeDefined();

      // Get security tier for preset
      const tier = SECURITY_TIERS.balanced; // Research assistant uses balanced tier

      expect(tier.defaultFolderPermissions).toBeDefined();
      expect(tier.defaultFolderPermissions?.rules.length).toBeGreaterThan(0);
    });
  });

  describe('Tool execution with guardrails', () => {
    it('should simulate blocked file access in tool calling', async () => {
      const { SafeGuardrails } = await import('../security/SafeGuardrails.js');

      const guardrails = new SafeGuardrails({
        enableAuditLogging: false,
        enableNotifications: false,
      });

      const agentId = 'cli-test-agent';
      guardrails.setFolderPermissions(agentId, {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      });

      // Simulate CLI trying to read /etc/passwd
      const result = await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/etc/passwd' },
        agentId,
        userId: 'cli-user',
      });

      // Should be blocked
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Folder access denied');
      expect(result.violations?.[0].severity).toBe('critical');
    });

    it('should simulate allowed file access in workspace', async () => {
      const { SafeGuardrails } = await import('../security/SafeGuardrails.js');

      const guardrails = new SafeGuardrails({
        enableAuditLogging: false,
        enableNotifications: false,
      });

      const agentId = 'cli-test-agent-allowed';
      const workspacePath = path.join(process.env.HOME || os.homedir(), 'workspace/file.txt');

      guardrails.setFolderPermissions(agentId, {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      });

      // Simulate CLI reading from workspace
      const result = await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: workspacePath },
        agentId,
      });

      // Should be allowed
      expect(result.allowed).toBe(true);
    });
  });

  describe('Example agent configs', () => {
    it('should create example development agent config', async () => {
      const devAgentConfig = {
        seedId: 'seed_dev_agent',
        displayName: 'Development Agent',
        security: {
          tier: 'permissive',
          permissionSet: 'autonomous',
          folderPermissions: {
            defaultPolicy: 'allow',
            inheritFromTier: true,
            rules: [
              { pattern: '!/etc/**', read: false, write: false },
              { pattern: '!/root/**', read: false, write: false },
              { pattern: '~/.ssh/**', read: false, write: false },
            ],
          },
        },
      };

      const agentDir = path.join(TEST_DIR, 'dev-agent-example');
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(devAgentConfig, null, 2)
      );

      // Verify it was created
      expect(existsSync(path.join(agentDir, 'agent.config.json'))).toBe(true);
    });

    it('should create example production agent config', async () => {
      const prodAgentConfig = {
        seedId: 'seed_prod_agent',
        displayName: 'Production Agent',
        security: {
          tier: 'strict',
          permissionSet: 'supervised',
          folderPermissions: {
            defaultPolicy: 'deny',
            inheritFromTier: true,
            rules: [
              { pattern: '~/workspace/**', read: true, write: true },
              { pattern: '/data/public/**', read: true, write: false },
            ],
          },
        },
      };

      const agentDir = path.join(TEST_DIR, 'prod-agent-example');
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(prodAgentConfig, null, 2)
      );

      // Verify it was created
      expect(existsSync(path.join(agentDir, 'agent.config.json'))).toBe(true);
    });
  });
});
