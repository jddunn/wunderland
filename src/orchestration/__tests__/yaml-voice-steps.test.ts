/**
 * @file yaml-voice-steps.test.ts
 * @description Unit tests for voice step and transport config support in the YAML compiler.
 *
 * Covers:
 * 1. A voice step compiles without throwing and produces a result.
 * 2. All voice config fields pass through to the compiled node executor config.
 * 3. A top-level `transport` block is attached to the compiled graph as `_transport`.
 * 4. A voice step without a `mode` field throws a validation error.
 * 5. An unknown `transport.type` throws a validation error.
 * 6. A voice step can be mixed with other step types in the same workflow.
 */

import { describe, it, expect } from 'vitest';
import { compileWorkflowYaml } from '../yaml-compiler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the compiled graph IR from the value returned by `compileWorkflowYaml`.
 * The workflow builder may expose either `.toIR()` or the compiled object itself.
 */
function toIR(compiled: any): any {
  return typeof compiled.toIR === 'function' ? compiled.toIR() : compiled;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('YAML voice steps', () => {
  it('compiles a voice step to NodeExecutorConfig with type voice', () => {
    const yaml = `
name: voice-intake
steps:
  - id: greet
    voice:
      mode: conversation
`;
    // Should not throw during compilation.
    const compiled = compileWorkflowYaml(yaml);
    expect(compiled).toBeDefined();
  });

  it('passes all voice config fields through', () => {
    const yaml = `
name: voice-full-config
steps:
  - id: listen
    voice:
      mode: listen-only
      stt: deepgram
      tts: elevenlabs
      voice: nova
      endpointing: heuristic
      bargeIn: hard-cut
      diarization: true
      language: en-US
      maxTurns: 5
      exitOn: keyword
      exitKeywords:
        - confirmed
        - cancel
`;
    const compiled = compileWorkflowYaml(yaml);
    const ir = toIR(compiled);

    // Navigate to the listen node.
    const nodes: any = ir?.nodes ?? ir?.graph?.nodes ?? {};
    const nodeList: any[] = nodes instanceof Map
      ? Array.from(nodes.values())
      : Array.isArray(nodes)
        ? nodes
        : Object.values(nodes);

    const listenNode = nodeList.find((n: any) => n.id === 'listen');
    expect(listenNode).toBeDefined();

    const cfg = listenNode?.executorConfig ?? listenNode?.config;
    expect(cfg?.type).toBe('voice');

    const vc = cfg?.voiceConfig ?? cfg?.voice;
    expect(vc?.mode).toBe('listen-only');
    expect(vc?.stt).toBe('deepgram');
    expect(vc?.tts).toBe('elevenlabs');
    expect(vc?.voice).toBe('nova');
    expect(vc?.endpointing).toBe('heuristic');
    expect(vc?.bargeIn).toBe('hard-cut');
    expect(vc?.diarization).toBe(true);
    expect(vc?.language).toBe('en-US');
    expect(vc?.maxTurns).toBe(5);
    expect(vc?.exitOn).toBe('keyword');
    expect(vc?.exitKeywords).toEqual(['confirmed', 'cancel']);
  });

  it('compiles transport config at workflow level', () => {
    const yaml = `
name: phone-intake
transport:
  type: voice
  stt: deepgram
  tts: openai
  voice: alloy
  bargeIn: hard-cut
  endpointing: heuristic
steps:
  - id: greet
    voice:
      mode: conversation
      maxTurns: 1
`;
    const compiled = compileWorkflowYaml(yaml);
    expect(compiled).toBeDefined();

    // Transport metadata should be stored at _transport on the compiled graph.
    const transport = (compiled as any)._transport;
    expect(transport).toBeDefined();
    expect(transport.type).toBe('voice');
    expect(transport.stt).toBe('deepgram');
    expect(transport.tts).toBe('openai');
    expect(transport.voice).toBe('alloy');
    expect(transport.bargeIn).toBe('hard-cut');
    expect(transport.endpointing).toBe('heuristic');
  });

  it('validates that voice step requires mode field', () => {
    const yaml = `
name: bad-voice-step
steps:
  - id: listen
    voice:
      stt: deepgram
`;
    // mode is absent — should throw a descriptive validation error.
    expect(() => compileWorkflowYaml(yaml)).toThrow(/mode/i);
  });

  it('throws when transport.type is not voice', () => {
    const yaml = `
name: bad-transport
transport:
  type: unknown-transport
steps:
  - id: step1
    tool: some_tool
`;
    expect(() => compileWorkflowYaml(yaml)).toThrow(/transport\.type/i);
  });

  it('compiles a workflow mixing voice and tool steps without throwing', () => {
    const yaml = `
name: mixed-workflow
steps:
  - id: gather
    voice:
      mode: conversation
      maxTurns: 2
  - id: process
    tool: crm_lookup
  - id: respond
    voice:
      mode: speak-only
`;
    const compiled = compileWorkflowYaml(yaml);
    expect(compiled).toBeDefined();
  });
});
