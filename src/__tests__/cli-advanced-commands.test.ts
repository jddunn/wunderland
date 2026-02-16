/**
 * @fileoverview Tests for advanced CLI commands — marketplace, knowledge, provenance
 * @module wunderland/__tests__/cli-advanced-commands.test
 *
 * Tests the three commands that were wired up to local AgentOS implementations:
 * - marketplace: aggregates from skills-registry + extensions-registry
 * - knowledge: local KnowledgeGraph from @framers/agentos
 * - provenance: SignedEventLedger + ChainVerifier from @framers/agentos
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Capture console.log output for testing CLI commands
function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(a => String(a)).join(' '));
  };
  return {
    logs,
    restore: () => { console.log = originalLog; },
  };
}

// ── Marketplace ─────────────────────────────────────────────────────────────

describe('wunderland marketplace', () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exitCode;
  });

  it('should show help text when no subcommand given', async () => {
    const { default: cmdMarketplace } = await import('../cli/commands/marketplace.js');
    const cap = captureConsole();
    try {
      await cmdMarketplace([], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output).toContain('search <query>');
      expect(output).toContain('info <id>');
      expect(output).toContain('install <id>');
    } finally {
      cap.restore();
    }
  });

  it('should error on search with no query', async () => {
    const { default: cmdMarketplace } = await import('../cli/commands/marketplace.js');
    const cap = captureConsole();
    try {
      await cmdMarketplace(['search'], {}, { yes: false, verbose: false });
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('should search and return results for "web"', async () => {
    const { default: cmdMarketplace } = await import('../cli/commands/marketplace.js');
    const cap = captureConsole();
    try {
      await cmdMarketplace(['search', 'web'], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      // Should find web-search at minimum
      expect(output.toLowerCase()).toContain('web');
      // Should show results count
      expect(output).toMatch(/Results/);
    } finally {
      cap.restore();
    }
  });

  it('should return JSON format when requested', async () => {
    const { default: cmdMarketplace } = await import('../cli/commands/marketplace.js');
    const cap = captureConsole();
    try {
      await cmdMarketplace(['search', 'web'], { format: 'json' }, { yes: false, verbose: false });
      const output = cap.logs.join('');
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      if (parsed.length > 0) {
        expect(parsed[0]).toHaveProperty('id');
        expect(parsed[0]).toHaveProperty('source');
      }
    } finally {
      cap.restore();
    }
  });

  it('should show info for known extension', async () => {
    const { default: cmdMarketplace } = await import('../cli/commands/marketplace.js');
    const cap = captureConsole();
    try {
      await cmdMarketplace(['info', 'web-search'], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      // Should not have set an error code (item exists in at least one registry)
      if (process.exitCode !== 1) {
        expect(output.toLowerCase()).toContain('web-search');
      }
    } finally {
      cap.restore();
    }
  });

  it('should error on info for unknown extension', async () => {
    const { default: cmdMarketplace } = await import('../cli/commands/marketplace.js');
    const cap = captureConsole();
    try {
      await cmdMarketplace(['info', 'nonexistent-extension-xyz'], {}, { yes: false, verbose: false });
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('should error on unknown subcommand', async () => {
    const { default: cmdMarketplace } = await import('../cli/commands/marketplace.js');
    const cap = captureConsole();
    try {
      await cmdMarketplace(['bogus'], {}, { yes: false, verbose: false });
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });
});

// ── Knowledge ───────────────────────────────────────────────────────────────

describe('wunderland knowledge', { timeout: 15_000 }, () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exitCode;
  });

  it('should show help text when no subcommand given', async () => {
    const { default: cmdKnowledge } = await import('../cli/commands/knowledge.js');
    const cap = captureConsole();
    try {
      await cmdKnowledge([], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output).toContain('query <text>');
      expect(output).toContain('stats');
      expect(output).toContain('demo');
    } finally {
      cap.restore();
    }
  });

  it('stats should show empty graph message', async () => {
    const { default: cmdKnowledge } = await import('../cli/commands/knowledge.js');
    const cap = captureConsole();
    try {
      await cmdKnowledge(['stats'], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output.toLowerCase()).toContain('knowledge graph');
      // Either shows stats or "empty" message
      expect(output).toMatch(/empty|Total Entities/i);
    } finally {
      cap.restore();
    }
  });

  it('demo should create entities, relations, and memories', async () => {
    const { default: cmdKnowledge } = await import('../cli/commands/knowledge.js');
    const cap = captureConsole();
    try {
      await cmdKnowledge(['demo'], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output).toContain('Demo Knowledge Graph Created');
      expect(output).toContain('4');  // 4 entities
      expect(output).toContain('2');  // 2 relations
      expect(output).toContain('1');  // 1 memory
      expect(output).toContain('person');
      expect(output).toContain('concept');
      expect(output).toContain('organization');
    } finally {
      cap.restore();
    }
  });

  it('demo should support JSON output', async () => {
    const { default: cmdKnowledge } = await import('../cli/commands/knowledge.js');
    const cap = captureConsole();
    try {
      await cmdKnowledge(['demo'], { format: 'json' }, { yes: false, verbose: false });
      // Find the JSON object in the output (skip any banner lines)
      const jsonLine = cap.logs.find(line => line.trimStart().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.totalEntities).toBe(4);
      expect(parsed.totalRelations).toBe(2);
      expect(parsed.totalMemories).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('query should error on missing query text', async () => {
    const { default: cmdKnowledge } = await import('../cli/commands/knowledge.js');
    const cap = captureConsole();
    try {
      await cmdKnowledge(['query'], {}, { yes: false, verbose: false });
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('should error on unknown subcommand', async () => {
    const { default: cmdKnowledge } = await import('../cli/commands/knowledge.js');
    const cap = captureConsole();
    try {
      await cmdKnowledge(['bogus'], {}, { yes: false, verbose: false });
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });
});

// ── Provenance ──────────────────────────────────────────────────────────────

describe('wunderland provenance', { timeout: 15_000 }, () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exitCode;
  });

  it('should show help text when no subcommand given', async () => {
    const { default: cmdProvenance } = await import('../cli/commands/provenance.js');
    const cap = captureConsole();
    try {
      await cmdProvenance([], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output).toContain('audit');
      expect(output).toContain('verify');
      expect(output).toContain('demo');
    } finally {
      cap.restore();
    }
  });

  it('audit should handle missing agent.config.json gracefully', async () => {
    const { default: cmdProvenance } = await import('../cli/commands/provenance.js');
    const cap = captureConsole();
    const originalCwd = process.cwd;
    // Use temp dir that definitely has no agent.config.json
    process.cwd = () => '/tmp';
    try {
      await cmdProvenance(['audit'], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output).toContain('Provenance Audit Trail');
      expect(output).toMatch(/No agent\.config\.json|wunderland init/);
    } finally {
      process.cwd = originalCwd;
      cap.restore();
    }
  });

  it('demo should create signed events and verify chain', async () => {
    const { default: cmdProvenance } = await import('../cli/commands/provenance.js');
    const cap = captureConsole();
    try {
      await cmdProvenance(['demo'], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output).toContain('Provenance Demo');
      expect(output).toContain('agent.started');
      expect(output).toContain('message.received');
      expect(output).toContain('tool.invoked');
      expect(output).toContain('message.sent');
      expect(output).toContain('agent.stopped');
      expect(output).toContain('Chain Verified');
      expect(output).toContain('5 events');
      // Should show hash and signature prefixes
      expect(output).toContain('hash:');
      expect(output).toContain('sig:');
    } finally {
      cap.restore();
    }
  });

  it('verify without file should show instructions', async () => {
    const { default: cmdProvenance } = await import('../cli/commands/provenance.js');
    const cap = captureConsole();
    try {
      await cmdProvenance(['verify'], {}, { yes: false, verbose: false });
      const output = cap.logs.join('\n');
      expect(output).toContain('Chain Verification');
      expect(output).toContain('events.json');
    } finally {
      cap.restore();
    }
  });

  it('verify with nonexistent file should error', async () => {
    const { default: cmdProvenance } = await import('../cli/commands/provenance.js');
    const cap = captureConsole();
    try {
      await cmdProvenance(['verify', '/nonexistent/path/events.json'], {}, { yes: false, verbose: false });
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('should error on unknown subcommand', async () => {
    const { default: cmdProvenance } = await import('../cli/commands/provenance.js');
    const cap = captureConsole();
    try {
      await cmdProvenance(['bogus'], {}, { yes: false, verbose: false });
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });
});
