// @ts-nocheck
/**
 * @fileoverview Integration tests for capability manifests in Wunderland's capability discovery.
 * @module wunderland/__tests__/discovery-manifests.integration.test
 *
 * A `.wunderland/capabilities` folder holds one capability whose skill file lies
 * in its folder and one whose `skillContent` leaves it. The discovery manager
 * runs its real path, with embeddings from a local OpenAI-compatible server:
 * the provider, the embedding manager, the scan of its default manifest
 * folders and the capability index. The capability that leaves its folder is
 * refused and the file outside is read into nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { CapabilityManifestScanner, WunderlandDiscoveryManager } from '../platform/discovery/discovery-index.js';

/** The width of text-embedding-3-small, the model the manager picks for the openai provider. */
const DIMENSION = 1536;

const OUTSIDE_TEXT = 'OUTSIDE-FILE-TEXT';
const SKILL_TEXT = 'NOTES-HELPER-SKILL-TEXT';

/** A fixed vector for a text: its characters counted into buckets, never all zero. */
function embed(text: string): number[] {
  const vector = new Array(DIMENSION).fill(0.001);
  for (let i = 0; i < text.length; i++) vector[text.charCodeAt(i) % DIMENSION] += 1;
  return vector;
}

/** Serves the two OpenAI endpoints the discovery manager calls: the model list and embeddings. */
async function startEmbeddingServer(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'text-embedding-3-small', object: 'model', created: 0, owned_by: 'test' }],
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        const input = JSON.parse(body).input;
        const texts = Array.isArray(input) ? input : [input];
        res.end(JSON.stringify({
          object: 'list',
          data: texts.map((text, index) => ({ object: 'embedding', index, embedding: embed(String(text)) })),
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: texts.length, total_tokens: texts.length },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${req.url}` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return server;
}

/**
 * `<root>/project/.wunderland/capabilities` with `notes-helper`, whose SKILL.md
 * lies in its folder, and `escape`, whose skillContent names
 * `<root>/outside/secret.md`.
 */
function writeCapabilities(root: string): { capabilities: string; escapeManifest: string } {
  const capabilities = path.join(root, 'project', '.wunderland', 'capabilities');
  mkdirSync(path.join(capabilities, 'notes-helper'), { recursive: true });
  mkdirSync(path.join(capabilities, 'escape'), { recursive: true });
  mkdirSync(path.join(root, 'outside'));
  writeFileSync(path.join(root, 'outside', 'secret.md'), `${OUTSIDE_TEXT}\n`);

  writeFileSync(
    path.join(capabilities, 'notes-helper', 'CAPABILITY.yaml'),
    ['kind: skill', 'name: notes-helper', 'description: Keeps short notes for the user.', 'skillContent: ./SKILL.md', ''].join('\n'),
  );
  writeFileSync(path.join(capabilities, 'notes-helper', 'SKILL.md'), `# Notes helper\n\n${SKILL_TEXT}\n`);

  const escapeManifest = path.join(capabilities, 'escape', 'CAPABILITY.yaml');
  writeFileSync(
    escapeManifest,
    ['kind: skill', 'name: escape', 'description: Reads a file outside its folder.', 'skillContent: ../../../../outside/secret.md', ''].join('\n'),
  );
  return { capabilities, escapeManifest };
}

describe('capability manifests in Wunderland discovery', () => {
  let root: string;
  let server: Server;
  let previousDirs: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'wunderland-discovery-manifests-'));
    server = await startEmbeddingServer();
    previousDirs = process.env['WUNDERLAND_CAPABILITY_DIRS'];
  });

  afterEach(async () => {
    if (previousDirs === undefined) delete process.env['WUNDERLAND_CAPABILITY_DIRS'];
    else process.env['WUNDERLAND_CAPABILITY_DIRS'] = previousDirs;
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it('indexes a capability whose skill file is in its folder and refuses one whose skillContent leaves it', async () => {
    const { capabilities, escapeManifest } = writeCapabilities(root);
    // One of the manager's default manifest folders, beside ~/.wunderland/capabilities and <cwd>/.wunderland/capabilities.
    process.env['WUNDERLAND_CAPABILITY_DIRS'] = capabilities;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = server.address() as { port: number };

    const manager = new WunderlandDiscoveryManager({ registerMetaTool: false });
    try {
      await manager.initialize({
        toolMap: new Map(),
        llmConfig: { providerId: 'openai', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}/v1` },
      });

      expect(manager.engine).not.toBeNull();
      expect(manager.getStats().manifestDirs).toContain(capabilities);

      const ids = manager.engine.listCapabilityIds();
      expect(ids).toContain('skill:notes-helper');
      expect(manager.engine.getCapabilityDetail('skill:notes-helper').fullContent).toContain(SKILL_TEXT);

      expect(ids).not.toContain('skill:escape');
      for (const id of ids) {
        expect(String(manager.engine.getCapabilityDetail(id)?.fullContent ?? '')).not.toContain(OUTSIDE_TEXT);
      }

      // The scan wrote one line naming the refused manifest and why.
      const lines = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes(escapeManifest));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('refused');
    } finally {
      await manager.close();
    }
  }, 30_000);

  it('reports the refused capability through the scanner wunderland/discovery exports', async () => {
    const { capabilities, escapeManifest } = writeCapabilities(root);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { descriptors, refused } = await new CapabilityManifestScanner().scanWithRefusals([capabilities]);

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(['skill:notes-helper']);
    expect(refused).toEqual([{ manifestPath: escapeManifest, field: 'skillContent', problem: 'dot' }]);
  });
});
