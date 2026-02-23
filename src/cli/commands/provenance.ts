/**
 * @fileoverview `wunderland provenance` — audit trail and event verification.
 *
 * Wires up to the local SignedEventLedger and ChainVerifier from @framers/agentos.
 * The audit command shows chain state; verify validates chain integrity.
 *
 * @module wunderland/cli/commands/provenance
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor, error as eColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

interface ProvenanceModules {
  AgentKeyManager: any;
  SignedEventLedger: any;
  ChainVerifier: any;
}

async function tryLoadProvenance(): Promise<ProvenanceModules | null> {
  try {
    const mod = await import('@framers/agentos');
    if (mod.AgentKeyManager && mod.SignedEventLedger && mod.ChainVerifier) {
      return {
        AgentKeyManager: mod.AgentKeyManager,
        SignedEventLedger: mod.SignedEventLedger,
        ChainVerifier: mod.ChainVerifier,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function loadAgentConfig(): { config: any; configPath: string } | null {
  const configPath = path.resolve(process.cwd(), 'agent.config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf8');
    return { config: JSON.parse(raw), configPath };
  } catch {
    return null;
  }
}

export default async function cmdProvenance(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (!sub || sub === 'help') {
    fmt.section('wunderland provenance');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('audit')}                  Show audit trail and chain state
    ${dim('verify')}                 Verify chain integrity (signatures + hashes)
    ${dim('demo')}                   Create a demo chain and verify it

  ${accent('Flags:')}
    ${dim('--agent <id>')}           Filter by agent
    ${dim('--format json|table')}    Output format
`);
    return;
  }

  try {
    const modules = await tryLoadProvenance();

    if (!modules) {
      fmt.errorBlock(
        'Provenance Unavailable',
        '@framers/agentos is not installed or does not export provenance modules.\nEnsure it is built: cd packages/agentos && pnpm build',
      );
      process.exitCode = 1;
      return;
    }

    const { AgentKeyManager, SignedEventLedger, ChainVerifier } = modules;

    if (sub === 'audit') {
      const agentId = typeof flags['agent'] === 'string' ? flags['agent'] : undefined;
      const loaded = loadAgentConfig();

      fmt.section('Provenance Audit Trail');

      if (!loaded) {
        fmt.note('No agent.config.json found in current directory.');
        fmt.note(`Initialize an agent first: ${accent('wunderland init <name>')}`);
        fmt.note(`Or run: ${accent('wunderland provenance demo')} to see a demo chain.`);
        fmt.blank();
        return;
      }

      const cfg = loaded.config;
      const provenanceCfg = cfg.provenance || cfg.security?.provenance;
      const enabled = provenanceCfg?.enabled === true;

      fmt.kvPair('Agent', cfg.seedId || cfg.displayName || 'unknown');
      fmt.kvPair('Provenance Enabled', enabled ? sColor('yes') : muted('no'));

      if (provenanceCfg) {
        fmt.kvPair('Signature Mode', provenanceCfg.signatureMode || 'not set');
        fmt.kvPair('Hash Algorithm', provenanceCfg.hashAlgorithm || 'sha256');
        fmt.kvPair('Key Source', provenanceCfg.keySource?.type || 'not set');
      }

      if (!enabled) {
        fmt.blank();
        fmt.note('Provenance is not enabled for this agent.');
        fmt.note(`Enable it in agent.config.json:`);
        console.log(dim(`    {
      "provenance": {
        "enabled": true,
        "signatureMode": "every-event",
        "hashAlgorithm": "sha256",
        "keySource": { "type": "generate" }
      }
    }`));
        fmt.blank();
        return;
      }

      if (agentId) fmt.kvPair('Agent Filter', agentId);

      fmt.blank();
      fmt.note('Chain events are recorded during agent runtime.');
      fmt.note(`Start an agent with: ${accent('wunderland start')}`);
      fmt.blank();

    } else if (sub === 'verify') {
      fmt.section('Chain Verification');

      // Check if there's a JSON file with events to verify
      const eventFile = args[1];
      if (eventFile) {
        const filePath = path.resolve(process.cwd(), eventFile);
        if (!existsSync(filePath)) {
          fmt.errorBlock('File not found', `Cannot read event file: ${filePath}`);
          process.exitCode = 1;
          return;
        }

        const raw = await readFile(filePath, 'utf8');
        const events = JSON.parse(raw);
        const eventsArray = Array.isArray(events) ? events : events.events || [];

        if (eventsArray.length === 0) {
          fmt.note('No events found in file.');
          fmt.blank();
          return;
        }

        const result = await ChainVerifier.verify(eventsArray);

        if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }

        if (result.valid) {
          fmt.successBlock('Chain Verified', `${result.eventsVerified} events verified successfully.`);
        } else {
          fmt.errorBlock('Chain Invalid', `${result.errors.length} error(s) found.`);
        }

        fmt.kvPair('Events Verified', String(result.eventsVerified));
        if (result.firstSequence != null) fmt.kvPair('First Sequence', String(result.firstSequence));
        if (result.lastSequence != null) fmt.kvPair('Last Sequence', String(result.lastSequence));
        if (result.agentId) fmt.kvPair('Agent ID', result.agentId);
        fmt.kvPair('Verified At', result.verifiedAt);

        if (result.errors.length > 0) {
          const g = glyphs();
          console.log(`\n  ${eColor('Errors:')}`);
          for (const err of result.errors) {
            console.log(`    ${eColor(g.fail)} ${err.code}: ${err.message}`);
          }
        }

        if (result.warnings.length > 0) {
          const g = glyphs();
          console.log(`\n  ${accent('Warnings:')}`);
          for (const w of result.warnings) {
            console.log(`    ${muted(g.warn)} ${w}`);
          }
        }

        fmt.blank();
        return;
      }

      // No file specified — give instructions
      fmt.note('Verify a chain from a JSON file:');
      fmt.note(`  ${accent('wunderland provenance verify events.json')}`);
      fmt.note(`Or try: ${accent('wunderland provenance demo')} to create and verify a demo chain.`);
      fmt.blank();

    } else if (sub === 'demo') {
      fmt.section('Provenance Demo');
      fmt.note('Creating demo signed event chain...');
      fmt.blank();

      // Create an in-memory storage adapter
      const store: any[] = [];

      const memoryAdapter = {
        async run(statement: string, parameters?: unknown[]): Promise<{ changes: number }> {
          if (statement.includes('CREATE TABLE')) {
            return { changes: 0 };
          }
          if (statement.includes('INSERT')) {
            // Parse and store the event
            if (parameters && parameters.length >= 9) {
              store.push({
                id: parameters[0],
                type: parameters[1],
                timestamp: parameters[2],
                sequence: parameters[3],
                agent_id: parameters[4],
                prev_hash: parameters[5],
                hash: parameters[6],
                payload_hash: parameters[7],
                payload: parameters[8],
                signature: parameters[9] || '',
              });
            }
            return { changes: 1 };
          }
          return { changes: 0 };
        },
        async all<T = unknown>(statement: string, _parameters?: unknown[]): Promise<T[]> {
          if (statement.includes('SELECT') && statement.includes('ORDER BY sequence')) {
            return store.sort((a, b) => a.sequence - b.sequence) as T[];
          }
          return store as T[];
        },
        async get<T = unknown>(statement: string, parameters?: unknown[]): Promise<T | null> {
          if (statement.includes('MAX(sequence)')) {
            const maxSeq = store.length > 0 ? Math.max(...store.map(s => s.sequence)) : null;
            return (maxSeq != null ? { sequence: maxSeq, hash: store.find(s => s.sequence === maxSeq)?.hash } : null) as T;
          }
          if (parameters && parameters.length > 0) {
            return (store.find(s => s.id === parameters[0]) || null) as T;
          }
          return null;
        },
      };

      // Generate a keypair
      const keyManager = await AgentKeyManager.generate('demo-agent');
      const config = {
        enabled: true,
        signatureMode: 'every-event' as const,
        hashAlgorithm: 'sha256' as const,
        keySource: { type: 'generate' as const },
      };

      const ledger = new SignedEventLedger(memoryAdapter, keyManager, 'demo-agent', config);
      await ledger.initialize();

      // Append demo events
      const events = [
        { type: 'agent.started', payload: { version: '0.16.0', mode: 'demo' } },
        { type: 'message.received', payload: { from: 'user', content: 'Hello!' } },
        { type: 'tool.invoked', payload: { tool: 'web_search', query: 'Wunderland AI' } },
        { type: 'message.sent', payload: { to: 'user', content: 'I found some results about Wunderland.' } },
        { type: 'agent.stopped', payload: { reason: 'demo_complete' } },
      ];

      const signedEvents: any[] = [];
      for (const evt of events) {
        const signed = await ledger.appendEvent(evt.type as any, evt.payload);
        signedEvents.push(signed);
      }

      const chainState = ledger.getChainState();

      // Display the chain
      for (const evt of signedEvents) {
        const g = glyphs();
        const icon = sColor(g.ok);
        console.log(`  ${icon} ${dim(`#${evt.sequence}`)} ${accent(evt.type)} ${dim(evt.timestamp)}`);
        console.log(`    ${dim('hash:')} ${muted(evt.hash.substring(0, 16))}...`);
        console.log(`    ${dim('sig:')}  ${muted(evt.signature.substring(0, 16))}...`);
      }

      fmt.blank();
      fmt.kvPair('Chain Length', String(signedEvents.length));
      fmt.kvPair('Last Hash', chainState.lastHash.substring(0, 32) + '...');
      fmt.kvPair('Last Sequence', String(chainState.sequence));

      // Verify the chain
      fmt.blank();
      fmt.note('Verifying chain integrity...');

      const result = await ChainVerifier.verify(signedEvents);

      if (result.valid) {
        fmt.successBlock('Chain Verified', `${result.eventsVerified} events - all hashes and signatures valid.`);
      } else {
        fmt.errorBlock('Chain Invalid', `${result.errors.length} error(s) found.`);
        for (const err of result.errors) {
          const g = glyphs();
          console.log(`    ${eColor(g.fail)} ${err.code}: ${err.message}`);
        }
      }

      fmt.blank();

    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland provenance')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Provenance Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
