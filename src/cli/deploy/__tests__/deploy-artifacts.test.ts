// @ts-nocheck
/**
 * @fileoverview Tests for the files `wunderland deploy` writes, as they bear on who can reach the agent.
 * @module wunderland/cli/deploy/__tests__/deploy-artifacts.test
 *
 * `wunderland start` listens on 127.0.0.1 unless --host names another
 * address. In a container that would leave the published port with nothing
 * behind it, so the generated Dockerfile names 0.0.0.0, and the files tell
 * the person deploying to set the chat secret.
 */

import { describe, expect, it } from 'vitest';

import { generateDeployArtifacts } from '../artifact-generator.js';

describe.each(['docker', 'railway', 'fly'] as const)('wunderland deploy --target %s', (target) => {
  const { files } = generateDeployArtifacts({
    agentConfig: { displayName: 'Deploy Test', seedId: 'seed_deploy_test' },
    target,
    port: 3777,
  });

  it('starts the server on every interface inside the container', () => {
    const cmd = files
      .get('Dockerfile')
      .split('\n')
      .find((line: string) => line.startsWith('CMD '));
    expect(JSON.parse(cmd.slice('CMD '.length))).toEqual([
      './node_modules/.bin/wunderland',
      'start',
      '--config',
      'agent.config.json',
      '--host',
      '0.0.0.0',
      '--port',
      '3777',
    ]);
  });

  it('has a chat secret line in .env.example and says why in the README', () => {
    expect(files.get('.env.example')).toMatch(/^WUNDERLAND_CHAT_SECRET=$/m);
    expect(files.get('README.md')).toContain('WUNDERLAND_CHAT_SECRET');
  });
});
